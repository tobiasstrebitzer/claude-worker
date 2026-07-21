# claude-worker

Run a **close-to-real Claude Code session** programmatically via the
[Anthropic Agent SDK](https://code.claude.com/docs/en/agent-sdk), and expose it to a host
application as something it can **embed, watch, and control** — a side-panel that brings Claude
Code into your app.

A session created here behaves like Claude Code launched in the same directory: same skills
(`.claude/skills/`), same `CLAUDE.md`, same MCP config surface, same permission system. The worker
adds the missing hosting layer: a session server your web app can talk to, a typed wire protocol
for the message stream, and embeddable panel components with approve/deny controls.

## Packages

| Package | What it is |
| --- | --- |
| `@claude-worker/protocol` | The wire protocol: session events, commands, REST shapes. Dependency-free, browser-safe. **This is the product boundary** — versioned from day one. |
| `@claude-worker/core` | The session runner: wraps `query()`, owns the streaming input, promotes `canUseTool` calls into pending approvals, normalizes SDK messages into protocol events, keeps a seq-numbered event log for attach/replay. Pure library, no transport. |
| `@claude-worker/server` | The gateway: HTTP + WebSocket, session registry (create/list/attach/interrupt/kill), pluggable auth hook, optional job-queue routes. Runs anywhere Node ≥22 runs. |
| `@claude-worker/queue` | The job queue: remote services schedule one-shot runs; jobs execute as ordinary sessions with bounded concurrency and token budgets, delivering progress + completion via webhooks. Pluggable `QueueAdapter` (in-memory bundled; redis/bullmq/pubsub can implement the same contract). |
| `@claude-worker/client` | Typed protocol client for browsers and Node: REST + WebSocket attach with auto-reconnect and replay-from-last-seq. Zero runtime deps. |
| `@claude-worker/react` | The headless React layer: `useClaudeSession` hook + pure transcript reducer. No styling opinion. |
| `@claude-worker/ui` | The styled agent-control component library: session panel (status bar, streaming transcript, tool-call cards, permission prompts, composer), session list, and the underlying primitives. Tailwind v4 + Base UI + cva; light/dark via tokens. See `packages/ui/README.md` for consumer wiring. |
| `apps/web` | Full session-control web app (dashboard): session list, create/resume flow, live panel, settings. |
| `apps/demo` | Minimal-chrome Vite + React consumer proving `@claude-worker/ui` is portable. |

## Quickstart

```bash
pnpm install
pnpm server   # unauthenticated dev gateway on 127.0.0.1:8787 (loopback only!)
pnpm web      # dashboard on http://localhost:5191, proxying /v1 to the gateway
pnpm demo     # minimal demo on http://localhost:5190
```

Create a session in the web UI: point it at a project directory, give it a prompt (plain text or
a skill invocation like `/verify-content 42`), pick a permission mode, and watch the live
transcript. Tool calls not covered by the permission mode surface as approve/deny cards; the tool
blocks until you decide (deny-on-timeout after 5 minutes by default). Closed or restarted-away
sessions can be resumed from the SDK's on-disk store (“Resume a previous session”) — the server
backfills the prior transcript as replay events.

### Embedding in your own app

Server side (the host app supplies the authenticator — the worker has no auth story of its own):

```ts
import { createWorkerServer } from '@claude-worker/server'

const worker = createWorkerServer({
  authenticate: async (req) => verifyMyAppToken(req.headers.authorization),
  allowedCwdRoots: ['/srv/checkouts'],
  buildRunnerConfig: (req) => ({ ...req, env: { ...process.env } }),
})
await worker.listen(8787)
```

Client side:

```tsx
import { ClaudeWorkerClient } from '@claude-worker/client'
import { SessionPanel } from '@claude-worker/ui' // Tailwind v4 host: see packages/ui/README.md

const client = new ClaudeWorkerClient({ baseUrl: 'https://my-app/worker/v1', headers: { ... } })
const session = await client.createSession({
  cwd: '/srv/checkouts/my-repo',
  prompt: '/verify-content 42',
  settingSources: ['user', 'project'], // pick up the repo's skills + CLAUDE.md
})
// then render:
<SessionPanel client={client} sessionId={session.id} />
```

Or use the headless layer (`useClaudeSession` from `@claude-worker/react`) with your own
rendering, consume the stream directly (`client.attach(sessionId).on('event', …)`), or go one
level lower and use `SessionRunner` from `@claude-worker/core` in-process with no server at all.

## Job queue

Enable the queue in server settings to let remote services schedule unattended runs:

```ts
const worker = createWorkerServer({
  authenticate,
  queue: {
    maxConcurrency: 2,          // concurrent job sessions
    sessionTokenLimit: 200_000, // tokens per job (input+output+cache); exceeding kills the run
    dailyTokenLimit: 2_000_000, // global budget per UTC day; queued jobs held once exhausted
    maxJobDurationMs: 1_800_000,          // wall-clock watchdog: kills runs a stuck CLI would wedge
    retention: { maxAgeMs: 86_400_000 },  // expire terminal jobs (in-memory grows unboundedly otherwise)
    // adapter: myRedisAdapter, // defaults to the bundled in-memory adapter
  },
})
```

Schedule and control jobs with the client SDK (or plain REST — `POST/GET/DELETE /v1/jobs`,
`GET /v1/queue`):

```ts
const job = await client.createJob({
  session: { cwd: '/srv/checkout', prompt: '/verify-content 42' },
  webhook: { url: 'https://my-app.test/hooks/claude', headers: { authorization: '…' } },
  attempts: 3, // failed (not canceled) runs re-queue with exponential backoff
})
// job_started → job_progress (per assistant message / permission request) → job_retrying (on a
// failed attempt with attempts left) → job_completed arrive at the webhook; poll
// client.getJob(job.id) or attach(job.sessionId) to watch live.

// Or stream the whole queue over WS (`/v1/queue/ws`) instead of polling:
const queueHandle = client.attachQueue()
queueHandle.on('event', (e) => console.log(e.type, e.job.id))
queueHandle.on('stats', (stats) => console.log(stats.running, 'running'))
```

A job is one unattended run: the session executes the prompt, the first run result completes the
job (`result`, cumulative `usage`, cost), and the session is closed. Job sessions are ordinary
registry sessions, so the web dashboard can watch them stream in real time. The in-memory adapter
is single-process and non-persistent — jobs and daily counters reset on restart; implement
`QueueAdapter` against a shared store for anything beyond one trusted host.

## Permissions are the sharp edge

`canUseTool` promotes a tool call into a **pending approval** the panel renders; the runner blocks
that tool until a client resolves it, with deny-on-timeout by default. Hosts choose per session:
`dontAsk` for unattended runs of trusted, allowlisted-tool skills vs interactive approval for
anything touching state. This is what makes it safe to point at a real checkout. Sessions can also
be constrained with `allowedTools`/`disallowedTools` and `allowedCwdRoots` on the server.

## Auth & Anthropic's terms

**claude-worker performs no Anthropic authentication of its own — by design.** It spawns the
official Agent SDK, which spawns the official Claude Code CLI, which resolves whatever credentials
the *operator's* environment provides: `ANTHROPIC_API_KEY`, Bedrock/Vertex platform auth, or the
operator's own stored `claude login`. claude-worker never implements claude.ai OAuth, never reads,
stores, or proxies tokens, and never touches `~/.claude` credentials. Which credentials your
deployment uses — and whether that use complies with
[Anthropic's terms](https://www.anthropic.com/legal/consumer-terms) — is the operator's
responsibility.

What we understand the lines to be (not legal advice):

- **API key (or Bedrock/Vertex) is the supported path** for anything that is a service:
  unattended/scheduled runs, multi-user deployments, anything you expose to others. Anthropic's
  Agent SDK docs are explicit that third-party developers may not offer claude.ai login or
  subscription rate limits in their products; the Consumer Terms restrict automated access except
  via API key. Set `ANTHROPIC_API_KEY` in the server environment, and consider
  `requireApiKey: true` on `createWorkerServer` to **fail closed**: sessions that initialize on
  subscription credentials (`apiKeySource: 'oauth'`) are terminated with an error.
- **Your own subscription, your own single-user use** (the equivalent of running `claude -p`
  yourself) is the one case where subscription credentials may be appropriate. Without
  `requireApiKey`, the server allows it but logs a one-time notice; the auth provenance is also
  visible per session as `apiKeySource` on `SessionInfo` and the `system_init` event.

> ⚠️ **Compliance status: under review.** We are still working through greenlighting the
> compliance and legal posture of this project — with our own legal/compliance specialists and,
> where appropriate, explicit approval from Anthropic (whose Agent SDK docs provide for
> previously-approved exceptions). Until that concludes, treat the guidance above as our
> good-faith reading, not a settled position, and do your own diligence.

**Red lines for contributors** (PRs crossing these will be rejected): no claude.ai OAuth flows or
login UI, no extraction/storage/forwarding of subscription tokens, no spoofing of Claude Code's
client identity, no multi-account pooling or rate-limit circumvention of any kind. The auth layer
stays 100% Anthropic-owned code.

## Honest constraints

- **Hosting: no serverless.** The SDK spawns the Claude Code CLI as a long-running subprocess with
  filesystem state. Edge/serverless functions cannot host this. Realistic targets: a VM, a
  container with min-instances, any Node ≥22 host with a real filesystem.
- **Sessions are single-host in V1.** Transcripts live on the server's local disk (the SDK
  default); resume works across process restarts on the same host via `resume: sdkSessionId`.
- **The server trusts its host app.** `CreateSessionRequest` accepts `mcpServers` and tool policy;
  gate session creation behind your own auth and use `allowedCwdRoots` + `buildRunnerConfig` to
  clamp what clients may request.

## Development

```bash
pnpm typecheck   # tsgo (TypeScript 7 native preview) across the workspace
pnpm test        # vitest (core runner, server integration, transcript reducer)
pnpm lint        # oxlint
pnpm build       # tsdown -> build/ (packages), vite (apps)
```

Workspace layout follows the source-link convention: apps and tests resolve packages straight to
TS source via the `@claude-worker/source` export condition (`node --conditions=@claude-worker/source`
+ swc-node in dev); `build/` output exists only for publishing.

## Status

V1 / proof-of-concept, plus the first post-V1 layer (the job queue) landing. See
`docs/prd-claude-worker.md` for the full PRD and open questions (naming, transport evolution,
unattended permission policy).
