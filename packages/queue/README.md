# @claude-worker/queue

Job queue over the claude-worker session runner: remote services schedule one-shot runs; the queue
executes them as ordinary sessions with bounded concurrency and token budgets, delivering progress
and completion via webhooks. Pluggable adapter interface — in-memory bundled; redis/bullmq/pubsub
adapters can implement the same contract.

Part of [claude-worker](https://github.com/tobiasstrebitzer/claude-worker). It runs jobs through
[`@claude-worker/core`](https://www.npmjs.com/package/@claude-worker/core)'s `SessionRunner` and is
usually consumed indirectly: pass the `queue` option to
[`@claude-worker/server`](https://www.npmjs.com/package/@claude-worker/server) and it mounts
`/jobs` + `/queue` REST routes plus a `/queue/ws` live stream, with
[`@claude-worker/client`](https://www.npmjs.com/package/@claude-worker/client) as the caller.
Use this package directly to embed the queue in a custom host or to write a shared-backend adapter.

## Install

```bash
npm install @claude-worker/queue
```

## Usage

A job is **one unattended run**: the session executes `session.prompt`, the first turn result
completes the job (result, cumulative usage, cost), and the session is closed.

```ts
import { JobQueue } from '@claude-worker/queue'
import { SessionRunner } from '@claude-worker/core'

const queue = new JobQueue({
  // Typically the server registry's create(), so job sessions are ordinary
  // sessions clients can attach to and watch.
  createRunner: (config) => new SessionRunner(config),
  maxConcurrency: 2,
  sessionTokenLimit: 200_000,          // per-job cap (input+output+cache); exceeding kills the run
  dailyTokenLimit: 2_000_000,          // global UTC-day budget; queued jobs held once exhausted
  maxJobDurationMs: 1_800_000,         // wall-clock watchdog for stuck CLIs
  retention: { maxAgeMs: 86_400_000 }, // expire terminal jobs
})

const job = await queue.submit({
  session: { cwd: '/srv/checkout', prompt: '/verify-content 42' },
  webhook: { url: 'https://my-app.test/hooks/claude', headers: { authorization: '…' } },
  attempts: 3, // failed (not canceled) runs re-queue with exponential backoff
})
// job_submitted → job_started → job_progress → job_retrying? → job_completed
// arrive at the webhook (ordered per job, delivery retried with backoff).

await queue.get(job.id)   // JobInfo | null
await queue.stats()       // { running, queued, dailyTokensUsed, paused, … }
await queue.cancel(job.id)
queue.close()             // stop scheduling; job state stays in the adapter
```

### The `QueueAdapter` contract

Job state lives behind the `QueueAdapter` interface: `add`, `claimNext`, `get`, `list`, `update`,
`prune`, `addDailyTokens`/`dailyTokens`, and an optional `onWork` wakeup for shared backends.
Two rules matter when implementing one:

- `claimNext()` must be **atomic** across workers — two concurrent claims must never return the
  same job — and must skip queued jobs whose `nextRunAt` is still in the future (retry backoff).
- Daily token counters live in the adapter (keyed by UTC `YYYY-MM-DD`), so budgets hold across
  multiple workers sharing a backend.

The bundled `InMemoryQueueAdapter` is single-process and non-persistent: jobs and daily counters
reset on restart. Back the queue with a shared store for anything beyond one trusted host.

## Options at a glance

| Option | Default | Effect |
| --- | --- | --- |
| `maxConcurrency` | 1 | Concurrent job sessions. |
| `sessionTokenLimit` | off | Token cap per job run; exceeding interrupts and fails the job. |
| `dailyTokenLimit` | off | Global budget per UTC day; queued jobs held until rollover. |
| `maxJobDurationMs` | off | Wall-clock cap per run — the watchdog for stuck CLIs. |
| `killGraceMs` | 5000 | Wind-down after a kill before the run is force-finalized. |
| `retention` | keep forever | Prune terminal jobs older than `maxAgeMs` (periodic sweep). |
| `webhookAttempts` / `webhookRetryDelayMs` | 3 / 500ms | Delivery retries per event, exponential backoff. |
| `buildRunnerConfig` | identity | Patch job session configs (env, tool policy) before they run. |
| `onEvent` | — | Local observer for every `JobEvent`, in addition to any webhook. |

Per-request, `CreateJobRequest` adds `attempts`, `retryDelayMs`, `maxTokens`, `maxDurationMs`
(the stricter of request and queue limits wins), `webhook.progress: 'completion'` to quiet
progress deliveries, and free-form `meta`.

## License

MIT © Tobias Strebitzer — see
[LICENSE](https://github.com/tobiasstrebitzer/claude-worker/blob/master/LICENSE).
