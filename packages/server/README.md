# @claude-worker/server

The claude-worker gateway: HTTP + WebSocket session server over
[`@claude-worker/core`](https://www.npmjs.com/package/@claude-worker/core). Session registry
(create/list/attach/interrupt/kill), pluggable auth hook, replay-from-seq attach, optional
job-queue routes. Runs anywhere Node runs — needs a real filesystem (no serverless).

Part of [claude-worker](https://github.com/tobiasstrebitzer/claude-worker). It speaks the
[`@claude-worker/protocol`](https://www.npmjs.com/package/@claude-worker/protocol) wire format;
pair it with [`@claude-worker/client`](https://www.npmjs.com/package/@claude-worker/client) in the
host app and [`@claude-worker/ui`](https://www.npmjs.com/package/@claude-worker/ui) for embeddable
panels. Job scheduling comes from
[`@claude-worker/queue`](https://www.npmjs.com/package/@claude-worker/queue), mounted via the
`queue` option.

## Install

```bash
npm install @claude-worker/server
```

Node ≥ 22. The Agent SDK spawns the Claude Code CLI as a long-running subprocess with filesystem
state — edge/serverless functions cannot host this; realistic targets are a VM or a container.
The server implements no Anthropic auth: the SDK/CLI resolves credentials from the operator's
environment (`ANTHROPIC_API_KEY`, Bedrock/Vertex, or a personal `claude login`).

## Usage

The host app supplies the authenticator — return a truthy principal to accept, null/undefined to
reject with 401. `createWorkerServer` refuses to start without `authenticate` unless you
explicitly pass `allowUnauthenticated: true` (loopback dev only — never expose that):

```ts
import { createWorkerServer } from '@claude-worker/server'

const worker = createWorkerServer({
  authenticate: async (req) => verifyMyAppToken(req.headers.authorization),
  allowedCwdRoots: ['/srv/checkouts'],          // clamp where sessions may run
  buildRunnerConfig: (req) => ({ ...req, env: { ...process.env } }),
  requireApiKey: true,                          // fail closed on subscription credentials
})
const { port } = await worker.listen(8787)
// worker.server (node:http), worker.registry, worker.queue, worker.close()
```

Routes (default `basePath: '/v1'`):

| Route | What it does |
| --- | --- |
| `GET/POST /v1/sessions` | List sessions / create one (`CreateSessionRequest`, `cwd` required) |
| `GET/DELETE /v1/sessions/:id` | Session info / close and remove |
| `WS /v1/sessions/:id/ws?afterSeq=n` | Attach: `attached` frame, replay past `n`, then live events |
| `POST /v1/sessions/:id/permissions/:requestId` | Resolve a pending approval over REST |
| `GET /v1/sdk-sessions?dir=…` | List the Agent SDK's on-disk sessions to offer resume |
| `GET/POST /v1/jobs`, `GET/DELETE /v1/jobs/:id` | Job queue (when `queue` is configured) |
| `GET /v1/queue`, `WS /v1/queue/ws` | Queue stats / one-way live stream of job events + stats |

## Job queue

Pass `queue` options to mount the job routes — one-shot unattended runs with bounded concurrency,
token budgets, retries, and webhook delivery:

```ts
const worker = createWorkerServer({
  authenticate,
  queue: {
    maxConcurrency: 2,
    sessionTokenLimit: 200_000,          // per job; exceeding kills the run
    dailyTokenLimit: 2_000_000,          // global UTC-day budget; queued jobs held once spent
    maxJobDurationMs: 1_800_000,         // wall-clock watchdog
    retention: { maxAgeMs: 86_400_000 }, // expire terminal jobs
    // adapter: myRedisAdapter,          // defaults to the bundled in-memory adapter
  },
})
```

Job sessions are ordinary registry sessions — attachable over the sessions WS — and go through
the same `buildRunnerConfig` hook and auth-provenance watcher as client sessions. The in-memory
adapter is single-process and non-persistent; implement `QueueAdapter` against a shared store for
anything beyond one trusted host.

## Auth posture

Each session's credential provenance surfaces as `apiKeySource` on `SessionInfo` and the
`system_init` event; `'oauth'` means claude.ai subscription credentials. With
`requireApiKey: true` such sessions are terminated with a `session_error` — recommended for
services and any unattended use. Without it the server logs a one-time notice instead
(appropriate only for personal single-user deployments). claude-worker never implements claude.ai
OAuth, never reads or forwards tokens — see the repo README's
["Auth & Anthropic's terms"](https://github.com/tobiasstrebitzer/claude-worker#auth--anthropics-terms).

## License

MIT © Tobias Strebitzer —
[LICENSE](https://github.com/tobiasstrebitzer/claude-worker/blob/master/LICENSE)
