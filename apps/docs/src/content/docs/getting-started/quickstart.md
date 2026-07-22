---
title: Quickstart
description: Run the dev gateway and dashboard, create a first session, then embed the panel in your own app.
order: 2
---

## Prerequisites

- Node ≥ 22 and pnpm.
- Anthropic credentials in your environment — claude-worker implements no auth of its own; the
  Agent SDK resolves whatever the operator's environment provides (`ANTHROPIC_API_KEY`,
  Bedrock/Vertex, or your own `claude login`). See
  [Auth & Anthropic's terms](/claude-worker/docs/guides/auth/).

## Run the workspace

```bash
git clone https://github.com/tobiasstrebitzer/claude-worker
cd claude-worker
pnpm install
pnpm server   # unauthenticated dev gateway on 127.0.0.1:8787 (loopback only!)
pnpm web      # dashboard on http://localhost:5191, proxying /v1 to the gateway
```

The dev gateway runs with `allowUnauthenticated: true`, which `createWorkerServer` only permits
as an explicit opt-in — never expose it beyond loopback.

## Create a first session

In the dashboard:

1. Point the session at a project directory.
2. Give it a prompt — plain text or a skill invocation like `/verify-content 42`.
3. Pick a permission mode, and watch the live transcript.

Tool calls not covered by the permission mode surface as approve/deny cards; the tool blocks
until you decide (deny-on-timeout after 5 minutes by default). Closed or restarted-away sessions
can be resumed from the SDK's on-disk store ("Resume a previous session") — the server backfills
the prior transcript as replay events.

## Minimal embed

Server side — the host app supplies the authenticator; the worker has no auth story of its own:

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
import { SessionPanel } from '@claude-worker/ui' // Tailwind v4 host: see the embedding guide

const client = new ClaudeWorkerClient({ baseUrl: 'https://my-app/worker/v1', headers: { ... } })
const session = await client.createSession({
  cwd: '/srv/checkouts/my-repo',
  prompt: '/verify-content 42',
  settingSources: ['user', 'project'], // pick up the repo's skills + CLAUDE.md
})
// then render:
<SessionPanel client={client} sessionId={session.id} />
```

`@claude-worker/ui` ships source styles that your app's Tailwind v4 build compiles — the wiring
(theme import, `@source` directives, theme attribute) is covered in
[Embedding](/claude-worker/docs/guides/embedding/).

## Next steps

- [Embedding](/claude-worker/docs/guides/embedding/) — the full options ladder, from styled
  panel down to in-process `SessionRunner`.
- [Permissions](/claude-worker/docs/guides/permissions/) — approvals, modes, tool allowlists.
- [Job queue](/claude-worker/docs/guides/job-queue/) — unattended one-shot runs with webhooks.
