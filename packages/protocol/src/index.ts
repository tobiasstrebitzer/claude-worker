/**
 * @claude-worker/protocol — the wire protocol between a claude-worker server and its clients.
 *
 * One session = one ordered stream of {@link SessionEvent}s (each stamped with a monotonically
 * increasing `seq`) plus a small command set ({@link SessionCommand}). Clients attach over
 * WebSocket, optionally replaying from a known `seq`, and drive the session with commands.
 *
 * This package is dependency-free and browser-safe. Anthropic API message content is modeled
 * structurally (see {@link ApiMessage}) so clients don't need the Agent SDK to render transcripts.
 */

/** Bumped on any breaking change to events, commands, or REST shapes. */
export const PROTOCOL_VERSION = 1

// ---------------------------------------------------------------------------
// Session lifecycle
// ---------------------------------------------------------------------------

/**
 * - `starting` — runner spawned, waiting for the SDK init handshake
 * - `running` — a turn is in progress
 * - `awaiting_approval` — blocked on at least one pending permission request
 * - `idle` — between turns; accepting user messages
 * - `failed` — the underlying query errored; terminal
 * - `closed` — closed by a client or the host; terminal
 */
export type SessionStatus =
  | 'starting'
  | 'running'
  | 'awaiting_approval'
  | 'idle'
  | 'failed'
  | 'closed'

export type PermissionMode =
  | 'default'
  | 'acceptEdits'
  | 'bypassPermissions'
  | 'plan'
  | 'dontAsk'
  | 'auto'

// ---------------------------------------------------------------------------
// API message content (structural mirror of Anthropic message shapes)
// ---------------------------------------------------------------------------

export type TextBlock = { type: 'text'; text: string }
export type ThinkingBlock = { type: 'thinking'; thinking: string }
export type ToolUseBlock = { type: 'tool_use'; id: string; name: string; input: unknown }
export type ToolResultBlock = {
  type: 'tool_result'
  tool_use_id: string
  content?: string | Array<{ type: string; text?: string; [key: string]: unknown }>
  is_error?: boolean
}
/** Forward-compatible fallback for block types this protocol version doesn't model. */
export type UnknownBlock = { type: string; [key: string]: unknown }

export type ContentBlock = TextBlock | ThinkingBlock | ToolUseBlock | ToolResultBlock | UnknownBlock

export type ApiMessage = {
  role: 'user' | 'assistant'
  content: string | ContentBlock[]
  model?: string
  stop_reason?: string | null
  /** Per-API-call token usage when the message carries it (assistant messages do).
   * Enables mid-run token accounting; result-message usage stays authoritative. */
  usage?: {
    input_tokens?: number
    output_tokens?: number
    cache_creation_input_tokens?: number
    cache_read_input_tokens?: number
  }
}

// ---------------------------------------------------------------------------
// Permission requests
// ---------------------------------------------------------------------------

/** A tool call promoted into a pending approval by the runner's canUseTool hook. */
export type PermissionRequest = {
  /** Server-assigned id; used by the `permission_decision` command. */
  id: string
  toolName: string
  input: Record<string, unknown>
  toolUseId: string
  /** Full prompt sentence from the SDK, e.g. "Claude wants to read foo.txt". */
  title?: string
  /** Short noun phrase for the tool action, e.g. "Read file". */
  displayName?: string
  /** Human-readable subtitle, e.g. "Claude will have read access to ~/x". */
  description?: string
  /** Why this permission request was triggered. */
  decisionReason?: string
  /** If raised from within a subagent, that subagent's id. */
  agentId?: string
  /** Epoch ms after which the server resolves it via its timeout policy. */
  expiresAt?: number
}

export type PermissionDecisionSource = 'client' | 'timeout' | 'policy'

// ---------------------------------------------------------------------------
// User questions (the AskUserQuestion tool)
// ---------------------------------------------------------------------------

/** One choice of an AskUserQuestion question (SDK tool-input mirror). */
export type UserQuestionOption = {
  label: string
  description?: string
  /** Optional preview content (markdown unless the session configures html)
   * rendered when the option is focused. */
  preview?: string
}

/** One question from the AskUserQuestion tool's input. By the tool's convention the
 * first option is the model's recommended choice. */
export type UserQuestion = {
  question: string
  /** Short chip/tag label (max ~12 chars), e.g. "Auth method". */
  header: string
  options: UserQuestionOption[]
  multiSelect?: boolean
}

/** How a session treats the AskUserQuestion tool:
 * - 'ask' (default) — a pending permission like any other: interactive UIs render the
 *   question form; job webhooks carry the full request so a remote controller can
 *   answer over REST (POST /sessions/:id/permissions/:requestId).
 * - 'auto' — resolved immediately with each question's first (recommended) option.
 * - 'deny' — the tool is refused with guidance to decide autonomously (unattended runs).
 * Answers ride a permission allow as `updatedInput.answers`: question text → chosen
 * option label(s), multi-select labels comma-joined — the shape the CLI's own UI uses. */
export type QuestionBehavior = 'ask' | 'auto' | 'deny'

// ---------------------------------------------------------------------------
// Session capabilities (models / slash commands the CLI reports)
// ---------------------------------------------------------------------------

/** A model the session can switch to (SDK ModelInfo mirror; fields it may grow stay unknown). */
export type ModelOption = {
  /** Model id for createSession.model / set_model. */
  value: string
  displayName: string
  description?: string
}

/** A slash command the CLI accepts as user-message text (SDK SlashCommand mirror). */
export type SlashCommandInfo = {
  /** Command name without the leading slash. */
  name: string
  description?: string
  /** Hint for arguments, e.g. "<file>". */
  argumentHint?: string
  /** Alternate names resolving to this command. */
  aliases?: string[]
}

// ---------------------------------------------------------------------------
// Usage telemetry (context window + subscription rate limits)
// ---------------------------------------------------------------------------

/** One category row from the CLI's context-usage breakdown (system prompt, tools, ...). */
export type ContextUsageCategory = {
  name: string
  tokens: number
  /** Color the CLI assigns the category. Often a CLI theme token name ('inactive',
   * 'promptBorder', ...), not a CSS color — validate before styling with it. */
  color: string
}

/** Context-window usage snapshot (SDK getContextUsage mirror), polled after each turn. */
export type ContextUsage = {
  categories: ContextUsageCategory[]
  totalTokens: number
  maxTokens: number
  /** Used share of the window, 0–100. */
  percentage: number
  /** Model the window sizing applies to. */
  model?: string
}

/**
 * One rate-limit window snapshot (SDK SDKRateLimitInfo mirror). Emitted only for
 * claude.ai subscription sessions — API-key sessions may never produce one, so
 * clients must render nothing (not 0%) until data arrives.
 */
export type RateLimitInfo = {
  /** 'allowed' | 'allowed_warning' | 'rejected' — kept as string, the SDK union may grow. */
  status: string
  /** Which window: 'five_hour' (session), 'seven_day' (weekly), 'seven_day_opus',
   * 'seven_day_sonnet', 'overage', ... — kept as string, the SDK union may grow. */
  rateLimitType?: string
  /** Used share of the window, 0–100. The CLI omits it on some updates — treat
   * absent as unknown, not 0. */
  utilization?: number
  /** Epoch **seconds** when the window resets (render countdowns client-side). */
  resetsAt?: number
  isUsingOverage?: boolean
}

// ---------------------------------------------------------------------------
// Session events (server -> client)
// ---------------------------------------------------------------------------

export type SessionEventBody =
  /** SDK init handshake: what this session actually is. */
  | {
      type: 'system_init'
      sdkSessionId: string
      model: string
      cwd: string
      /** Where the session's Anthropic auth came from: 'oauth' means a claude.ai
       * subscription login; other values ('user' | 'project' | 'org' | 'temporary')
       * are API-key provenance. Kept as string — the SDK union may grow. */
      apiKeySource: string
      tools: string[]
      skills: string[]
      slashCommands: string[]
      permissionMode: PermissionMode
      claudeCodeVersion: string
      mcpServers: Array<{ name: string; status: string }>
    }
  | { type: 'status_changed'; status: SessionStatus; detail?: string }
  /** Models and slash commands available to this session; fetched from the CLI after
   * init. Late attachers get it via replay like any other event. */
  | { type: 'capabilities'; models: ModelOption[]; commands: SlashCommandInfo[] }
  /** The session's model changed via `set_model`. `model` undefined = back to default. */
  | { type: 'model_changed'; model?: string }
  /** The session's permission mode changed via `set_permission_mode`. */
  | { type: 'permission_mode_changed'; mode: PermissionMode }
  /** Context-window usage snapshot; the runner polls it after each turn. */
  | { type: 'context_usage'; usage: ContextUsage }
  /** Subscription rate-limit update for one window (see {@link RateLimitInfo}). */
  | { type: 'rate_limit'; info: RateLimitInfo }
  | {
      type: 'assistant_message'
      message: ApiMessage
      /** Set when the message was produced inside a subagent (Task tool). */
      parentToolUseId: string | null
      /** True when backfilled from a resumed session's history. */
      replay?: boolean
      uuid: string
    }
  | {
      type: 'user_message'
      message: ApiMessage
      parentToolUseId: string | null
      /** True when replayed from a resumed session's history. */
      replay?: boolean
      /** True for tool results and other synthetic user-role messages. */
      synthetic?: boolean
      uuid?: string
    }
  /** Raw Anthropic streaming event (message_start/content_block_delta/...); emitted only
   * when the session was created with `includePartialMessages`. */
  | {
      type: 'stream_delta'
      event: { type: string; [key: string]: unknown }
      parentToolUseId: string | null
      uuid: string
    }
  | {
      type: 'turn_result'
      subtype:
        | 'success'
        | 'error_during_execution'
        | 'error_max_turns'
        | 'error_max_budget_usd'
        | 'error_max_structured_output_retries'
      isError: boolean
      durationMs: number
      numTurns: number
      totalCostUsd: number
      /** Final text of the turn (success only). */
      result?: string
      errors?: string[]
      usage?: unknown
    }
  | { type: 'permission_requested'; request: PermissionRequest }
  | {
      type: 'permission_resolved'
      requestId: string
      behavior: 'allow' | 'deny'
      resolvedBy: PermissionDecisionSource
      /** Denial message, when denied. */
      message?: string
    }
  /** Any SDKMessage this protocol version doesn't model first-class (task progress,
   * compaction boundaries, auth status, ...). Payload is the raw SDK message. */
  | { type: 'sdk_event'; payload: { type: string; [key: string]: unknown } }
  | { type: 'session_error'; message: string }
  | { type: 'session_closed'; reason: 'client' | 'server' | 'error' }

export type SessionEvent = SessionEventBody & {
  /** Monotonic per-session sequence number, starting at 1. */
  seq: number
  /** Epoch ms when the server emitted the event. */
  ts: number
}

// ---------------------------------------------------------------------------
// Commands (client -> server)
// ---------------------------------------------------------------------------

export type SessionCommand =
  | { type: 'user_message'; text: string }
  | {
      type: 'permission_decision'
      requestId: string
      behavior: 'allow' | 'deny'
      /** allow only: modified tool input to run instead of the original. */
      updatedInput?: Record<string, unknown>
      /** deny only: reason surfaced to the model. */
      message?: string
      /** deny only: also interrupt the running turn. */
      interrupt?: boolean
    }
  | { type: 'interrupt' }
  | { type: 'set_permission_mode'; mode: PermissionMode }
  /** Switch the model for subsequent responses; omit `model` for the default. */
  | { type: 'set_model'; model?: string }
  | { type: 'close' }

// ---------------------------------------------------------------------------
// WebSocket frames
// ---------------------------------------------------------------------------

/** First frame the server sends after a successful attach. */
export type AttachedFrame = {
  type: 'attached'
  protocolVersion: number
  session: SessionInfo
  /** Events with seq > the client's `afterSeq` follow as `event` frames. */
  replayingFrom: number
}

export type ServerFrame =
  | AttachedFrame
  | { type: 'event'; event: SessionEvent }
  | { type: 'protocol_error'; message: string }

export type ClientFrame = SessionCommand

// ---------------------------------------------------------------------------
// REST shapes
// ---------------------------------------------------------------------------

export type McpServerConfigWire =
  | { type?: 'stdio'; command: string; args?: string[]; env?: Record<string, string> }
  | { type: 'http'; url: string; headers?: Record<string, string> }
  | { type: 'sse'; url: string; headers?: Record<string, string> }

export type CreateSessionRequest = {
  /** Directory the session is rooted at. Required: `cwd` is per-query in the SDK
   * and the server re-pins it on every call. */
  cwd: string
  /** Optional initial prompt (may be a skill invocation like "/verify-content 123"). */
  prompt?: string
  permissionMode?: PermissionMode
  allowedTools?: string[]
  disallowedTools?: string[]
  mcpServers?: Record<string, McpServerConfigWire>
  /** Which filesystem settings the session loads. Include 'project' to pick up the
   * target repo's skills and CLAUDE.md ("close-to-real" fidelity). */
  settingSources?: Array<'user' | 'project' | 'local'>
  model?: string
  maxTurns?: number
  maxBudgetUsd?: number
  /** Resume an existing SDK session by id. */
  resume?: string
  /** With `resume`: fork to a new session id instead of continuing. */
  forkSession?: boolean
  /** Emit `stream_delta` events for token-by-token rendering. Default true. */
  includePartialMessages?: boolean
  /** Per-session override of the server's permission-request timeout (ms). */
  approvalTimeoutMs?: number
  /** AskUserQuestion handling (see {@link QuestionBehavior}). Default 'ask'. */
  questionBehavior?: QuestionBehavior
  /** Free-form metadata echoed back on SessionInfo (host app bookkeeping). */
  meta?: Record<string, unknown>
}

export type SessionInfo = {
  /** Server-assigned id (stable across SDK session forks/resumes). */
  id: string
  /** Underlying Agent SDK session id, once known; use for `resume`. */
  sdkSessionId?: string
  status: SessionStatus
  cwd: string
  model?: string
  permissionMode?: PermissionMode
  /** See the `system_init` event; 'oauth' = claude.ai subscription credentials. */
  apiKeySource?: string
  createdAt: number
  /** Highest event seq emitted so far; attach with `afterSeq` to catch up. */
  lastSeq: number
  pendingPermissionCount: number
  meta?: Record<string, unknown>
  /** Display title: `meta.title` if the host set one, else derived (e.g. first prompt). */
  title?: string
  /** Cumulative cost across all turns so far (sum of turn_result totals). */
  totalCostUsd?: number
  /** Cumulative turn count across the session. */
  numTurns?: number
  /** Epoch ms of the most recent emitted event. */
  lastActivityAt?: number
}

/**
 * A session in the Agent SDK's on-disk store (independent of this server's registry).
 * Listed so hosts can offer "resume" across server restarts: feed `sessionId` to
 * CreateSessionRequest.resume. Mirrors the SDK's SDKSessionInfo, kept browser-safe.
 */
export type SdkSessionSummary = {
  sessionId: string
  /** Custom title, auto summary, or first prompt — whichever the SDK has. */
  summary: string
  /** Epoch ms of last modification. */
  lastModified: number
  createdAt?: number
  customTitle?: string
  firstPrompt?: string
  gitBranch?: string
  cwd?: string
}

export type ListSessionsResponse = { sessions: SessionInfo[] }
export type CreateSessionResponse = { session: SessionInfo }
export type GetSessionResponse = { session: SessionInfo }

/** Body of `POST {basePath}/sessions/:id/permissions/:requestId` — the REST counterpart
 * of the WS `permission_decision` command, for remote controllers without a socket
 * (e.g. answering a job's AskUserQuestion from a webhook consumer). 404 = the request
 * is unknown, already resolved, or expired. */
export type ResolvePermissionRequest =
  | { behavior: 'allow'; updatedInput?: Record<string, unknown> }
  | { behavior: 'deny'; message?: string; interrupt?: boolean }
export type ResolvePermissionResponse = { resolved: true }
export type ListSdkSessionsResponse = { sdkSessions: SdkSessionSummary[] }
export type ErrorResponse = { error: string }

// ---------------------------------------------------------------------------
// Job queue (one-shot scheduled runs over the session runner)
// ---------------------------------------------------------------------------

/**
 * - `queued` — accepted, waiting for a concurrency slot (or the daily token budget)
 * - `running` — a session is executing the prompt
 * - `succeeded` / `failed` — terminal; `result` (and `error` on failure) are set
 * - `canceled` — terminal; canceled by a client before or during the run
 */
export type JobStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'canceled'

/** Where job progress/completion deliveries are POSTed (JSON body = {@link JobEvent}). */
export type WebhookConfig = {
  url: string
  /** Extra headers sent with every delivery (auth tokens etc.). */
  headers?: Record<string, string>
  /** Delivery granularity: 'messages' also POSTs job_progress per assistant message /
   * permission request; 'completion' only job_started + job_completed. Default 'messages'. */
  progress?: 'messages' | 'completion'
}

/**
 * Schedule a one-shot run: the session executes `prompt` unattended and the job
 * completes with that run's result. `session.prompt` is the task and is required;
 * `resume`/`forkSession` are not supported for queued jobs.
 */
export type CreateJobRequest = {
  session: CreateSessionRequest & { prompt: string }
  webhook?: WebhookConfig
  /** Per-job token cap; the effective cap is min(this, the server's sessionTokenLimit). */
  maxTokens?: number
  /** Per-job wall-clock cap; the effective cap is min(this, the server's maxJobDurationMs). */
  maxDurationMs?: number
  /** Total run attempts: failed (not canceled) runs re-queue until this many attempts
   * have been made. Default 1 (no retries). */
  attempts?: number
  /** Delay before the first retry, doubled for each subsequent one. Default 5000. */
  retryDelayMs?: number
  /** Host bookkeeping echoed back on JobInfo. */
  meta?: Record<string, unknown>
}

/** Cumulative resource usage of a job's run. `tokens` counts input + output +
 * cache-creation + cache-read tokens across all turns. */
export type JobUsage = {
  tokens: number
  totalCostUsd: number
  numTurns: number
}

/** Terminal outcome of the job's run (mirrors the final turn_result). */
export type JobResult = {
  subtype: string
  isError: boolean
  /** Final text of the run (success only). */
  result?: string
  errors?: string[]
  durationMs: number
}

export type JobInfo = {
  id: string
  status: JobStatus
  cwd: string
  prompt: string
  /** Server session id once started — attach via the sessions WS to watch the run live. */
  sessionId?: string
  sdkSessionId?: string
  createdAt: number
  startedAt?: number
  finishedAt?: number
  /** 1-based run attempt this info reflects. */
  attempt?: number
  /** Total attempts configured on the request (see CreateJobRequest.attempts). */
  maxAttempts?: number
  /** For a job re-queued by retry backoff: earliest time the next attempt may start. */
  nextRunAt?: number
  /** Cumulative across attempts. */
  usage: JobUsage
  result?: JobResult
  /** Failure or cancellation reason (for a queued retry: the previous attempt's error). */
  error?: string
  meta?: Record<string, unknown>
}

/** Latest mid-run activity, carried on job_progress deliveries. */
export type JobProgress = {
  kind: 'assistant_text' | 'tool_use' | 'permission_requested' | 'permission_resolved'
  /** Short human-readable preview (message excerpt, tool name, permission title). */
  preview?: string
  /** 'permission_requested' only: the full request (including AskUserQuestion input) so
   * webhook consumers can answer via POST /sessions/:sessionId/permissions/:requestId. */
  request?: PermissionRequest
}

/** Webhook delivery payload (also the queue's local event shape). `job_submitted` goes
 * to local observers and the queue WS only — the submitter already has the POST
 * response, so webhooks start at `job_started`. `job_retrying` marks a failed run that
 * was re-queued (`job.nextRunAt` says when); `job_completed` is always terminal. */
export type JobEvent =
  | { type: 'job_submitted'; job: JobInfo; ts: number }
  | { type: 'job_started'; job: JobInfo; ts: number }
  | { type: 'job_progress'; job: JobInfo; progress: JobProgress; ts: number }
  | { type: 'job_retrying'; job: JobInfo; ts: number }
  | { type: 'job_completed'; job: JobInfo; ts: number }

export type QueueStats = {
  maxConcurrency: number
  running: number
  queued: number
  sessionTokenLimit?: number
  dailyTokenLimit?: number
  /** Tokens consumed by queue jobs in the current UTC day. */
  dailyTokensUsed: number
  /** True when the daily budget is exhausted and queued jobs are being held. */
  paused: boolean
}

/** Frames sent on the queue WS (`{basePath}/queue/ws`). The stream is one-way
 * (server→client): every job's lifecycle as it happens, plus refreshed stats after
 * lifecycle changes. Clients send nothing; job mutations stay on REST. */
export type QueueServerFrame =
  | { type: 'queue_attached'; protocolVersion: number; stats: QueueStats }
  | { type: 'job_event'; event: JobEvent }
  | { type: 'queue_stats'; stats: QueueStats }

export type CreateJobResponse = { job: JobInfo }
export type GetJobResponse = { job: JobInfo }
export type ListJobsResponse = { jobs: JobInfo[] }
export type QueueStatsResponse = { stats: QueueStats }
