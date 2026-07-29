import { beforeAll, describe, expect, it, vi } from 'vitest'
import { MockLanguageModelV3, convertArrayToReadableStream } from 'ai/test'
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
// Loop legs are streamed (doStream); generateSay is the doGenerate form for
// plain generateText calls (the web_fetch digest pass).
const say = (t: string) => ({
  stream: convertArrayToReadableStream([
    { type: 'stream-start' as const, warnings: [] },
    { type: 'text-start' as const, id: 't1' },
    { type: 'text-delta' as const, id: 't1', delta: t },
    { type: 'text-end' as const, id: 't1' },
    { type: 'finish' as const, finishReason: { unified: 'stop' as const, raw: undefined }, usage: USAGE },
  ]),
})
const callTool = (id: string, name: string, input: unknown) => ({
  stream: convertArrayToReadableStream([
    { type: 'stream-start' as const, warnings: [] },
    { type: 'tool-call' as const, toolCallId: id, toolName: name, input: JSON.stringify(input) },
    { type: 'finish' as const, finishReason: { unified: 'tool-calls' as const, raw: undefined }, usage: USAGE },
  ]),
})
const generateSay = (t: string) => ({
  content: [{ type: 'text' as const, text: t }],
  finishReason: { unified: 'stop' as const, raw: undefined },
  usage: USAGE,
  warnings: [],
})

describe('createEngineSession', () => {
  it('assembles a session that runs sandboxed tools through the selected executor', async () => {
    const model = new MockLanguageModelV3({
      modelId: 'mock-1',
      doStream: [callTool('c1', 'eval_script', { script: '6 * 7' }), say('42')],
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
      doStream: [callTool('c1', 'push', { lead: 'acme' }), say('pushed')],
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

  it('emits file_delivered when the agent hands a VFS file over', async () => {
    const model = new MockLanguageModelV3({
      modelId: 'mock-1',
      doStream: [
        callTool('c1', 'fs_write', { path: '/SUMMARY.md', content: '# Sum' }),
        callTool('c2', 'deliver_file', { path: '/SUMMARY.md', description: 'the summary' }),
        say('Delivered.'),
      ],
    })
    const runner = createEngineSession({
      config: { cwd: '/tmp', languageModel: model },
      resolveModel: () => model,
      selectExecutor: () => new QuickJsExecutor({ engine }),
    })
    const events: SessionEvent[] = []
    runner.subscribe((e) => events.push(e))
    void runner.start()
    runner.sendMessage('write and deliver a summary')

    await vi.waitFor(() => expect(events.some((e) => e.type === 'turn_result')).toBe(true), {
      timeout: 15_000,
    })
    expect(events.find((e) => e.type === 'file_delivered')).toMatchObject({
      path: '/SUMMARY.md',
      bytes: 5,
      description: 'the summary',
    })
    // The server's file routes read the delivered file straight off Runner.vfs.
    expect(runner.vfs?.read('/SUMMARY.md')).toBe('# Sum')
  }, 30_000)

  it('runs the web_fetch digest on the session model and bills it into the turn', async () => {
    const model = new MockLanguageModelV3({
      modelId: 'mock-1',
      doStream: [
        callTool('c1', 'web_fetch', { url: 'http://203.0.113.5/pricing', prompt: 'how much?' }),
        say('The page says $10/mo.'),
      ],
      // The digest pass is a plain generateText on the same model.
      doGenerate: [generateSay('It costs $10/mo.')],
    })
    const fetchImpl = async () =>
      new Response('<h1>Pricing</h1><p>$10/mo</p>', {
        status: 200,
        headers: { 'content-type': 'text/html' },
      })
    const runner = createEngineSession({
      config: { cwd: '/tmp', languageModel: model },
      resolveModel: () => model,
      selectExecutor: () => new QuickJsExecutor({ engine }),
      capabilities: { webFetch: { fetchImpl: fetchImpl as unknown as typeof fetch } },
    })
    const events: SessionEvent[] = []
    runner.subscribe((e) => events.push(e))
    void runner.start()
    runner.sendMessage('what does the pricing page say?')

    await vi.waitFor(() => expect(events.some((e) => e.type === 'turn_result')).toBe(true), {
      timeout: 15_000,
    })
    const turn = events.find((e) => e.type === 'turn_result')!
    expect(turn).toMatchObject({ subtype: 'success', result: 'The page says $10/mo.' })
    // Three generate calls hit the model (loop step, digest, final step) at
    // 10 in / 5 out each — the digest's tokens must not be lost.
    expect(turn.type === 'turn_result' && turn.usage).toMatchObject({
      input_tokens: 30,
      output_tokens: 15,
    })
  }, 30_000)

  it('shares one scratch VFS between the tools and the sandbox', async () => {
    const model = new MockLanguageModelV3({
      modelId: 'mock-1',
      doStream: [
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
