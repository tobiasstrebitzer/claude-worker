import { randomUUID } from 'node:crypto'
import type { SessionRunner, SessionRunnerConfig } from '@claude-worker/core'
import type {
  ApiMessage,
  CreateJobRequest,
  CreateSessionRequest,
  JobEvent,
  JobInfo,
  JobProgress,
  QueueStats,
  SessionEvent,
} from '@claude-worker/protocol'
import { InMemoryQueueAdapter, type JobRecord, type QueueAdapter } from './adapter.ts'

export type JobQueueOptions = {
  /** Turn a session config into a live runner — typically the server registry's create(),
   * so job sessions are ordinary sessions clients can attach to and watch. */
  createRunner: (config: SessionRunnerConfig) => SessionRunner
  /** Storage/claiming backend. Defaults to the in-memory adapter (single process). */
  adapter?: QueueAdapter
  /** Concurrent job sessions. Default 1. */
  maxConcurrency?: number
  /** Token cap per job session; exceeding it interrupts the run and fails the job. */
  sessionTokenLimit?: number
  /** Global token budget per UTC day; when exhausted, queued jobs are held until the
   * day rolls over (running jobs finish and are accounted). */
  dailyTokenLimit?: number
  /** Patch job session configs (inject queryFn, env, tool policy) before they run. */
  buildRunnerConfig?: (req: CreateSessionRequest) => SessionRunnerConfig
  /** Webhook transport. Defaults to global fetch. */
  fetchImpl?: typeof fetch
  /** Webhook delivery attempts per event (exponential backoff). Default 3. */
  webhookAttempts?: number
  /** Initial backoff between webhook attempts. Default 500ms. */
  webhookRetryDelayMs?: number
  /** Local observer invoked for every job event (in addition to any webhook). */
  onEvent?: (event: JobEvent) => void
}

type RunningJob = {
  record: JobRecord
  runner: SessionRunner
  unsubscribe: () => void
  /** Mid-run token estimate from assistant-message usage (enforcement + progress). */
  estimatedTokens: number
  /** Set when the queue killed the run (limits, cancel) — decides the terminal status. */
  killReason?: string
  canceled: boolean
  finalized: boolean
  /** Per-job webhook chain so deliveries stay ordered. */
  deliveries: Promise<void>
}

const dayKey = (epochMs: number): string => new Date(epochMs).toISOString().slice(0, 10)

const sumUsage = (usage: unknown): number => {
  if (typeof usage !== 'object' || usage === null) return 0
  const u = usage as Record<string, unknown>
  return (
    (typeof u.input_tokens === 'number' ? u.input_tokens : 0) +
    (typeof u.output_tokens === 'number' ? u.output_tokens : 0) +
    (typeof u.cache_creation_input_tokens === 'number' ? u.cache_creation_input_tokens : 0) +
    (typeof u.cache_read_input_tokens === 'number' ? u.cache_read_input_tokens : 0)
  )
}

const textPreview = (message: ApiMessage, max = 140): JobProgress | null => {
  const blocks = typeof message.content === 'string'
    ? [{ type: 'text', text: message.content }]
    : message.content
  for (const block of blocks) {
    if (block.type === 'tool_use') {
      return { kind: 'tool_use', preview: (block as { name?: string }).name }
    }
    if (block.type === 'text') {
      const text = (block as { text?: string }).text ?? ''
      if (text.trim()) {
        return {
          kind: 'assistant_text',
          preview: text.length > max ? text.slice(0, max - 1) + '…' : text,
        }
      }
    }
  }
  return null
}

/**
 * One-shot job execution over the session runner: submitted jobs run `session.prompt`
 * unattended, bounded by `maxConcurrency` and token budgets, and report progress and
 * completion through webhooks (plus `onEvent` locally). Job state lives in the
 * {@link QueueAdapter}; this class owns scheduling and the live runs.
 */
export class JobQueue {
  #options: JobQueueOptions
  #adapter: QueueAdapter
  #running = new Map<string, RunningJob>()
  #pumping = false
  #closed = false
  #offWork: (() => void) | undefined

  constructor(options: JobQueueOptions) {
    this.#options = options
    this.#adapter = options.adapter ?? new InMemoryQueueAdapter()
    this.#offWork = this.#adapter.onWork?.(() => void this.#pump())
  }

  async submit(request: CreateJobRequest): Promise<JobInfo> {
    if (this.#closed) throw new Error('queue is closed')
    if (!request.session?.prompt?.trim()) throw new Error('session.prompt is required')
    if (!request.session.cwd) throw new Error('session.cwd is required')
    if (request.session.resume || request.session.forkSession) {
      throw new Error('resume/forkSession are not supported for queued jobs')
    }
    const info: JobInfo = {
      id: randomUUID(),
      status: 'queued',
      cwd: request.session.cwd,
      prompt: request.session.prompt,
      createdAt: Date.now(),
      usage: { tokens: 0, totalCostUsd: 0, numTurns: 0 },
      meta: request.meta,
    }
    await this.#adapter.add({ info, request })
    void this.#pump()
    return info
  }

  async get(id: string): Promise<JobInfo | null> {
    return (await this.#adapter.get(id))?.info ?? null
  }

  async list(): Promise<JobInfo[]> {
    return (await this.#adapter.list()).map((j) => j.info)
  }

  /** Cancel a queued or running job. Returns the job, or null if unknown. */
  async cancel(id: string): Promise<JobInfo | null> {
    const record = await this.#adapter.get(id)
    if (!record) return null
    const running = this.#running.get(id)
    if (running) {
      running.canceled = true
      running.killReason = 'canceled'
      await this.#finalize(running, {
        usage: { ...running.record.info.usage, tokens: running.estimatedTokens },
        status: 'canceled',
        error: 'canceled',
      })
      return running.record.info
    }
    if (record.info.status !== 'queued') return record.info
    const updated = await this.#adapter.update(id, {
      status: 'canceled',
      finishedAt: Date.now(),
      error: 'canceled',
    })
    if (updated) this.#emit(updated, { type: 'job_completed', job: updated.info, ts: Date.now() })
    return updated?.info ?? null
  }

  async stats(): Promise<QueueStats> {
    const jobs = await this.#adapter.list()
    const dailyTokensUsed = await this.#adapter.dailyTokens(dayKey(Date.now()))
    const dailyTokenLimit = this.#options.dailyTokenLimit
    return {
      maxConcurrency: this.#options.maxConcurrency ?? 1,
      running: this.#running.size,
      queued: jobs.filter((j) => j.info.status === 'queued').length,
      sessionTokenLimit: this.#options.sessionTokenLimit,
      dailyTokenLimit,
      dailyTokensUsed,
      paused: dailyTokenLimit !== undefined && dailyTokensUsed >= dailyTokenLimit,
    }
  }

  /** Stop scheduling new jobs. Running jobs keep finalizing (e.g. when the host closes
   * their sessions); job state stays in the adapter. */
  close(): void {
    this.#closed = true
    this.#offWork?.()
  }

  async #pump(): Promise<void> {
    if (this.#pumping || this.#closed) return
    this.#pumping = true
    try {
      const maxConcurrency = this.#options.maxConcurrency ?? 1
      while (this.#running.size < maxConcurrency) {
        const limit = this.#options.dailyTokenLimit
        if (limit !== undefined && (await this.#adapter.dailyTokens(dayKey(Date.now()))) >= limit) {
          return
        }
        const record = await this.#adapter.claimNext()
        if (!record) return
        await this.#start(record)
      }
    } finally {
      this.#pumping = false
    }
  }

  async #start(record: JobRecord): Promise<void> {
    const id = record.info.id
    const build = this.#options.buildRunnerConfig ?? ((req: CreateSessionRequest) => req)
    let runner: SessionRunner
    try {
      runner = this.#options.createRunner(build(record.request.session))
    } catch (error) {
      const failed = await this.#adapter.update(id, {
        status: 'failed',
        finishedAt: Date.now(),
        error: error instanceof Error ? error.message : String(error),
      })
      if (failed) this.#emit(failed, { type: 'job_completed', job: failed.info, ts: Date.now() })
      return
    }
    const job: RunningJob = {
      record,
      runner,
      unsubscribe: () => {},
      estimatedTokens: 0,
      canceled: false,
      finalized: false,
      deliveries: Promise.resolve(),
    }
    this.#running.set(id, job)
    const updated = await this.#adapter.update(id, {
      startedAt: Date.now(),
      sessionId: runner.id,
    })
    if (updated) job.record = updated
    this.#emit(job.record, { type: 'job_started', job: job.record.info, ts: Date.now() })
    job.unsubscribe = runner.subscribe((event) => void this.#handleEvent(job, event))
  }

  async #handleEvent(job: RunningJob, event: SessionEvent): Promise<void> {
    if (job.finalized) return
    switch (event.type) {
      case 'system_init':
        await this.#adapter.update(job.record.info.id, { sdkSessionId: event.sdkSessionId })
        return
      case 'assistant_message': {
        if (event.replay) return
        job.estimatedTokens += sumUsage(event.message.usage)
        const limit = this.#effectiveTokenLimit(job.record.request)
        if (limit !== undefined && job.estimatedTokens > limit && !job.killReason) {
          job.killReason = `session token limit exceeded (${job.estimatedTokens} > ${limit})`
          void job.runner.interrupt().catch(() => {})
        }
        const progress = textPreview(event.message)
        if (progress) this.#progress(job, progress)
        return
      }
      case 'permission_requested':
        this.#progress(job, {
          kind: 'permission_requested',
          preview: event.request.title ?? event.request.toolName,
        })
        return
      case 'permission_resolved':
        this.#progress(job, { kind: 'permission_resolved', preview: event.behavior })
        return
      case 'turn_result': {
        // One job = one unattended run: the first result is the outcome.
        const tokens = sumUsage(event.usage) || job.estimatedTokens
        await this.#finalize(job, {
          usage: {
            tokens,
            totalCostUsd: event.totalCostUsd,
            numTurns: event.numTurns,
          },
          result: {
            subtype: event.subtype,
            isError: event.isError,
            result: event.result,
            errors: event.errors,
            durationMs: event.durationMs,
          },
          status: job.killReason
            ? (job.canceled ? 'canceled' : 'failed')
            : event.isError
              ? 'failed'
              : 'succeeded',
          error: job.killReason ?? (event.isError ? (event.errors?.join('; ') || event.subtype) : undefined),
        })
        return
      }
      case 'session_error':
        await this.#finalize(job, {
          usage: { ...job.record.info.usage, tokens: job.estimatedTokens },
          status: job.canceled ? 'canceled' : 'failed',
          error: job.killReason ?? event.message,
        })
        return
      case 'session_closed':
        await this.#finalize(job, {
          usage: { ...job.record.info.usage, tokens: job.estimatedTokens },
          status: job.canceled ? 'canceled' : 'failed',
          error: job.killReason ?? 'session closed before completing',
        })
        return
      default:
        return
    }
  }

  #effectiveTokenLimit(request: CreateJobRequest): number | undefined {
    const limits = [request.maxTokens, this.#options.sessionTokenLimit].filter(
      (n): n is number => typeof n === 'number',
    )
    return limits.length > 0 ? Math.min(...limits) : undefined
  }

  async #finalize(job: RunningJob, patch: Partial<JobInfo>): Promise<void> {
    if (job.finalized) return
    job.finalized = true
    job.unsubscribe()
    this.#running.delete(job.record.info.id)
    job.runner.close('server')
    const tokens = patch.usage?.tokens ?? 0
    if (tokens > 0) await this.#adapter.addDailyTokens(dayKey(Date.now()), tokens)
    const updated = await this.#adapter.update(job.record.info.id, {
      ...patch,
      finishedAt: Date.now(),
    })
    if (updated) {
      job.record = updated
      // Pass the job so the completion webhook stays ordered behind its progress
      // deliveries (the running-map entry is already gone).
      this.#emit(job.record, { type: 'job_completed', job: updated.info, ts: Date.now() }, job)
    }
    void this.#pump()
  }

  #progress(job: RunningJob, progress: JobProgress): void {
    const event: JobEvent = { type: 'job_progress', job: job.record.info, progress, ts: Date.now() }
    // 'completion' granularity: local observers still see progress; the webhook doesn't.
    if (job.record.request.webhook?.progress === 'completion') {
      try {
        this.#options.onEvent?.(event)
      } catch {
        // observer errors must not break the queue
      }
      return
    }
    this.#emit(job.record, event, job)
  }

  /** Notify the local observer and, when configured, the job's webhook (ordered per job). */
  #emit(record: JobRecord, event: JobEvent, chainOwner?: RunningJob): void {
    try {
      this.#options.onEvent?.(event)
    } catch {
      // observer errors must not break the queue
    }
    const webhook = record.request.webhook
    if (!webhook) return
    const running = chainOwner ?? this.#running.get(record.info.id)
    const deliver = () => this.#deliver(webhook.url, webhook.headers, event)
    if (running) running.deliveries = running.deliveries.then(deliver)
    else void deliver()
  }

  async #deliver(
    url: string,
    headers: Record<string, string> | undefined,
    event: JobEvent,
  ): Promise<void> {
    const fetchImpl = this.#options.fetchImpl ?? fetch
    const attempts = this.#options.webhookAttempts ?? 3
    const baseDelay = this.#options.webhookRetryDelayMs ?? 500
    for (let attempt = 0; attempt < attempts; attempt++) {
      try {
        const res = await fetchImpl(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...headers },
          body: JSON.stringify(event),
        })
        if (res.ok) return
      } catch {
        // network error — retry below
      }
      if (attempt < attempts - 1) {
        await new Promise((resolve) => setTimeout(resolve, baseDelay * 2 ** attempt))
      }
    }
    // Deliveries are best-effort; clients can always poll GET /jobs/:id.
  }
}
