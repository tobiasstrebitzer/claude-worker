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
export type ListSdkSessionsResponse = { sdkSessions: SdkSessionSummary[] }
export type ErrorResponse = { error: string }
