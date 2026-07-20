import { describe, expect, it, vi } from 'vitest'
import type {
  Options,
  Query,
  SDKMessage,
  SDKUserMessage,
} from '@anthropic-ai/claude-agent-sdk'
import type { SessionEvent } from '@claude-worker/protocol'
import { SessionRunner, type SessionRunnerConfig } from '../src/index.ts'

/** Controllable stand-in for the SDK: emit SDKMessages, capture options + streamed input. */
function fakeHarness() {
  const messages: SDKMessage[] = []
  let waiter: ((r: IteratorResult<SDKMessage>) => void) | null = null
  let done = false
  const captured: { options?: Options; inputs: SDKUserMessage[] } = { inputs: [] }
  const interrupt = vi.fn(async () => {})
  const setPermissionMode = vi.fn(async () => {})

  const emit = (msg: SDKMessage) => {
    if (waiter) {
      const resolve = waiter
      waiter = null
      resolve({ value: msg, done: false })
    } else {
      messages.push(msg)
    }
  }
  const end = () => {
    done = true
    if (waiter) {
      const resolve = waiter
      waiter = null
      resolve({ value: undefined, done: true })
    }
  }

  const query = {
    [Symbol.asyncIterator]() {
      return this
    },
    next(): Promise<IteratorResult<SDKMessage>> {
      const buffered = messages.shift()
      if (buffered !== undefined) return Promise.resolve({ value: buffered, done: false })
      if (done) return Promise.resolve({ value: undefined, done: true })
      return new Promise((resolve) => {
        waiter = resolve
      })
    },
    interrupt,
    setPermissionMode,
    close: end,
  } as unknown as Query

  const queryFn = (params: { prompt: string | AsyncIterable<SDKUserMessage>; options?: Options }) => {
    captured.options = params.options
    void (async () => {
      for await (const input of params.prompt as AsyncIterable<SDKUserMessage>) {
        captured.inputs.push(input)
      }
    })()
    return query
  }

  return { emit, end, captured, interrupt, setPermissionMode, queryFn }
}

const initMessage = {
  type: 'system',
  subtype: 'init',
  session_id: 'sdk-session-1',
  model: 'claude-test-1',
  cwd: '/tmp/project',
  tools: ['Bash', 'Read'],
  skills: ['verify-content'],
  slash_commands: ['/verify-content'],
  permissionMode: 'default',
  claude_code_version: '2.0.0',
  mcp_servers: [],
  apiKeySource: 'user',
  output_style: 'default',
  plugins: [],
  uuid: 'uuid-init',
} as unknown as SDKMessage

const assistantMessage = {
  type: 'assistant',
  message: {
    role: 'assistant',
    content: [{ type: 'text', text: 'hello from claude' }],
    model: 'claude-test-1',
    stop_reason: 'end_turn',
  },
  parent_tool_use_id: null,
  uuid: 'uuid-a1',
  session_id: 'sdk-session-1',
} as unknown as SDKMessage

const resultMessage = {
  type: 'result',
  subtype: 'success',
  duration_ms: 1200,
  duration_api_ms: 900,
  is_error: false,
  num_turns: 1,
  result: 'done',
  stop_reason: 'end_turn',
  total_cost_usd: 0.01,
  usage: {},
  modelUsage: {},
  permission_denials: [],
  uuid: 'uuid-r1',
  session_id: 'sdk-session-1',
} as unknown as SDKMessage

function makeRunner(overrides: Partial<SessionRunnerConfig> = {}) {
  const harness = fakeHarness()
  const runner = new SessionRunner({
    cwd: '/tmp/project',
    queryFn: harness.queryFn,
    ...overrides,
  })
  const events: SessionEvent[] = []
  runner.subscribe((e) => events.push(e))
  return { harness, runner, events }
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0))

describe('SessionRunner', () => {
  it('emits system_init, transcript events, and status transitions', async () => {
    const { harness, runner, events } = makeRunner()
    void runner.start()
    harness.emit(initMessage)
    harness.emit(assistantMessage)
    harness.emit(resultMessage)
    await tick()

    const types = events.map((e) => e.type)
    expect(types).toEqual([
      'system_init',
      'status_changed', // running
      'assistant_message',
      'turn_result',
      'status_changed', // idle
    ])
    expect(runner.status).toBe('idle')
    expect(runner.sdkSessionId).toBe('sdk-session-1')
    expect(runner.info().model).toBe('claude-test-1')
    expect(runner.apiKeySource).toBe('user')
    expect(events.every((e, i) => e.seq === i + 1)).toBe(true)
  })

  it('emits user_message events for sent input (the SDK does not echo them)', async () => {
    const { runner, events } = makeRunner({ prompt: 'first' })
    void runner.start()
    runner.sendMessage('second')
    await tick()

    const userEvents = events.filter(
      (e): e is Extract<SessionEvent, { type: 'user_message' }> => e.type === 'user_message',
    )
    expect(userEvents.map((e) => e.message.content)).toEqual(['first', 'second'])
    expect(userEvents.every((e) => typeof e.uuid === 'string' && e.uuid.length > 0)).toBe(true)
    expect(userEvents.every((e) => !e.synthetic && !e.replay)).toBe(true)
  })

  it('sends the initial prompt and queued user messages into the SDK input stream', async () => {
    const { harness, runner } = makeRunner({ prompt: '/verify-content 42' })
    void runner.start()
    runner.sendMessage('follow-up')
    await tick()

    expect(harness.captured.inputs.map((m) => m.message.content)).toEqual([
      '/verify-content 42',
      'follow-up',
    ])
  })

  it('promotes canUseTool into a pending approval and resolves an allow decision', async () => {
    const { harness, runner, events } = makeRunner()
    void runner.start()
    harness.emit(initMessage)
    await tick()

    const resultPromise = harness.captured.options!.canUseTool!(
      'Bash',
      { command: 'ls' },
      { signal: new AbortController().signal, toolUseID: 'tool-1', title: 'Run ls' },
    )
    expect(runner.status).toBe('awaiting_approval')
    const request = runner.pendingApprovals[0]!
    expect(request.toolName).toBe('Bash')
    expect(request.title).toBe('Run ls')

    const ok = runner.resolvePermission(request.id, {
      behavior: 'allow',
      updatedInput: { command: 'ls -la' },
    })
    expect(ok).toBe(true)
    await expect(resultPromise).resolves.toEqual({
      behavior: 'allow',
      updatedInput: { command: 'ls -la' },
      toolUseID: 'tool-1',
    })
    expect(runner.status).toBe('running')

    const resolved = events.find((e) => e.type === 'permission_resolved')
    expect(resolved).toMatchObject({ requestId: request.id, behavior: 'allow', resolvedBy: 'client' })
  })

  it('allow without updatedInput echoes the original input (SDK requires a record)', async () => {
    const { harness, runner } = makeRunner()
    void runner.start()
    harness.emit(initMessage)
    await tick()

    const resultPromise = harness.captured.options!.canUseTool!(
      'Write',
      { file_path: '/tmp/x.txt', content: 'hi' },
      { signal: new AbortController().signal, toolUseID: 'tool-2' },
    )
    await tick()
    runner.resolvePermission(runner.pendingApprovals[0]!.id, { behavior: 'allow' })
    await expect(resultPromise).resolves.toEqual({
      behavior: 'allow',
      updatedInput: { file_path: '/tmp/x.txt', content: 'hi' },
      toolUseID: 'tool-2',
    })
  })

  it('denies on timeout by default', async () => {
    const { harness, runner, events } = makeRunner({ approvalTimeoutMs: 20 })
    void runner.start()
    harness.emit(initMessage)
    await tick()

    const resultPromise = harness.captured.options!.canUseTool!(
      'Write',
      { file_path: '/tmp/x' },
      { signal: new AbortController().signal, toolUseID: 'tool-2' },
    )
    const result = await resultPromise
    expect(result.behavior).toBe('deny')
    const resolved = events.find((e) => e.type === 'permission_resolved')
    expect(resolved).toMatchObject({ behavior: 'deny', resolvedBy: 'timeout' })
    expect(runner.resolvePermission('unknown', { behavior: 'allow' })).toBe(false)
  })

  it('replays events from a given seq on subscribe', async () => {
    const { harness, runner } = makeRunner()
    void runner.start()
    harness.emit(initMessage)
    harness.emit(assistantMessage)
    await tick()

    const replayed: SessionEvent[] = []
    runner.subscribe((e) => replayed.push(e), 2)
    expect(replayed.map((e) => e.seq)).toEqual([3])

    harness.emit(resultMessage)
    await tick()
    expect(replayed.map((e) => e.type)).toEqual(['assistant_message', 'turn_result', 'status_changed'])
  })

  it('close() denies pending approvals, closes the query, and goes terminal', async () => {
    const { harness, runner, events } = makeRunner()
    void runner.start()
    harness.emit(initMessage)
    await tick()

    const resultPromise = harness.captured.options!.canUseTool!(
      'Bash',
      { command: 'rm -rf /' },
      { signal: new AbortController().signal, toolUseID: 'tool-3' },
    )
    runner.close()
    const result = await resultPromise
    expect(result.behavior).toBe('deny')
    expect(runner.status).toBe('closed')
    expect(events.at(-1)!.type).toBe('status_changed')
    expect(events.some((e) => e.type === 'session_closed')).toBe(true)
    expect(() => runner.sendMessage('nope')).toThrow()
  })

  it('surfaces query failures as session_error + failed status', async () => {
    const runner = new SessionRunner({
      cwd: '/tmp/project',
      queryFn: () => {
        throw new Error('spawn failed')
      },
    })
    const events: SessionEvent[] = []
    runner.subscribe((e) => events.push(e))
    await runner.start()
    expect(events.some((e) => e.type === 'session_error')).toBe(true)
    expect(runner.status).toBe('failed')
  })

  it('tracks cost/turn rollups and title on info()', async () => {
    const { harness, runner } = makeRunner({ prompt: 'do the thing' })
    void runner.start()
    harness.emit(initMessage)
    harness.emit(resultMessage)
    await tick()

    const info = runner.info()
    expect(info.title).toBe('do the thing')
    expect(info.totalCostUsd).toBe(0.01)
    expect(info.numTurns).toBe(1)
    expect(info.lastActivityAt).toBeGreaterThan(0)

    // meta.title beats the derived prompt title.
    const { runner: named } = makeRunner({ prompt: 'p', meta: { title: 'My session' } })
    expect(named.info().title).toBe('My session')
  })

  it('backfills resumed-session history as replay events before live events', async () => {
    const history = [
      {
        type: 'user' as const,
        uuid: 'uuid-h1',
        session_id: 'sdk-session-1',
        message: { role: 'user', content: 'earlier prompt' },
        parent_tool_use_id: null,
      },
      {
        type: 'assistant' as const,
        uuid: 'uuid-h2',
        session_id: 'sdk-session-1',
        message: { role: 'assistant', content: [{ type: 'text', text: 'earlier reply' }] },
        parent_tool_use_id: null,
      },
      {
        type: 'system' as const,
        uuid: 'uuid-h3',
        session_id: 'sdk-session-1',
        message: {},
        parent_tool_use_id: null,
      },
    ]
    const historyFn = vi.fn(async () => history)
    const { harness, runner, events } = makeRunner({ resume: 'sdk-session-1', historyFn })
    void runner.start()
    await tick()
    harness.emit(initMessage)
    await tick()

    expect(historyFn).toHaveBeenCalledWith('sdk-session-1', { dir: '/tmp/project' })
    const types = events.map((e) => e.type)
    expect(types.slice(0, 2)).toEqual(['user_message', 'assistant_message'])
    expect(types).toContain('system_init')
    const replayUser = events[0] as Extract<SessionEvent, { type: 'user_message' }>
    expect(replayUser.replay).toBe(true)
    expect(replayUser.uuid).toBe('uuid-h1')
    const replayAssistant = events[1] as Extract<SessionEvent, { type: 'assistant_message' }>
    expect(replayAssistant.replay).toBe(true)
    // system entries are skipped
    expect(events).toHaveLength(events.filter((e) => e.type !== 'sdk_event').length)
  })

  it('resume without history and historyFn failures are non-fatal', async () => {
    const historyFn = vi.fn(async () => {
      throw new Error('no transcript')
    })
    const { harness, runner, events } = makeRunner({ resume: 'sdk-session-x', historyFn })
    void runner.start()
    await tick()
    harness.emit(initMessage)
    await tick()
    expect(events.map((e) => e.type)).toContain('system_init')
    expect(runner.status).toBe('running')
  })
})
