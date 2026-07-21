---
title: Job queue
description: One-shot unattended runs with bounded concurrency, token budgets, retries, webhooks, and a live queue stream.
order: 3
---

The job queue lets remote services schedule unattended runs. A job is **one-shot**: the session
executes the prompt, the first run result completes the job (`result`, cumulative `usage`,
cost), and the session is closed. Job sessions are ordinary registry sessions, so the web
dashboard (or any client) can attach and watch them stream in real time.

## Enabling the queue

Pass `queue` options to `createWorkerServer` to mount `/jobs` + `/queue` routes plus the
`/queue/ws` stream:

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

All queue options are documented in the [server reference](/claude-worker/docs/reference/server/).

## Scheduling jobs

Via the client SDK, or plain REST (`POST/GET/DELETE /v1/jobs`, `GET /v1/queue`):

```ts
const job = await client.createJob({
  session: { cwd: '/srv/checkout', prompt: '/verify-content 42' },
  webhook: { url: 'https://my-app.test/hooks/claude', headers: { authorization: '…' } },
  attempts: 3, // failed (not canceled) runs re-queue with exponential backoff
})
await client.getJob(job.id) // plus listJobs(), cancelJob(id), queueStats()
```

Per request, `CreateJobRequest` adds `attempts`, `retryDelayMs`, `maxTokens`, `maxDurationMs`
(the stricter of request and queue limits wins), `webhook.progress: 'completion'` to quiet
progress deliveries, and free-form `meta`. `session.prompt` is required;
`resume`/`forkSession` are not supported for queued jobs.

## Webhook event sequence

Deliveries are ordered per job, POSTed as JSON `JobEvent` bodies, and retried with exponential
backoff (default 3 attempts, 500 ms base delay):

```text
job_started → job_progress (per assistant message / permission request)
            → job_retrying (on a failed attempt with attempts left)
            → job_completed (always terminal)
```

`job_submitted` goes to local observers and the queue WS only — the submitter already has the
POST response. `job_progress` carries a `JobProgress` with a preview and, for
`permission_requested`, the full request (including `AskUserQuestion` input) so webhook
consumers can answer via `POST /v1/sessions/:sessionId/permissions/:requestId` — see
[Permissions](/claude-worker/docs/guides/permissions/) and `questionBehavior` for the
unattended-run policies.

## Budgets, watchdog, retries, retention

- **Per-session token limit** (`sessionTokenLimit` / per-job `maxTokens`) — counts input +
  output + cache-creation + cache-read tokens; exceeding interrupts and fails the run.
- **Daily token limit** (`dailyTokenLimit`) — a global budget per UTC day; once exhausted,
  queued jobs are held (`paused: true` in stats) until rollover.
- **Watchdog** (`maxJobDurationMs` / per-job `maxDurationMs`) — a wall-clock cap against stuck
  CLIs, with a `killGraceMs` wind-down (default 5000 ms) before the run is force-finalized.
- **Retries** — `attempts` on the request: failed (not canceled) runs re-queue until that many
  attempts have been made, delayed by `retryDelayMs` (default 5000 ms), doubled each retry.
  `JobInfo.nextRunAt` says when the next attempt may start.
- **Retention** (`retention.maxAgeMs`) — a periodic sweep prunes terminal jobs; without it the
  in-memory adapter grows unboundedly.

## The live queue stream

Instead of polling, stream the whole queue over `WS /v1/queue/ws`:

```ts
const queueHandle = client.attachQueue()
queueHandle.on('event', (e) => console.log(e.type, e.job.id))
queueHandle.on('stats', (stats) => console.log(stats.running, 'running'))
```

The stream is one-way (server to client): every job's lifecycle as it happens, plus refreshed
stats after lifecycle changes. It has **no replay** — on (re)connect, re-list jobs and treat the
stream as updates. Job mutations stay on REST.

## The QueueAdapter contract

Job state lives behind the `QueueAdapter` interface: `add`, `claimNext`, `get`, `list`,
`update`, `prune`, `addDailyTokens`/`dailyTokens`, and an optional `onWork` wakeup for shared
backends. Two rules matter when implementing one:

- `claimNext()` must be **atomic** across workers — two concurrent claims must never return the
  same job — and must skip queued jobs whose `nextRunAt` is still in the future (retry backoff).
- Daily token counters live in the adapter (keyed by UTC `YYYY-MM-DD`), so budgets hold across
  multiple workers sharing a backend.

The bundled `InMemoryQueueAdapter` is **single-process and non-persistent**: jobs and daily
counters reset on restart. Back the queue with a shared store for anything beyond one trusted
host. Note that `JobQueue` currently assumes the claiming process runs the job — multi-worker
deployments need a claim-lease/heartbeat, and webhook ordering is per-process.
