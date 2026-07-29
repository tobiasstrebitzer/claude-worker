import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import WebSocket from 'ws'
import { createVfs } from '@claude-worker/sandbox'
import type { Runner, SessionRunnerConfig, ToolExecutionResult } from '@claude-worker/core'
import type { ProfileInfo, SessionInfo } from '@claude-worker/protocol'
import { createWorkerServer, type EngineRunnerContext, type WorkerServer } from '../src/index.ts'

/** Minimal Runner implementation — engine selection is what's under test, not the engine. */
function fakeRunner(id: string, config: SessionRunnerConfig): Runner {
  return {
    id,
    pendingApprovals: [],
    start: async () => {},
    info: (): SessionInfo => ({
      id,
      status: 'idle',
      cwd: config.cwd,
      profile: config.profile,
      model: config.model,
      createdAt: Date.now(),
      lastSeq: 0,
      pendingPermissionCount: 0,
    }),
    subscribe: () => () => {},
    sendMessage: () => {},
    resolvePermission: () => false,
    interrupt: async () => {},
    setPermissionMode: async () => {},
    setModel: async () => {},
    fail: () => {},
    close: () => {},
  }
}

let running: WorkerServer | undefined
let configDir: string | undefined
afterEach(async () => {
  await running?.close()
  running = undefined
  if (configDir) rmSync(configDir, { recursive: true, force: true })
  configDir = undefined
})

const claudeProfile = (): ProfileInfo => {
  configDir = mkdtempSync(join(tmpdir(), 'cw-profile-'))
  return { name: 'claude', configDir }
}

const providerProfile = (): ProfileInfo => ({
  name: 'kimi',
  engine: 'provider',
  provider: { id: 'moonshotai', model: 'kimi-k3', apiKeyEnv: 'MOONSHOT_API_KEY' },
  defaults: { model: 'kimi-k3' },
})

describe('provider profiles and engine selection', () => {
  it('refuses to start when a provider profile has no engine factory', () => {
    expect(() =>
      createWorkerServer({ allowUnauthenticated: true, profiles: [providerProfile()] }),
    ).toThrow(/no `createEngineRunner`/)
  })

  it('refuses a provider profile without a provider id', () => {
    expect(() =>
      createWorkerServer({
        allowUnauthenticated: true,
        profiles: [{ name: 'broken', engine: 'provider' }],
        createEngineRunner: ({ config }) => fakeRunner('x', config),
      }),
    ).toThrow(/missing provider\.id/)
  })

  it('still requires a real config dir for claude profiles', () => {
    expect(() =>
      createWorkerServer({
        allowUnauthenticated: true,
        profiles: [{ name: 'nope', configDir: '/definitely/not/here' }],
      }),
    ).toThrow(/configDir does not exist/)
  })

  it('builds the engine runner for a provider profile and skips CLAUDE_CONFIG_DIR', async () => {
    const createEngineRunner = vi.fn((ctx: EngineRunnerContext) => fakeRunner('engine-1', ctx.config))
    running = createWorkerServer({
      allowUnauthenticated: true,
      allowedCwdRoots: ['/tmp'],
      profiles: [claudeProfile(), providerProfile()],
      createEngineRunner,
    })
    const { port } = await running.listen(0, '127.0.0.1')
    const res = await fetch(`http://127.0.0.1:${port}/v1/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ cwd: '/tmp/project', profile: 'kimi' }),
    })
    expect(res.status).toBe(201)

    expect(createEngineRunner).toHaveBeenCalledOnce()
    const ctx = createEngineRunner.mock.calls[0]![0]
    expect(ctx.profile.name).toBe('kimi')
    // Profile defaults fill unset request fields...
    expect(ctx.config.model).toBe('kimi-k3')
    // ...but no config dir is pinned: credentials come from the environment.
    expect(ctx.config.env?.CLAUDE_CONFIG_DIR).toBeUndefined()
    // The bridge is handed over so the engine can execute tools in the tab.
    expect(typeof ctx.bridge.executorFor).toBe('function')
  })

  it('routes claude profiles to the SDK runner, untouched', async () => {
    const createEngineRunner = vi.fn((ctx: EngineRunnerContext) => fakeRunner('engine-1', ctx.config))
    const profile = claudeProfile()
    const configs: SessionRunnerConfig[] = []
    running = createWorkerServer({
      allowUnauthenticated: true,
      allowedCwdRoots: ['/tmp'],
      profiles: [profile, providerProfile()],
      createEngineRunner,
      buildRunnerConfig: (req) => {
        const config = { ...req, queryFn: (() => idleQuery()) as never }
        configs.push(config)
        return config
      },
    })
    const { port } = await running.listen(0, '127.0.0.1')
    const res = await fetch(`http://127.0.0.1:${port}/v1/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ cwd: '/tmp/project', profile: 'claude' }),
    })
    expect(res.status).toBe(201)
    expect(createEngineRunner).not.toHaveBeenCalled()
  })

  it("feeds bridged execution results back into the runner's settleExecution", async () => {
    const settled: Array<{ executionId: string; result: ToolExecutionResult }> = []
    const hostResults: string[] = []
    running = createWorkerServer({
      allowUnauthenticated: true,
      allowedCwdRoots: ['/tmp'],
      profiles: [providerProfile()],
      bridge: { onResult: (_s, executionId) => hostResults.push(executionId) },
      createEngineRunner: ({ config }) => ({
        ...fakeRunner('engine-1', config),
        settleExecution: (executionId, result) => {
          settled.push({ executionId, result })
          return true
        },
      }),
    })
    const { port } = await running.listen(0, '127.0.0.1')
    const res = await fetch(`http://127.0.0.1:${port}/v1/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ cwd: '/tmp/project', profile: 'kimi' }),
    })
    const { session } = (await res.json()) as { session: SessionInfo }

    const ws = new WebSocket(`ws://127.0.0.1:${port}/v1/sessions/${session.id}/ws`)
    const attached = new Promise<void>((resolve) => {
      ws.on('message', (data) => {
        if ((JSON.parse(String(data)) as { type: string }).type === 'attached') resolve()
      })
    })
    ws.on('message', (data) => {
      const frame = JSON.parse(String(data)) as { type: string; executionId?: string }
      if (frame.type === 'tool_call_request') {
        ws.send(
          JSON.stringify({
            type: 'tool_call_result',
            executionId: frame.executionId,
            output: { type: 'json', value: 42 },
          }),
        )
      }
    })
    await attached

    const pending = await running.bridge.executorFor(session.id).dispatch({
      executionId: 'exec-1',
      sessionId: session.id,
      tool: 'eval_script',
      input: { script: '6 * 7' },
    })
    expect(pending.status).toBe('pending')

    // The server wires the answer into the runner itself — no host boilerplate —
    // and the host's own onResult observer still fires.
    await vi.waitFor(() => expect(settled).toHaveLength(1))
    expect(settled[0]).toMatchObject({
      executionId: 'exec-1',
      result: { status: 'ok', output: 42 },
    })
    expect(hostResults).toEqual(['exec-1'])
    ws.close()
  })

  it('serves session files straight from the runner VFS', async () => {
    const vfs = createVfs({
      '/out/report.json': '{"revenuePerEmployee":348}',
      '/SUMMARY.md': '# Summary\n',
    })
    running = createWorkerServer({
      allowUnauthenticated: true,
      allowedCwdRoots: ['/tmp'],
      profiles: [providerProfile()],
      createEngineRunner: ({ config }) => ({ ...fakeRunner('engine-1', config), vfs }),
    })
    const { port } = await running.listen(0, '127.0.0.1')
    const created = await fetch(`http://127.0.0.1:${port}/v1/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ cwd: '/tmp/project', profile: 'kimi' }),
    })
    const { session } = (await created.json()) as { session: SessionInfo }
    const base = `http://127.0.0.1:${port}/v1/sessions/${session.id}/files`

    const list = await fetch(base)
    expect(list.status).toBe(200)
    expect(await list.json()).toEqual({
      files: [
        { path: '/SUMMARY.md', bytes: 10 },
        { path: '/out/report.json', bytes: 26 },
      ],
    })

    const download = await fetch(`${base}/out/report.json`)
    expect(download.status).toBe(200)
    expect(download.headers.get('content-type')).toContain('application/json')
    expect(download.headers.get('content-disposition')).toContain('attachment')
    expect(download.headers.get('content-disposition')).toContain('report.json')
    expect(await download.text()).toBe('{"revenuePerEmployee":348}')

    expect((await fetch(`${base}/nope.txt`)).status).toBe(404)
  })

  it('404s the file routes for engines without a VFS', async () => {
    running = createWorkerServer({
      allowUnauthenticated: true,
      allowedCwdRoots: ['/tmp'],
      profiles: [providerProfile()],
      createEngineRunner: ({ config }) => fakeRunner('engine-1', config),
    })
    const { port } = await running.listen(0, '127.0.0.1')
    const created = await fetch(`http://127.0.0.1:${port}/v1/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ cwd: '/tmp/project', profile: 'kimi' }),
    })
    const { session } = (await created.json()) as { session: SessionInfo }
    const res = await fetch(`http://127.0.0.1:${port}/v1/sessions/${session.id}/files`)
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ error: 'session has no file store' })
  })

  it('serves provider profiles over the profiles API without a config snapshot', async () => {
    running = createWorkerServer({
      allowUnauthenticated: true,
      profiles: [providerProfile()],
      createEngineRunner: ({ config }) => fakeRunner('engine-1', config),
    })
    const { port } = await running.listen(0, '127.0.0.1')
    const res = await fetch(`http://127.0.0.1:${port}/v1/profiles/kimi`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { profile: ProfileInfo; config: { skills: string[] } }
    expect(body.profile).toMatchObject({
      name: 'kimi',
      engine: 'provider',
      provider: { id: 'moonshotai', model: 'kimi-k3', apiKeyEnv: 'MOONSHOT_API_KEY' },
    })
    // Names only, never values — the key itself is never on the wire.
    expect(JSON.stringify(body.profile)).not.toContain('sk-')
    expect(body.config.skills).toEqual([])
  })
})

function idleQuery() {
  return {
    [Symbol.asyncIterator]() {
      return this
    },
    next: () => new Promise<never>(() => {}),
    interrupt: async () => {},
    setModel: async () => {},
    close: () => {},
  }
}
