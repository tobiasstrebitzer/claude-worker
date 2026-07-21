---
title: Server
description: createWorkerServer options, queue options, and the full route table.
order: 3
---

[`@claude-worker/server`](https://www.npmjs.com/package/@claude-worker/server) is the gateway:
HTTP + WebSocket over `node:http` + `ws`, a session registry, and optional job-queue routes.
Node ≥ 22, real filesystem, no serverless — see
[Deployment](/claude-worker/docs/guides/deployment/).

## createWorkerServer(options)

Returns a `WorkerServer`: `{ server, registry, queue?, listen(port, host?), close() }` —
`server` is the underlying `node:http` server, `queue` is set when queue options were provided.

### WorkerServerOptions

| Option | Default | Effect |
| --- | --- | --- |
| `authenticate` | — | `(req: IncomingMessage) => unknown \| Promise<unknown>`. Return a truthy principal to accept, null/undefined to reject with 401. Required unless `allowUnauthenticated: true` — the worker must never be exposed bare. Covers every route including WS upgrades. |
| `allowUnauthenticated` | `false` | Explicit opt-in to run without auth (local dev only). Without it and without `authenticate`, `createWorkerServer` throws. |
| `allowedCwdRoots` | off | Session `cwd` (and job `session.cwd`) must resolve inside one of these roots, else 403. Also constrains the `dir` of `/sdk-sessions` (which becomes required). Strongly recommended. |
| `buildRunnerConfig` | identity | `(req: CreateSessionRequest) => SessionRunnerConfig` — map/patch the incoming request into the runner config (inject `env`, tool policy, per-skill constraints). Applied to client sessions and queue jobs alike. |
| `basePath` | `'/v1'` | URL prefix for all routes. |
| `maxBodyBytes` | 1 MiB | Max JSON body size. |
| `requireApiKey` | `false` | Fail closed on subscription credentials: a session initializing with `apiKeySource: 'oauth'` is terminated with a `session_error`. Recommended for services and unattended use; off, the server logs a one-time notice instead. See [Auth](/claude-worker/docs/guides/auth/). |
| `listSdkSessions` | SDK `listSessions` | Injectable lister for `GET /sdk-sessions` (tests). |
| `queue` | off | Enable the job queue routes — see below. |

### QueueServerOptions

All `JobQueue` options (minus `createRunner`/`buildRunnerConfig`, which the server wires
itself — job sessions are ordinary registry sessions and go through the same config hook and
auth-provenance watcher as client sessions):

| Option | Default | Effect |
| --- | --- | --- |
| `maxConcurrency` | 1 | Concurrent job sessions. |
| `sessionTokenLimit` | off | Token cap per job session (input+output+cache); exceeding it kills the run. |
| `dailyTokenLimit` | off | Global job-token budget per UTC day; queued jobs held once exhausted. |
| `maxJobDurationMs` | off | Wall-clock cap per run — the watchdog against stuck CLIs. |
| `killGraceMs` | 5000 | Grace between interrupting a killed run and force-closing it. |
| `retention` | keep forever | `{ maxAgeMs, sweepIntervalMs? }` — expire terminal jobs (the in-memory adapter otherwise grows unboundedly). |
| `adapter` | in-memory | `QueueAdapter` backend. The bundled adapter is single-process, non-persistent. |
| `webhookAttempts` | 3 | Delivery attempts per webhook event, exponential backoff. |
| `webhookRetryDelayMs` | 500 | Base delay between webhook delivery retries. |
| `onEvent` | — | Local observer for every `JobEvent`, in addition to per-job webhooks. |

See [Job queue](/claude-worker/docs/guides/job-queue/) for semantics.

## Routes

Default `basePath: '/v1'`; every route goes through `authenticate`.

| Route | What it does |
| --- | --- |
| `GET /v1/sessions` | List sessions (`SessionInfo[]`). |
| `POST /v1/sessions` | Create a session (`CreateSessionRequest`; `cwd` required, 403 outside `allowedCwdRoots`). 201 with the `SessionInfo`. |
| `GET /v1/sessions/:id` | Session info. |
| `DELETE /v1/sessions/:id` | Close and remove the session. |
| `WS /v1/sessions/:id/ws?afterSeq=n` | Attach: `attached` frame (protocol version + snapshot), replay of events past `n`, then live events; accepts `SessionCommand` frames. |
| `POST /v1/sessions/:id/permissions/:requestId` | Resolve a pending approval over REST (`ResolvePermissionRequest`). 404 = unknown, already resolved, or expired. |
| `GET /v1/sdk-sessions?dir=…&limit=…&offset=…` | List the Agent SDK's on-disk sessions to offer resume. With `allowedCwdRoots` set, `dir` is required and must be inside the roots. |
| `GET /v1/jobs` / `POST /v1/jobs` | List jobs / schedule one (`CreateJobRequest`; `session.cwd` + `session.prompt` required). Queue-configured servers only, else 404. |
| `GET /v1/jobs/:id` / `DELETE /v1/jobs/:id` | Job info / cancel. |
| `GET /v1/queue` | Queue stats (`QueueStats`). |
| `WS /v1/queue/ws` | One-way live stream: `queue_attached`, then `job_event` + refreshed `queue_stats` frames. No replay — re-list jobs on (re)connect. |

## Anthropic credentials

The server implements no Anthropic auth: the SDK/CLI resolves credentials from the operator's
environment (`ANTHROPIC_API_KEY`, Bedrock/Vertex, or a personal `claude login`). Each session's
provenance surfaces as `apiKeySource` on `SessionInfo` and the `system_init` event — the full
posture, including `requireApiKey` and the contributor red lines, is in
[Auth & Anthropic's terms](/claude-worker/docs/guides/auth/).
