import type { SandboxVfs } from '@claude-worker/sandbox'

/**
 * Result of one tool execution, whenever it arrives. `failed` is a normal
 * outcome the agent loop adapts to — not an exception.
 */
export type ToolExecutionResult =
  | { status: 'ok'; output: unknown; logs?: string[] }
  | { status: 'failed'; reason: string; error: string; logs?: string[] }

export type ToolExecutionCall = {
  /** Stable, persisted correlation id. Results are matched and applied by it. */
  executionId: string
  sessionId: string
  /** Tool name, e.g. 'eval_script'. */
  tool: string
  /** Validated tool input. */
  input: unknown
  /** Scoped scratch filesystem for this execution's thread. */
  vfs?: SandboxVfs
  limits?: { timeoutMs?: number; memoryLimitBytes?: number }
  signal?: AbortSignal
}

/**
 * Dispatch outcome. `settled` carries the result inline; `pending` means it
 * arrives out-of-band later, keyed by executionId — the shape that lets a
 * deferred or remote executor drop in without touching the runner or protocol.
 */
export type ToolExecutionDispatch =
  | { executionId: string; status: 'settled'; result: ToolExecutionResult }
  | { executionId: string; status: 'pending' }

/**
 * The seam between the agent loop and wherever code actually runs — in-process
 * QuickJS, a browser tab over the WS bridge, or a managed sandbox. Backends are
 * interchangeable and selected by context.
 */
export interface ToolExecutor {
  dispatch(call: ToolExecutionCall): Promise<ToolExecutionDispatch>
}
