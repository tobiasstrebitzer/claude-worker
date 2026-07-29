import type { LanguageModel, ToolSet } from 'ai'
import type { McpServerConfigWire, ProfileInfo } from '@claude-worker/protocol'
import { createVfs } from '@claude-worker/sandbox'
import { AiSdkRunner, type AiSdkRunnerConfig } from './ai-sdk-runner.ts'
import { createToolContext, withMcpTools, type ToolContextOptions } from './tools.ts'
import type { ToolExecutor } from './tool-executor.ts'

export type EngineSessionOptions = {
  /** Resolved session config (profile defaults already applied). */
  config: AiSdkRunnerConfig
  /** The profile that selected this engine, when there was one. */
  profile?: ProfileInfo
  /**
   * Resolve the profile's provider config into a model instance. The host owns
   * this so core never imports a provider SDK and never reads credentials —
   * they come from the operator's environment, exactly like the Claude chain.
   */
  resolveModel: (profile: ProfileInfo | undefined, config: AiSdkRunnerConfig) => LanguageModel
  /**
   * Executor for sandboxed tools. Return the browser bridge when a client is
   * attached and the server sandbox otherwise; the seam makes them
   * interchangeable, so this is the only place the choice is made.
   */
  selectExecutor: () => ToolExecutor
  /** Which backend `selectExecutor` returned, for the execution_* events. */
  backend?: 'server' | 'browser' | 'managed' | 'remote'
  /** Backends for the granted capabilities. Omitted ones are simply not granted. */
  capabilities?: Pick<ToolContextOptions, 'search' | 'download'>
  /** Authoritative tools that run server-side with server credentials (MCP).
   * Never bridged to a client. */
  mcpTools?: ToolSet
  /** Extra instructions prepended to the session's system prompt. */
  instructions?: string
  executionLimits?: { timeoutMs?: number; memoryLimitBytes?: number }
}

/**
 * Assemble a model-agnostic session: provider model, capability-scoped tools,
 * a scratch VFS, and the executor that runs the sandboxed ones.
 *
 * This is the piece an operator wires into the server's `createEngineRunner`.
 */
export function createEngineSession(options: EngineSessionOptions): AiSdkRunner {
  const vfs = options.config.vfs ?? createVfs()
  const executor = options.selectExecutor()
  const base = createToolContext({
    executor,
    sessionId: 'pending',
    vfs,
    search: options.capabilities?.search,
    download: options.capabilities?.download,
  })
  const context = options.mcpTools ? withMcpTools(base, options.mcpTools) : base

  return new AiSdkRunner({
    ...options.config,
    languageModel: options.resolveModel(options.profile, options.config),
    instructions: options.instructions ?? options.config.instructions,
    tools: context.tools,
    vfs,
    executor,
    executableTools: context.sandboxedToolNames,
    executionBackend: options.backend ?? 'server',
    executionLimits: options.executionLimits,
  })
}

export type McpConnection = {
  tools: ToolSet
  close: () => Promise<void>
}

/**
 * Connect to MCP servers and return their tools, ready for {@link withMcpTools}.
 *
 * Server-side only, with server credentials: these tools are authoritative and
 * must never be bridged to a browser. `@ai-sdk/mcp` is imported lazily and is an
 * optional dependency — an operator who wires no MCP servers never needs it.
 */
export async function connectMcpTools(
  servers: Record<string, McpServerConfigWire>,
  /** `onError` may fire more than once for a single server: transport-level
   * failures surface through the client's own uncaught-error channel as well as
   * the connect failure. Treat it as a report, not a count. */
  options: { onError?: (name: string, error: unknown) => void } = {},
): Promise<McpConnection> {
  const entries = Object.entries(servers)
  if (entries.length === 0) return { tools: {}, close: async () => {} }

  const { createMCPClient } = await import('@ai-sdk/mcp')
  const clients: Array<{ close: () => Promise<void> }> = []
  const tools: ToolSet = {}

  for (const [name, server] of entries) {
    try {
      const client = await createMCPClient({
        transport: toTransport(server),
        onUncaughtError: (error) => options.onError?.(name, error),
      })
      clients.push(client as unknown as { close: () => Promise<void> })
      // Namespaced so two servers exposing the same tool name cannot collide
      // (and so a tool's origin stays legible in the transcript).
      for (const [toolName, mcpTool] of Object.entries(await client.tools())) {
        tools[`${name}__${toolName}`] = mcpTool as ToolSet[string]
      }
    } catch (error) {
      // One unreachable server must not take down the session; the agent simply
      // does not get those tools.
      options.onError?.(name, error)
    }
  }

  return {
    tools,
    close: async () => {
      await Promise.allSettled(clients.map((c) => c.close()))
    },
  }
}

/**
 * Only http/sse: the AI SDK's built-in transports are the remote ones, and its
 * own docs mark stdio local-only and not deployable. A stdio server here is a
 * misconfiguration worth surfacing rather than silently dropping — the Claude
 * engine still supports stdio, since the CLI spawns those itself.
 */
function toTransport(server: McpServerConfigWire) {
  if (!('url' in server)) {
    throw new Error(
      'stdio MCP servers are not supported by the model-agnostic engine (use an http or sse ' +
        'server, or run this session under a Claude profile)',
    )
  }
  return server.type === 'sse'
    ? { type: 'sse' as const, url: server.url, headers: server.headers }
    : { type: 'http' as const, url: server.url, headers: server.headers }
}
