import { beforeAll, describe, expect, it, vi } from 'vitest'
import { MockLanguageModelV3 } from 'ai/test'
import { tool } from 'ai'
import { z } from 'zod'
import variant from '@jitl/quickjs-ng-wasmfile-release-asyncify'
import { createVfs, loadEngine, type SandboxEngine } from '@claude-worker/sandbox'
import type { SessionEvent } from '@claude-worker/protocol'
import { QuickJsExecutor, connectMcpTools, createEngineSession } from '../src/index.ts'

let engine: SandboxEngine
beforeAll(async () => {
  engine = await loadEngine(variant)
})

const USAGE = {
  inputTokens: { total: 10, noCache: 10, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 5, text: 5, reasoning: undefined },
  raw: undefined,
}
const say = (t: string) => ({
  content: [{ type: 'text' as const, text: t }],
  finishReason: { unified: 'stop' as const, raw: undefined },
  usage: USAGE,
  warnings: [],
})
const callTool = (id: string, name: string, input: unknown) => ({
  content: [{ type: 'tool-call' as const, toolCallId: id, toolName: name, input: JSON.stringify(input) }],
  finishReason: { unified: 'tool-calls' as const, raw: undefined },
  usage: USAGE,
  warnings: [],
})

describe('createEngineSession', () => {
  it('assembles a session that runs sandboxed tools through the selected executor', async () => {
    const model = new MockLanguageModelV3({
      modelId: 'mock-1',
      doGenerate: [callTool('c1', 'eval_script', { script: '6 * 7' }), say('42')],
    })
    const selectExecutor = vi.fn(() => new QuickJsExecutor({ engine }))
    const runner = createEngineSession({
      config: { cwd: '/tmp', languageModel: model },
      resolveModel: () => model,
      selectExecutor,
    })
    const events: SessionEvent[] = []
    runner.subscribe((e) => events.push(e))
    void runner.start()
    runner.sendMessage('what is six times seven?')

    await vi.waitFor(() => expect(events.some((e) => e.type === 'turn_result')).toBe(true), {
      timeout: 15_000,
    })
    expect(selectExecutor).toHaveBeenCalled()
    expect(events.find((e) => e.type === 'execution_result')).toMatchObject({
      executionId: 'c1',
      output: { type: 'json', value: 42 },
    })
  }, 30_000)

  it('grants MCP tools as authoritative and runs them server-side', async () => {
    const model = new MockLanguageModelV3({
      modelId: 'mock-1',
      doGenerate: [callTool('c1', 'push', { lead: 'acme' }), say('pushed')],
    })
    const pushed: unknown[] = []
    const runner = createEngineSession({
      config: { cwd: '/tmp', languageModel: model },
      resolveModel: () => model,
      selectExecutor: () => new QuickJsExecutor({ engine }),
      mcpTools: {
        push: tool({
          inputSchema: z.object({ lead: z.string() }),
          execute: async (input) => {
            pushed.push(input)
            return { ok: true }
          },
        }),
      },
    })
    void runner.start()
    runner.sendMessage('push acme')
    await vi.waitFor(() => expect(pushed).toEqual([{ lead: 'acme' }]), { timeout: 15_000 })
  }, 30_000)

  it('shares one scratch VFS between the tools and the sandbox', async () => {
    const model = new MockLanguageModelV3({
      modelId: 'mock-1',
      doGenerate: [
        callTool('c1', 'fs_write', { path: '/a.txt', content: 'hello' }),
        callTool('c2', 'eval_script', { script: `vfs.read('/a.txt').toUpperCase()` }),
        say('done'),
      ],
    })
    const vfs = createVfs()
    const runner = createEngineSession({
      config: { cwd: '/tmp', languageModel: model, vfs },
      resolveModel: () => model,
      selectExecutor: () => new QuickJsExecutor({ engine }),
    })
    const events: SessionEvent[] = []
    runner.subscribe((e) => events.push(e))
    void runner.start()
    runner.sendMessage('go')

    await vi.waitFor(() => expect(events.some((e) => e.type === 'turn_result')).toBe(true), {
      timeout: 15_000,
    })
    // A file written by the authoritative fs_write tool is visible to the
    // sandboxed script — same VFS, different trust levels.
    expect(events.find((e) => e.type === 'execution_result')).toMatchObject({
      output: { type: 'json', value: 'HELLO' },
    })
  }, 30_000)
})

describe('connectMcpTools', () => {
  it('is a no-op with no servers, so MCP stays an optional dependency', async () => {
    const connection = await connectMcpTools({})
    expect(connection.tools).toEqual({})
    await expect(connection.close()).resolves.toBeUndefined()
  })

  it('survives an unreachable server instead of failing the session', async () => {
    const errors: string[] = []
    const connection = await connectMcpTools(
      { broken: { type: 'http', url: 'http://127.0.0.1:1/mcp' } },
      { onError: (name) => errors.push(name) },
    )
    expect(connection.tools).toEqual({})
    // onError may fire more than once for one server (transport-level retries
    // report through onUncaughtError as well as the connect failure) — what
    // matters is that it is reported and the session goes on without it.
    expect(errors.length).toBeGreaterThan(0)
    expect(new Set(errors)).toEqual(new Set(['broken']))
  }, 20_000)

  it('rejects stdio servers explicitly rather than dropping them silently', async () => {
    const errors: unknown[] = []
    await connectMcpTools(
      { local: { command: 'some-server' } },
      { onError: (_name, error) => errors.push(error) },
    )
    expect(String(errors[0])).toMatch(/stdio MCP servers are not supported/)
  })
})
