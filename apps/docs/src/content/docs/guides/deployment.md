---
title: Deployment
description: Hosting realities — no serverless, single-host sessions, mandatory auth hook, and clamping client requests.
order: 5
---

## No serverless — and why

The Agent SDK spawns the Claude Code CLI as a **long-running subprocess with filesystem state**.
Edge/serverless functions cannot host this. Realistic targets:

- a VM,
- a container with min-instances (so the process and its disk survive between requests),
- any Node ≥ 22 host with a real filesystem.

Node ≥ 22 also matters for the client side of the stack: `@claude-worker/client` relies on
platform `fetch` and `WebSocket` (global in Node ≥ 22), with `fetchImpl`/`WebSocketImpl`
injectable for older runtimes.

## Single-host sessions and resume

Sessions are single-host in V1. Transcripts live on the server's local disk (the SDK default),
and resume works across process restarts **on the same host**: pass `resume: sdkSessionId` on
`CreateSessionRequest`, and the server backfills the prior transcript as `replay: true` events.
`GET /v1/sdk-sessions?dir=…` lists the SDK's on-disk sessions so hosts can offer "resume" after
a restart. Note the two ids: `SessionInfo.id` is the server-assigned id; `sdkSessionId` is the
Agent SDK's — the one you feed back as `resume`.

Multi-host session storage (a custom `SessionStore`) is on the roadmap but unimplemented; if you
need the queue to span hosts, the `QueueAdapter` seam is the supported path — see
[Job queue](/claude-worker/docs/guides/job-queue/).

## The auth hook is mandatory

`createWorkerServer` **refuses to start** without an `authenticate` hook unless you explicitly
pass `allowUnauthenticated: true` — an opt-in for loopback dev only. Never expose an
unauthenticated worker: whoever reaches it can run tool-wielding sessions in your checkouts.

```ts
const worker = createWorkerServer({
  authenticate: async (req) => verifyMyAppToken(req.headers.authorization),
})
```

Return a truthy principal to accept, null/undefined to reject with 401. The hook covers every
route, including WebSocket upgrades (sessions WS and queue WS). Browsers cannot set WS headers —
use a ticket query param (`buildWsUrl` on the client) or cookies for socket auth.

Anthropic credentials are a separate concern entirely: the server implements no Anthropic auth;
the SDK/CLI resolves credentials from the operator's environment. For services, set
`ANTHROPIC_API_KEY` and consider `requireApiKey: true` to fail closed on subscription
credentials — see [Auth & Anthropic's terms](/claude-worker/docs/guides/auth/).

## Clamp what clients may request

The server trusts its host app: `CreateSessionRequest` accepts `mcpServers`, tool policy, model,
and more. Three levers keep that safe:

- **`allowedCwdRoots`** — session `cwd` (and job `session.cwd`, and the `dir` of
  `/sdk-sessions` listings) must resolve inside one of these roots. Strongly recommended.
- **`buildRunnerConfig`** — map/patch every incoming `CreateSessionRequest` (client sessions and
  queue jobs alike) into the actual runner config: inject `env`, strip or override
  `mcpServers`, force `allowedTools`/`disallowedTools`, pin `permissionMode`.
- **Your `authenticate` hook** — decide who may create sessions at all.

```ts
const worker = createWorkerServer({
  authenticate,
  allowedCwdRoots: ['/srv/checkouts'],
  buildRunnerConfig: (req) => ({
    ...req,
    mcpServers: undefined,            // clients don't get to bring their own MCP servers
    permissionMode: 'default',        // force interactive approvals
    env: { ...process.env },
  }),
  requireApiKey: true,
})
```

See the [server reference](/claude-worker/docs/reference/server/) for every option, and
[Permissions](/claude-worker/docs/guides/permissions/) for the approval flow those clamps feed
into.
