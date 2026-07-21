import { describe, expect, it } from 'vitest'
import type { SessionEvent, SessionEventBody } from '@claude-worker/protocol'
import { applyEvent, initialTranscriptState, type TranscriptState } from '../src/transcript.ts'

let seq = 0
const ev = (body: SessionEventBody): SessionEvent => ({ ...body, seq: ++seq, ts: 0 })

function run(state: TranscriptState, bodies: SessionEventBody[]): TranscriptState {
  return bodies.reduce((s, body) => applyEvent(s, ev(body)), state)
}

describe('transcript reducer', () => {
  it('builds a transcript from a full turn', () => {
    seq = 0
    const state = run(initialTranscriptState, [
      {
        type: 'system_init',
        sdkSessionId: 'sdk-1',
        model: 'claude-test-1',
        cwd: '/tmp/p',
        apiKeySource: 'user',
        tools: [],
        skills: [],
        slashCommands: [],
        permissionMode: 'default',
        claudeCodeVersion: '2.0.0',
        mcpServers: [],
      },
      { type: 'status_changed', status: 'running' },
      { type: 'user_message', message: { role: 'user', content: 'run ls' }, parentToolUseId: null, uuid: 'u1' },
      {
        type: 'stream_delta',
        event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Sure, ' } },
        parentToolUseId: null,
        uuid: 's1',
      },
      {
        type: 'stream_delta',
        event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'running.' } },
        parentToolUseId: null,
        uuid: 's2',
      },
      {
        type: 'assistant_message',
        message: {
          role: 'assistant',
          content: [
            { type: 'text', text: 'Sure, running.' },
            { type: 'tool_use', id: 'tool-1', name: 'Bash', input: { command: 'ls' } },
          ],
        },
        parentToolUseId: null,
        uuid: 'a1',
      },
      {
        type: 'user_message',
        message: {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 'tool-1', content: 'file.txt' }],
        },
        parentToolUseId: null,
        synthetic: true,
        uuid: 'u2',
      },
      {
        type: 'turn_result',
        subtype: 'success',
        isError: false,
        durationMs: 900,
        numTurns: 1,
        totalCostUsd: 0.02,
        result: 'done',
      },
    ])

    expect(state.model).toBe('claude-test-1')
    expect(state.status).toBe('running')
    expect(state.totalCostUsd).toBeCloseTo(0.02)
    const kinds = state.items.map((i) => i.kind)
    expect(kinds).toEqual(['user', 'assistant_text', 'tool_call', 'turn_result'])
    const tool = state.items.find((i) => i.kind === 'tool_call')
    expect(tool).toMatchObject({ name: 'Bash', result: { text: 'file.txt', isError: false } })
    // streamed text was replaced by the final message
    const texts = state.items.filter((i) => i.kind === 'assistant_text')
    expect(texts).toHaveLength(1)
    expect(texts[0]).toMatchObject({ text: 'Sure, running.', streaming: false })
  })

  it('accumulates stream deltas into one streaming item', () => {
    seq = 0
    const state = run(initialTranscriptState, [
      {
        type: 'stream_delta',
        event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'a' } },
        parentToolUseId: null,
        uuid: 's1',
      },
      {
        type: 'stream_delta',
        event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'b' } },
        parentToolUseId: null,
        uuid: 's2',
      },
    ])
    expect(state.items).toEqual([
      { kind: 'assistant_text', id: 'streaming', text: 'ab', streaming: true, parentToolUseId: null },
    ])
  })

  it('tracks pending approvals and ignores duplicate seq', () => {
    seq = 0
    const request = {
      id: 'req-1',
      toolName: 'Bash',
      input: { command: 'ls' },
      toolUseId: 'tool-1',
    }
    const first = applyEvent(initialTranscriptState, ev({ type: 'permission_requested', request }))
    expect(first.pendingApprovals).toHaveLength(1)
    // replay of the same seq is a no-op
    expect(applyEvent(first, { type: 'permission_requested', request, seq: 1, ts: 0 })).toBe(first)
    const resolved = applyEvent(
      first,
      ev({ type: 'permission_resolved', requestId: 'req-1', behavior: 'deny', resolvedBy: 'timeout' }),
    )
    expect(resolved.pendingApprovals).toHaveLength(0)
  })

  it('accumulates thinking deltas and supersedes them with the full message', () => {
    seq = 0
    const state = run(initialTranscriptState, [
      {
        type: 'stream_delta',
        event: { type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: 'Hmm, ' } },
        parentToolUseId: null,
        uuid: 's1',
      },
      {
        type: 'stream_delta',
        event: { type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: 'ok.' } },
        parentToolUseId: null,
        uuid: 's2',
      },
    ])
    expect(state.items).toEqual([
      { kind: 'thinking', id: 'streaming-thinking', text: 'Hmm, ok.', parentToolUseId: null },
    ])

    const done = applyEvent(
      state,
      ev({
        type: 'assistant_message',
        message: { role: 'assistant', content: [{ type: 'thinking', thinking: 'Hmm, ok.' }] },
        parentToolUseId: null,
        uuid: 'a1',
      }),
    )
    expect(done.items).toHaveLength(1)
    expect(done.items[0]).toMatchObject({ kind: 'thinking', id: 'a1-0', text: 'Hmm, ok.' })
  })

  it('treats turn_result cost as session-cumulative (last-seen, not summed)', () => {
    seq = 0
    const turn = (totalCostUsd: number): SessionEventBody => ({
      type: 'turn_result',
      subtype: 'success',
      isError: false,
      durationMs: 100,
      numTurns: 1,
      totalCostUsd,
      result: 'ok',
    })
    const state = run(initialTranscriptState, [turn(0.02), turn(0.05)])
    expect(state.totalCostUsd).toBeCloseTo(0.05)
  })

  it('dedupes backfilled history against SDK-replayed user messages by uuid', () => {
    seq = 0
    const state = run(initialTranscriptState, [
      // backfill copy (from getSessionMessages)
      {
        type: 'user_message',
        message: { role: 'user', content: 'earlier prompt' },
        parentToolUseId: null,
        replay: true,
        uuid: 'u-hist-1',
      },
      {
        type: 'assistant_message',
        message: { role: 'assistant', content: [{ type: 'text', text: 'earlier reply' }] },
        parentToolUseId: null,
        replay: true,
        uuid: 'a-hist-1',
      },
      // SDK's own replay of the same user message on resume
      {
        type: 'user_message',
        message: { role: 'user', content: 'earlier prompt' },
        parentToolUseId: null,
        replay: true,
        uuid: 'u-hist-1',
      },
    ])
    expect(state.items.filter((i) => i.kind === 'user')).toHaveLength(1)
    expect(state.items.map((i) => i.kind)).toEqual(['user', 'assistant_text'])
  })

  it('renders local-command output as a notice, not a user bubble', () => {
    seq = 0
    const state = run(initialTranscriptState, [
      {
        type: 'user_message',
        message: {
          role: 'user',
          content: '<local-command-stdout>Set model to sonnet</local-command-stdout>',
        },
        parentToolUseId: null,
        uuid: 'lc-1',
      },
    ])
    expect(state.items).toEqual([
      { kind: 'notice', id: 'lc-1', level: 'info', text: 'Set model to sonnet' },
    ])
  })

  it('tracks capabilities and model changes', () => {
    seq = 0
    const state = run(initialTranscriptState, [
      {
        type: 'capabilities',
        models: [{ value: 'claude-opus-4-8', displayName: 'Opus 4.8' }],
        commands: [{ name: 'compact', description: 'Compact the conversation' }],
      },
      { type: 'model_changed', model: 'claude-opus-4-8' },
    ])
    expect(state.models).toEqual([{ value: 'claude-opus-4-8', displayName: 'Opus 4.8' }])
    expect(state.commands?.map((c) => c.name)).toEqual(['compact'])
    expect(state.model).toBe('claude-opus-4-8')

    // reset-to-default keeps showing the last known model
    const after = applyEvent(state, ev({ type: 'model_changed', model: undefined }))
    expect(after.model).toBe('claude-opus-4-8')
  })
})
