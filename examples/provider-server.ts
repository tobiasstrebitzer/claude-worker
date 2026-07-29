/**
 * Dev server for trying the model-agnostic engine from the browser dashboard.
 * Drop-in replacement for `pnpm server` (same port, NO AUTH, loopback only):
 *
 *   pnpm example:server        # reads .env for provider keys (see below)
 *   pnpm web                   # then open http://localhost:5191
 *
 * Declares one Claude profile (the operator's own ~/.claude) plus a provider
 * profile per API key found in the environment / repo .env:
 *
 *   ANTHROPIC_API_KEY → profile 'anthropic' (claude-sonnet-5)
 *   OPENAI_API_KEY    → profile 'openai'    (gpt-5)
 *   MOONSHOT_API_KEY  → profile 'moonshot'  (kimi-k3)
 *
 * Provider sessions get the capability-scoped tool set with a scratch VFS
 * seeded with a demo document, and `eval_script` executes IN YOUR BROWSER TAB:
 * the server has no sandbox executor here, so every eval crosses the WS bridge
 * to the attached dashboard, which runs it in a QuickJS guest and answers.
 */
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { LanguageModel } from 'ai'
import type { ProfileInfo } from '@claude-worker/protocol'
import { createVfs } from '@claude-worker/sandbox'
import { connectMcpTools, createEngineSession, type ToolExecutor } from '@claude-worker/core'
import { createWorkerServer } from '@claude-worker/server'

type ProviderSetup = {
  env: string
  model: string
  load: () => Promise<unknown>
}

const PROVIDERS: Record<string, ProviderSetup> = {
  anthropic: {
    env: 'ANTHROPIC_API_KEY',
    model: 'claude-sonnet-5',
    load: () => import('@ai-sdk/anthropic').then((m) => m.anthropic),
  },
  openai: {
    env: 'OPENAI_API_KEY',
    model: 'gpt-5',
    load: () => import('@ai-sdk/openai').then((m) => m.openai),
  },
  moonshot: {
    env: 'MOONSHOT_API_KEY',
    model: 'kimi-k3',
    load: () => import('@ai-sdk/moonshotai').then((m) => m.moonshotai),
  },
}

// One model factory per provider that actually has a key.
const factories = new Map<string, (id: string) => LanguageModel>()
const profiles: ProfileInfo[] = []

const claudeConfigDir = process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude')
if (existsSync(claudeConfigDir)) {
  profiles.push({
    name: 'claude',
    configDir: claudeConfigDir,
    description: 'Claude Code via the Agent SDK (your own config dir)',
  })
}

for (const [name, setup] of Object.entries(PROVIDERS)) {
  if (!process.env[setup.env]) continue
  factories.set(name, (await setup.load()) as (id: string) => LanguageModel)
  profiles.push({
    name,
    engine: 'provider',
    provider: { id: name, model: setup.model, apiKeyEnv: setup.env },
    description: `Model-agnostic engine (${setup.model}); eval_script runs in your browser tab`,
  })
}

if (profiles.length === 0) {
  console.error('No ~/.claude config dir and no provider API keys found — nothing to serve.')
  process.exit(1)
}

// Live MCP: one shared connection for the whole process (sessions must NOT close
// it — it outlives them; it dies with the process). DeepWiki is free/no-auth and
// answers questions about public GitHub repos. Unreachable = sessions simply
// don't get the tools; the dev server still starts.
const mcp = await connectMcpTools(
  process.env.NO_MCP ? {} : { deepwiki: { type: 'http', url: 'https://mcp.deepwiki.com/mcp' } },
  {
    onError: (name, error) =>
      console.warn(`[provider-example] MCP '${name}' unavailable: ${String(error)}`),
  },
)
const mcpToolNames = Object.keys(mcp.tools)

const { listen } = createWorkerServer({
  allowUnauthenticated: true,
  profiles,
  createEngineRunner: ({ config, profile, bridge }) => {
    const factory = factories.get(profile.provider!.id)!
    const modelId = config.model ?? profile.provider!.model!
    // A document the model can only reason about by running code over it.
    const vfs = createVfs({
      '/leads/acme.txt': 'company: Acme Corp\nrevenue: 4173\nemployees: 12\n',
    })
    // The runner's id does not exist yet at assembly time, so resolve the
    // session's bridge executor at dispatch time from the call's own sessionId.
    const toBrowser: ToolExecutor = {
      dispatch: (call) => bridge.executorFor(call.sessionId).dispatch(call),
    }
    // The dashboard's create form offers CLI-only modes (acceptEdits/plan);
    // coerce rather than 500 on a mode this engine has no meaning for.
    const permissionMode = ['default', 'bypassPermissions', 'dontAsk'].includes(
      config.permissionMode ?? 'default',
    )
      ? config.permissionMode
      : 'default'
    return createEngineSession({
      config: { ...config, permissionMode, languageModel: factory(modelId), vfs },
      profile,
      resolveModel: (_profile, c) => factory(c.model ?? modelId),
      selectExecutor: () => toBrowser,
      backend: 'browser',
      // web_fetch with defaults: SSRF-guarded fetch + HTML→markdown, digested by
      // the session's own model (billed into the turn). deliver_file is granted
      // by default alongside it.
      capabilities: { webFetch: {} },
      mcpTools: mcp.tools,
      instructions:
        'You evaluate sales leads. Use the eval_script tool to compute answers from files in the ' +
        'scratch filesystem — never guess numbers. Inside eval_script the sandbox exposes ' +
        'vfs.read(path), vfs.write(path, text), and vfs.list(dir); the value of the last ' +
        'expression is returned to you. Use web_fetch to answer questions about a web page. ' +
        'To hand a file to the user, write it with fs_write, then call deliver_file — the user ' +
        'gets a download card.' +
        (mcpToolNames.length > 0
          ? ` For questions about public GitHub repositories, use the ${mcpToolNames.join(', ')} tools.`
          : ''),
      executionLimits: { timeoutMs: 15_000 },
    })
  },
})

const port = Number(process.env.PORT ?? 8787)
const { port: boundPort } = await listen(port, '127.0.0.1')

console.log(`\n[provider-example] dev server (NO AUTH) on http://127.0.0.1:${boundPort}/v1`)
console.log('[provider-example] profiles:')
for (const p of profiles) {
  console.log(`  - ${p.name}${p.engine === 'provider' ? ` (provider: ${p.provider!.model})` : ' (claude)'}`)
}
const missing = Object.entries(PROVIDERS).filter(([, s]) => !process.env[s.env])
for (const [name, setup] of missing) {
  console.log(`[provider-example] no ${setup.env} — profile '${name}' not offered`)
}
console.log(
  mcpToolNames.length > 0
    ? `[provider-example] MCP tools: ${mcpToolNames.join(', ')}`
    : '[provider-example] no MCP tools (DeepWiki unreachable or NO_MCP set)',
)
console.log('\n[provider-example] next: `pnpm web`, open http://localhost:5191, and follow examples/README.md')
