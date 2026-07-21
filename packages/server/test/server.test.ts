import { createServer, type Server } from 'node:http'
import { afterEach, describe, expect, it, vi } from 'vitest'
import WebSocket from 'ws'
import type { Options, Query, SDKMessage, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'
import type { JobEvent, JobInfo, QueueStats, ServerFrame, SessionInfo } from '@claude-worker/protocol'
import { createWorkerServer, type WorkerServer } from '../src/index.ts'

function fakeHarness() {
  const messages: SDKMessage[] = []
  let waiter: ((r: IteratorResult<SDKMessage>) => void) | null = null
  let done = false
  const captured: { options?: Options; inputs: SDKUserMessage[] } = { inputs: [] }
  const interrupt = vi.fn(async () => {})
  const setModel = vi.fn(async () => {})

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
    setModel,
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
  return { emit, end, captured, interrupt, setModel, queryFn }
}

const initMessage = {
  type: 'system',
  subtype: 'init',
  session_id: 'sdk-1',
  model: 'claude-test-1',
  cwd: '/tmp/project',
  tools: ['Bash'],
  skills: [],
  slash_commands: [],
  permissionMode: 'default',
  claude_code_version: '2.0.0',
  mcp_servers: [],
  apiKeySource: 'user',
  output_style: 'default',
  plugins: [],
  uuid: 'uuid-init',
} as unknown as SDKMessage

/** Collects server frames and lets tests await one matching a predicate. */
function frameCollector(ws: WebSocket) {
  const frames: ServerFrame[] = []
  const waiters: Array<{ match: (f: ServerFrame) => boolean; resolve: (f: ServerFrame) => void }> = []
  ws.on('message', (data) => {
    const frame = JSON.parse(String(data)) as ServerFrame
    frames.push(frame)
    for (let i = waiters.length - 1; i >= 0; i--) {
      if (waiters[i]!.match(frame)) {
        waiters[i]!.resolve(frame)
        waiters.splice(i, 1)
      }
    }
  })
  const waitFor = (match: (f: ServerFrame) => boolean, timeoutMs = 2000): Promise<ServerFrame> => {
    const existing = frames.find(match)
    if (existing) return Promise.resolve(existing)
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('timed out waiting for frame')), timeoutMs)
      waiters.push({
        match,
        resolve: (f) => {
          clearTimeout(timer)
          resolve(f)
        },
      })
    })
  }
  return { frames, waitFor }
}

let running: WorkerServer | undefined
afterEach(async () => {
  await running?.close()
  running = undefined
})

async function startServer(harness: ReturnType<typeof fakeHarness>) {
  running = createWorkerServer({
    allowUnauthenticated: true,
    allowedCwdRoots: ['/tmp'],
    buildRunnerConfig: (req) => ({ ...req, queryFn: harness.queryFn }),
  })
  const { port } = await running.listen(0, '127.0.0.1')
  return { base: `http://127.0.0.1:${port}/v1`, wsBase: `ws://127.0.0.1:${port}/v1` }
}

describe('createWorkerServer', () => {
  it('requires an auth decision at construction', () => {
    expect(() => createWorkerServer()).toThrow(/authenticate/)
  })

  it('runs the full session lifecycle over REST + WS', async () => {
    const harness = fakeHarness()
    const { base, wsBase } = await startServer(harness)

    // create
    const createRes = await fetch(`${base}/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ cwd: '/tmp/project', prompt: 'hello' }),
    })
    expect(createRes.status).toBe(201)
    const { session } = (await createRes.json()) as { session: SessionInfo }
    expect(session.status).toBe('starting')

    // list
    const listRes = await fetch(`${base}/sessions`)
    const listBody = (await listRes.json()) as { sessions: SessionInfo[] }
    expect(listBody.sessions.map((s) => s.id)).toContain(session.id)

    // attach
    const ws = new WebSocket(`${wsBase}/sessions/${session.id}/ws`)
    const collector = frameCollector(ws)
    await collector.waitFor((f) => f.type === 'attached')

    harness.emit(initMessage)
    await collector.waitFor((f) => f.type === 'event' && f.event.type === 'system_init')

    // command: user_message reaches the SDK input stream
    ws.send(JSON.stringify({ type: 'user_message', text: 'follow-up' }))
    await vi.waitFor(() => {
      expect(harness.captured.inputs.map((m) => m.message.content)).toContain('follow-up')
    })

    // command: set_model reaches the query and round-trips a model_changed event
    ws.send(JSON.stringify({ type: 'set_model', model: 'claude-opus-4-8' }))
    await collector.waitFor(
      (f) => f.type === 'event' && f.event.type === 'model_changed' && f.event.model === 'claude-opus-4-8',
    )
    expect(harness.setModel).toHaveBeenCalledWith('claude-opus-4-8')

    // permission round-trip
    const resultPromise = harness.captured.options!.canUseTool!(
      'Bash',
      { command: 'ls' },
      { signal: new AbortController().signal, toolUseID: 'tool-1' },
    )
    const requested = await collector.waitFor(
      (f) => f.type === 'event' && f.event.type === 'permission_requested',
    )
    const requestId =
      requested.type === 'event' && requested.event.type === 'permission_requested'
        ? requested.event.request.id
        : ''
    ws.send(JSON.stringify({ type: 'permission_decision', requestId, behavior: 'allow' }))
    await expect(resultPromise).resolves.toMatchObject({ behavior: 'allow' })
    await collector.waitFor((f) => f.type === 'event' && f.event.type === 'permission_resolved')

    // reconnect with afterSeq replays only the tail
    const lastSeqRes = await fetch(`${base}/sessions/${session.id}`)
    const { session: current } = (await lastSeqRes.json()) as { session: SessionInfo }
    ws.close()
    const ws2 = new WebSocket(
      `${wsBase}/sessions/${session.id}/ws?afterSeq=${current.lastSeq - 1}`,
    )
    const collector2 = frameCollector(ws2)
    await collector2.waitFor((f) => f.type === 'attached')
    const replayed = await collector2.waitFor((f) => f.type === 'event')
    expect(replayed.type === 'event' && replayed.event.seq).toBe(current.lastSeq)
    ws2.close()

    // delete closes the session
    const delRes = await fetch(`${base}/sessions/${session.id}`, { method: 'DELETE' })
    expect(delRes.status).toBe(200)
    const gone = await fetch(`${base}/sessions/${session.id}`)
    expect(gone.status).toBe(404)
  })

  it('fails closed on subscription credentials when requireApiKey is set', async () => {
    const harness = fakeHarness()
    running = createWorkerServer({
      allowUnauthenticated: true,
      requireApiKey: true,
      buildRunnerConfig: (req) => ({ ...req, queryFn: harness.queryFn }),
    })
    const { port } = await running.listen(0, '127.0.0.1')
    const base = `http://127.0.0.1:${port}/v1`

    const createRes = await fetch(`${base}/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ cwd: '/tmp/project' }),
    })
    const { session } = (await createRes.json()) as { session: SessionInfo }

    harness.emit({ ...(initMessage as object), apiKeySource: 'oauth' } as typeof initMessage)
    await vi.waitFor(async () => {
      const res = await fetch(`${base}/sessions/${session.id}`)
      const body = (await res.json()) as { session: SessionInfo }
      expect(body.session.status).toBe('failed')
    })
  })

  it('enforces cwd roots and auth', async () => {
    const harness = fakeHarness()
    const { base } = await startServer(harness)
    const outside = await fetch(`${base}/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ cwd: '/etc' }),
    })
    expect(outside.status).toBe(403)
    await running!.close()

    running = createWorkerServer({
      authenticate: (req) => (req.headers.authorization === 'Bearer secret' ? { ok: true } : null),
    })
    const { port } = await running.listen(0, '127.0.0.1')
    const authBase = `http://127.0.0.1:${port}/v1`
    expect((await fetch(`${authBase}/sessions`)).status).toBe(401)
    expect(
      (
        await fetch(`${authBase}/sessions`, {
          headers: { authorization: 'Bearer secret' },
        })
      ).status,
    ).toBe(200)
  })

  it('returns 404 for job routes when the queue is not configured', async () => {
    const harness = fakeHarness()
    const { base } = await startServer(harness)
    expect((await fetch(`${base}/jobs`)).status).toBe(404)
    expect((await fetch(`${base}/queue`)).status).toBe(404)
  })

  it('runs a job end-to-end: schedule, watch, webhook deliveries, completion', async () => {
    const harness = fakeHarness()
    const deliveries: JobEvent[] = []
    const receiver: Server = createServer((req, res) => {
      const chunks: Buffer[] = []
      req.on('data', (c: Buffer) => chunks.push(c))
      req.on('end', () => {
        deliveries.push(JSON.parse(Buffer.concat(chunks).toString('utf8')) as JobEvent)
        res.writeHead(200).end()
      })
    })
    const receiverPort = await new Promise<number>((resolve) => {
      receiver.listen(0, '127.0.0.1', () => {
        const address = receiver.address()
        resolve(typeof address === 'object' && address ? address.port : 0)
      })
    })

    try {
      running = createWorkerServer({
        allowUnauthenticated: true,
        allowedCwdRoots: ['/tmp'],
        buildRunnerConfig: (req) => ({ ...req, queryFn: harness.queryFn }),
        queue: { maxConcurrency: 1, dailyTokenLimit: 10_000 },
      })
      const { port } = await running.listen(0, '127.0.0.1')
      const base = `http://127.0.0.1:${port}/v1`

      // cwd policy applies to jobs too
      const outside = await fetch(`${base}/jobs`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ session: { cwd: '/etc', prompt: 'x' } }),
      })
      expect(outside.status).toBe(403)

      const createRes = await fetch(`${base}/jobs`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          session: { cwd: '/tmp/project', prompt: 'summarize the repo' },
          webhook: { url: `http://127.0.0.1:${receiverPort}/hook` },
          meta: { source: 'test' },
        }),
      })
      expect(createRes.status).toBe(201)
      const { job } = (await createRes.json()) as { job: JobInfo }
      expect(job.status).toBe('queued')

      // the job runs as a real registry session
      await vi.waitFor(async () => {
        const res = await fetch(`${base}/jobs/${job.id}`)
        const body = (await res.json()) as { job: JobInfo }
        expect(body.job.status).toBe('running')
        expect(body.job.sessionId).toBeDefined()
      })
      const runningJob = ((await (await fetch(`${base}/jobs/${job.id}`)).json()) as { job: JobInfo }).job
      expect((await fetch(`${base}/sessions/${runningJob.sessionId}`)).status).toBe(200)
      expect(harness.captured.inputs.map((m) => m.message.content)).toContain('summarize the repo')

      harness.emit(initMessage)
      harness.emit({
        type: 'result',
        subtype: 'success',
        duration_ms: 500,
        duration_api_ms: 400,
        is_error: false,
        num_turns: 1,
        result: 'repo summarized',
        stop_reason: 'end_turn',
        total_cost_usd: 0.03,
        usage: { input_tokens: 100, output_tokens: 50 },
        modelUsage: {},
        permission_denials: [],
        uuid: 'uuid-r1',
        session_id: 'sdk-1',
      } as unknown as SDKMessage)

      await vi.waitFor(async () => {
        const res = await fetch(`${base}/jobs/${job.id}`)
        const body = (await res.json()) as { job: JobInfo }
        expect(body.job.status).toBe('succeeded')
      })
      const done = ((await (await fetch(`${base}/jobs/${job.id}`)).json()) as { job: JobInfo }).job
      expect(done).toMatchObject({
        result: { subtype: 'success', result: 'repo summarized' },
        usage: { tokens: 150, totalCostUsd: 0.03, numTurns: 1 },
        sdkSessionId: 'sdk-1',
        meta: { source: 'test' },
      })

      await vi.waitFor(() => {
        expect(deliveries.map((e) => e.type)).toEqual(['job_started', 'job_completed'])
      })
      expect(deliveries[1]!.job.status).toBe('succeeded')

      // stats reflect the accounted run
      const stats = ((await (await fetch(`${base}/queue`)).json()) as { stats: QueueStats }).stats
      expect(stats).toMatchObject({
        maxConcurrency: 1,
        running: 0,
        queued: 0,
        dailyTokensUsed: 150,
        dailyTokenLimit: 10_000,
        paused: false,
      })

      // list + cancel of a fresh queued job
      const listBody = (await (await fetch(`${base}/jobs`)).json()) as { jobs: JobInfo[] }
      expect(listBody.jobs.map((j) => j.id)).toContain(job.id)
      expect((await fetch(`${base}/jobs/unknown`, { method: 'DELETE' })).status).toBe(404)
    } finally {
      await new Promise((resolve) => receiver.close(resolve))
    }
  })

  it('lists SDK on-disk sessions via GET /sdk-sessions', async () => {
    const lister = vi.fn(async () => [
      {
        sessionId: 'sdk-1',
        summary: 'earlier session',
        lastModified: 1000,
        cwd: '/tmp/project',
      },
    ])
    running = createWorkerServer({
      allowUnauthenticated: true,
      allowedCwdRoots: ['/tmp'],
      listSdkSessions: lister,
    })
    const { port } = await running.listen(0, '127.0.0.1')
    const base = `http://127.0.0.1:${port}/v1`

    // dir required when roots are configured; must be inside them
    expect((await fetch(`${base}/sdk-sessions`)).status).toBe(400)
    expect((await fetch(`${base}/sdk-sessions?dir=/etc`)).status).toBe(403)

    const res = await fetch(`${base}/sdk-sessions?dir=/tmp/project&limit=10`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { sdkSessions: Array<{ sessionId: string }> }
    expect(body.sdkSessions.map((s) => s.sessionId)).toEqual(['sdk-1'])
    expect(lister).toHaveBeenCalledWith({ dir: '/tmp/project', limit: 10, offset: undefined })

    expect((await fetch(`${base}/sdk-sessions`, { method: 'POST' })).status).toBe(405)
  })
})
