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
| `@claude-worker/server` | The gateway: HTTP + WebSocket, session registry (create/list/attach/interrupt/kill), pluggable auth hook. Runs anywhere Node ≥22 runs. |
| `@claude-worker/client` | Typed protocol client for browsers and Node: REST + WebSocket attach with auto-reconnect and replay-from-last-seq. Zero runtime deps. |
| `@claude-worker/react` | The embeddable panel: transcript, streaming text, tool-call cards, permission prompts, composer, interrupt. Headless-ish (`cw-*` classes + data attributes; optional default stylesheet). |
| `apps/demo` | Bare Vite + React consumer proving the embeddable claim. |

## Quickstart

```bash
pnpm install
pnpm server   # unauthenticated dev gateway on 127.0.0.1:8787 (loopback only!)
pnpm demo     # Vite demo on http://localhost:5190, proxying /v1 to the gateway
```

Create a session in the demo UI: point it at a project directory, give it a prompt (plain text or
a skill invocation like `/verify-content 42`), pick a permission mode, and watch the live
transcript. Tool calls not covered by the permission mode surface as approve/deny cards; the tool
blocks until you decide (deny-on-timeout after 5 minutes by default).

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
import { SessionPanel } from '@claude-worker/react'
import '@claude-worker/react/styles.css'

const client = new ClaudeWorkerClient({ baseUrl: 'https://my-app/worker/v1', headers: { ... } })
const session = await client.createSession({
  cwd: '/srv/checkouts/my-repo',
  prompt: '/verify-content 42',
  settingSources: ['user', 'project'], // pick up the repo's skills + CLAUDE.md
})
// then render:
<SessionPanel client={client} sessionId={session.id} />
```

Or skip the components and consume the stream directly: `client.attach(sessionId).on('event', …)`,
or go one level lower and use `SessionRunner` from `@claude-worker/core` in-process with no server
at all.

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
pnpm build       # tsdown -> build/ (packages), vite (demo)
```

Workspace layout follows the source-link convention: apps and tests resolve packages straight to
TS source via the `@claude-worker/source` export condition (`node --conditions=@claude-worker/source`
+ swc-node in dev); `build/` output exists only for publishing.

## Status

V1 / proof-of-concept. See `docs/prd-claude-worker.md` for the full PRD, non-goals (job queues are
a later layer on top of the runner, not V1), and open questions (naming, transport evolution,
unattended permission policy).
