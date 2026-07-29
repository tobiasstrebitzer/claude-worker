import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Runner, SessionRunnerConfig } from '@claude-worker/core'
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
