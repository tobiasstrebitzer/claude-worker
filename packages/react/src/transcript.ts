import type {
  ContentBlock,
  PermissionRequest,
  SessionEvent,
  SessionStatus,
  ToolResultBlock,
} from '@claude-worker/protocol'

/**
 * Pure transcript state machine over the wire-protocol event stream. Framework-free
 * so it can be unit-tested and reused outside React.
 */

export type TranscriptItem =
  | { kind: 'user'; id: string; text: string }
  | {
      kind: 'assistant_text'
      id: string
      text: string
      streaming: boolean
      parentToolUseId: string | null
    }
  | { kind: 'thinking'; id: string; text: string; parentToolUseId: string | null }
  | {
      kind: 'tool_call'
      id: string
      name: string
      input: unknown
      parentToolUseId: string | null
      result?: { text: string; isError: boolean }
    }
  | {
      kind: 'turn_result'
      id: string
      subtype: string
      isError: boolean
      durationMs: number
      totalCostUsd: number
      errors?: string[]
    }
  | { kind: 'notice'; id: string; level: 'info' | 'error'; text: string }

export type TranscriptState = {
  status: SessionStatus
  statusDetail?: string
  model?: string
  cwd?: string
  sdkSessionId?: string
  items: TranscriptItem[]
  pendingApprovals: PermissionRequest[]
  totalCostUsd: number
  lastSeq: number
}

export const initialTranscriptState: TranscriptState = {
  status: 'starting',
  items: [],
  pendingApprovals: [],
  totalCostUsd: 0,
  lastSeq: 0,
}

const STREAMING_ID = 'streaming'

function blockText(content: ToolResultBlock['content']): string {
  if (content === undefined) return ''
  if (typeof content === 'string') return content
  return content
    .map((part) => (typeof part.text === 'string' ? part.text : ''))
    .filter(Boolean)
    .join('\n')
}

function contentToBlocks(content: string | ContentBlock[]): ContentBlock[] {
  return typeof content === 'string' ? [{ type: 'text', text: content }] : content
}

function upsert(items: TranscriptItem[], item: TranscriptItem): TranscriptItem[] {
  const index = items.findIndex((existing) => existing.id === item.id && existing.kind === item.kind)
  if (index === -1) return [...items, item]
  const next = [...items]
  next[index] = item
  return next
}

export function applyEvent(state: TranscriptState, event: SessionEvent): TranscriptState {
  if (event.seq <= state.lastSeq) return state
  const base: TranscriptState = { ...state, lastSeq: event.seq }

  switch (event.type) {
    case 'system_init':
      return {
        ...base,
        model: event.model,
        cwd: event.cwd,
        sdkSessionId: event.sdkSessionId,
      }

    case 'status_changed':
      return { ...base, status: event.status, statusDetail: event.detail }

    case 'user_message': {
      let items = base.items
      for (const block of contentToBlocks(event.message.content)) {
        if (block.type === 'tool_result') {
          const toolResult = block as ToolResultBlock
          items = items.map((item) =>
            item.kind === 'tool_call' && item.id === toolResult.tool_use_id
              ? {
                  ...item,
                  result: {
                    text: blockText(toolResult.content),
                    isError: toolResult.is_error === true,
                  },
                }
              : item,
          )
        } else if (block.type === 'text' && !event.synthetic) {
          items = upsert(items, {
            kind: 'user',
            id: event.uuid ?? `user-${event.seq}`,
            text: (block as { text: string }).text,
          })
        }
      }
      return { ...base, items }
    }

    case 'assistant_message': {
      // The full message supersedes any in-flight streamed text.
      let items = base.items.filter(
        (item) => !(item.kind === 'assistant_text' && item.id === STREAMING_ID),
      )
      const blocks = contentToBlocks(event.message.content)
      blocks.forEach((block, index) => {
        const id = `${event.uuid}-${index}`
        if (block.type === 'text') {
          items = upsert(items, {
            kind: 'assistant_text',
            id,
            text: (block as { text: string }).text,
            streaming: false,
            parentToolUseId: event.parentToolUseId,
          })
        } else if (block.type === 'thinking') {
          items = upsert(items, {
            kind: 'thinking',
            id,
            text: (block as { thinking: string }).thinking,
            parentToolUseId: event.parentToolUseId,
          })
        } else if (block.type === 'tool_use') {
          const toolUse = block as { id: string; name: string; input: unknown }
          items = upsert(items, {
            kind: 'tool_call',
            id: toolUse.id,
            name: toolUse.name,
            input: toolUse.input,
            parentToolUseId: event.parentToolUseId,
          })
        }
      })
      return { ...base, items }
    }

    case 'stream_delta': {
      const delta = event.event as {
        type: string
        delta?: { type?: string; text?: string }
      }
      if (delta.type !== 'content_block_delta' || delta.delta?.type !== 'text_delta') return base
      const existing = base.items.find(
        (item): item is Extract<TranscriptItem, { kind: 'assistant_text' }> =>
          item.kind === 'assistant_text' && item.id === STREAMING_ID,
      )
      const item: TranscriptItem = {
        kind: 'assistant_text',
        id: STREAMING_ID,
        text: (existing?.text ?? '') + (delta.delta.text ?? ''),
        streaming: true,
        parentToolUseId: event.parentToolUseId,
      }
      return { ...base, items: upsert(base.items, item) }
    }

    case 'turn_result':
      return {
        ...base,
        totalCostUsd: base.totalCostUsd + event.totalCostUsd,
        items: [
          ...base.items,
          {
            kind: 'turn_result',
            id: `turn-${event.seq}`,
            subtype: event.subtype,
            isError: event.isError,
            durationMs: event.durationMs,
            totalCostUsd: event.totalCostUsd,
            errors: event.errors,
          },
        ],
      }

    case 'permission_requested':
      return { ...base, pendingApprovals: [...base.pendingApprovals, event.request] }

    case 'permission_resolved':
      return {
        ...base,
        pendingApprovals: base.pendingApprovals.filter((r) => r.id !== event.requestId),
      }

    case 'session_error':
      return {
        ...base,
        items: [
          ...base.items,
          { kind: 'notice', id: `err-${event.seq}`, level: 'error', text: event.message },
        ],
      }

    case 'session_closed':
      return {
        ...base,
        items: [
          ...base.items,
          {
            kind: 'notice',
            id: `closed-${event.seq}`,
            level: 'info',
            text: `Session closed (${event.reason})`,
          },
        ],
      }

    case 'sdk_event':
    default:
      return base
  }
}
