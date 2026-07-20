import { useState, type FormEvent, type ReactNode } from 'react'
import type { ClaudeWorkerClient } from '@claude-worker/client'
import type { PermissionRequest } from '@claude-worker/protocol'
import { useClaudeSession, type UseClaudeSessionResult } from './use-session.ts'
import type { TranscriptItem, TranscriptState } from './transcript.ts'

/**
 * Lean V1 components. Every element carries a `cw-*` class and data attributes so hosts
 * can restyle or replace freely; import '@claude-worker/react/styles.css' for defaults.
 */

function formatJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2) ?? String(value)
  } catch {
    return String(value)
  }
}

export function ToolCallCard({ item }: { item: Extract<TranscriptItem, { kind: 'tool_call' }> }) {
  const [open, setOpen] = useState(false)
  return (
    <div className="cw-tool-call" data-tool={item.name} data-has-result={item.result ? '' : undefined}>
      <button type="button" className="cw-tool-call-header" onClick={() => setOpen(!open)}>
        <span className="cw-tool-call-name">{item.name}</span>
        <span className="cw-tool-call-state" data-error={item.result?.isError ? '' : undefined}>
          {item.result ? (item.result.isError ? 'error' : 'done') : 'running'}
        </span>
      </button>
      {open && (
        <div className="cw-tool-call-body">
          <pre className="cw-tool-call-input">{formatJson(item.input)}</pre>
          {item.result && <pre className="cw-tool-call-result">{item.result.text || '(empty)'}</pre>}
        </div>
      )}
    </div>
  )
}

export function PermissionPromptCard({
  request,
  onApprove,
  onDeny,
}: {
  request: PermissionRequest
  onApprove: (requestId: string) => void
  onDeny: (requestId: string, message?: string) => void
}) {
  return (
    <div className="cw-permission" data-tool={request.toolName}>
      <div className="cw-permission-title">
        {request.title ?? `Claude wants to use ${request.toolName}`}
      </div>
      {request.description && <div className="cw-permission-description">{request.description}</div>}
      <pre className="cw-permission-input">{formatJson(request.input)}</pre>
      <div className="cw-permission-actions">
        <button type="button" className="cw-btn cw-btn-allow" onClick={() => onApprove(request.id)}>
          Allow
        </button>
        <button
          type="button"
          className="cw-btn cw-btn-deny"
          onClick={() => onDeny(request.id, 'Denied by user')}
        >
          Deny
        </button>
      </div>
    </div>
  )
}

function TranscriptItemView({ item }: { item: TranscriptItem }) {
  switch (item.kind) {
    case 'user':
      return <div className="cw-msg cw-msg-user">{item.text}</div>
    case 'assistant_text':
      return (
        <div className="cw-msg cw-msg-assistant" data-streaming={item.streaming ? '' : undefined}>
          {item.text}
        </div>
      )
    case 'thinking':
      return <div className="cw-msg cw-msg-thinking">{item.text}</div>
    case 'tool_call':
      return <ToolCallCard item={item} />
    case 'turn_result':
      return (
        <div className="cw-turn-result" data-error={item.isError ? '' : undefined}>
          {item.isError
            ? `Turn failed (${item.subtype}): ${item.errors?.join('; ') ?? 'unknown error'}`
            : `Turn done in ${(item.durationMs / 1000).toFixed(1)}s · $${item.totalCostUsd.toFixed(4)}`}
        </div>
      )
    case 'notice':
      return (
        <div className="cw-notice" data-level={item.level}>
          {item.text}
        </div>
      )
  }
}

export function Transcript({ state }: { state: TranscriptState }) {
  return (
    <div className="cw-transcript">
      {state.items.map((item) => (
        <TranscriptItemView key={`${item.kind}:${item.id}`} item={item} />
      ))}
    </div>
  )
}

export function StatusBar({ state, connected }: { state: TranscriptState; connected: boolean }) {
  return (
    <div className="cw-statusbar" data-status={state.status} data-connected={connected ? '' : undefined}>
      <span className="cw-status">{state.status}</span>
      {state.model && <span className="cw-model">{state.model}</span>}
      {state.totalCostUsd > 0 && (
        <span className="cw-cost">${state.totalCostUsd.toFixed(4)}</span>
      )}
      {!connected && <span className="cw-disconnected">reconnecting…</span>}
    </div>
  )
}

export function Composer({
  onSend,
  onInterrupt,
  busy,
}: {
  onSend: (text: string) => void
  onInterrupt: () => void
  busy: boolean
}) {
  const [text, setText] = useState('')
  const submit = (e: FormEvent) => {
    e.preventDefault()
    const trimmed = text.trim()
    if (!trimmed) return
    onSend(trimmed)
    setText('')
  }
  return (
    <form className="cw-composer" onSubmit={submit}>
      <textarea
        className="cw-composer-input"
        value={text}
        placeholder="Message the session…"
        rows={2}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault()
            submit(e)
          }
        }}
      />
      <div className="cw-composer-actions">
        {busy && (
          <button type="button" className="cw-btn cw-btn-interrupt" onClick={onInterrupt}>
            Interrupt
          </button>
        )}
        <button type="submit" className="cw-btn cw-btn-send" disabled={!text.trim()}>
          Send
        </button>
      </div>
    </form>
  )
}

export function SessionPanel({
  client,
  sessionId,
  header,
}: {
  client: ClaudeWorkerClient
  sessionId: string | undefined
  /** Optional host-supplied header content (title, close button, ...). */
  header?: ReactNode
}) {
  const session: UseClaudeSessionResult = useClaudeSession(client, sessionId)
  const { state, connected } = session
  const busy = state.status === 'running' || state.status === 'awaiting_approval'
  return (
    <div className="cw-panel">
      {header}
      <StatusBar state={state} connected={connected} />
      <Transcript state={state} />
      {state.pendingApprovals.map((request) => (
        <PermissionPromptCard
          key={request.id}
          request={request}
          onApprove={session.approve}
          onDeny={session.deny}
        />
      ))}
      <Composer onSend={session.send} onInterrupt={session.interrupt} busy={busy} />
    </div>
  )
}
