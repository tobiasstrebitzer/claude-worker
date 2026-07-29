import type {
  PermissionMode,
  PermissionRequest,
  SessionEvent,
  SessionInfo,
} from '@claude-worker/protocol'

export type SessionEventListener = (event: SessionEvent) => void

export type PermissionDecision =
  | { behavior: 'allow'; updatedInput?: Record<string, unknown> }
  | { behavior: 'deny'; message?: string; interrupt?: boolean }

/**
 * Engine-independent runner surface — exactly what the server and queue consume.
 * `SessionRunner` (Claude / Agent SDK) implements it today; additional engines
 * implement the same contract and are selected behind it. Engine-specific
 * machinery (SDK options, approval callbacks, input-queue shapes) stays inside
 * the implementations.
 */
export interface Runner {
  readonly id: string
  readonly pendingApprovals: PermissionRequest[]
  /** Begin the session. Idempotent; returns the run promise (resolves when the run ends). */
  start(): Promise<void>
  info(): SessionInfo
  /** Replay buffered events with seq > afterSeq, then deliver live events. Returns unsubscribe. */
  subscribe(listener: SessionEventListener, afterSeq?: number): () => void
  /** Queue a user message for the session (starts the next turn when idle). */
  sendMessage(text: string): void
  /** Resolve a pending permission request. Returns false if the id is unknown (e.g. timed out). */
  resolvePermission(requestId: string, decision: PermissionDecision): boolean
  interrupt(): Promise<void>
  setPermissionMode(mode: PermissionMode): Promise<void>
  /** Switch the model for subsequent responses; undefined = back to the default. */
  setModel(model?: string): Promise<void>
  /** Emit a session_error and terminate. For host-enforced policy (e.g. requireApiKey). */
  fail(message: string): void
  /** Terminate the session and any underlying engine process. */
  close(reason?: 'client' | 'server' | 'error'): void
}
