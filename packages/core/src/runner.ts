import { randomUUID } from 'node:crypto'
import {
  query as sdkQuery,
  type CanUseTool,
  type Options,
  type PermissionResult,
  type Query,
  type SDKMessage,
  type SDKUserMessage,
} from '@anthropic-ai/claude-agent-sdk'
import type {
  CreateSessionRequest,
  PermissionMode,
  PermissionRequest,
  SessionEvent,
  SessionEventBody,
  SessionInfo,
  SessionStatus,
} from '@claude-worker/protocol'
import { InputQueue } from './input-queue.ts'
import { normalizeSdkMessage } from './normalize.ts'

export type QueryFn = (params: {
  prompt: AsyncIterable<SDKUserMessage>
  options?: Options
}) => Query

export type PermissionDecision =
  | { behavior: 'allow'; updatedInput?: Record<string, unknown> }
  | { behavior: 'deny'; message?: string; interrupt?: boolean }

export type SessionRunnerConfig = CreateSessionRequest & {
  /** Injectable query implementation (tests, instrumentation). Defaults to the SDK's query(). */
  queryFn?: QueryFn
  /** Environment for the spawned Claude Code process. Defaults to process.env. */
  env?: Record<string, string | undefined>
  pathToClaudeCodeExecutable?: string
  /** Escape hatch merged last into the SDK Options. */
  extraOptions?: Partial<Options>
  /** Timeout for pending approvals when the request itself doesn't set one. Default 300000. */
  defaultApprovalTimeoutMs?: number
}

export type SessionEventListener = (event: SessionEvent) => void

const DEFAULT_APPROVAL_TIMEOUT_MS = 300_000

type PendingApproval = {
  request: PermissionRequest
  resolve: (result: PermissionResult) => void
  timer: ReturnType<typeof setTimeout>
}

/**
 * One live Agent SDK session: owns the query() call, the streaming input queue, the
 * pending-approval table, and a seq-numbered event log that subscribers can replay.
 * No transport — the server (or any host) subscribes and bridges to the wire.
 */
export class SessionRunner {
  readonly id: string
  readonly createdAt: number

  #config: SessionRunnerConfig
  #events: SessionEvent[] = []
  #listeners = new Set<SessionEventListener>()
  #seq = 0
  #status: SessionStatus = 'starting'
  #statusDetail: string | undefined
  #sdkSessionId: string | undefined
  #model: string | undefined
  #apiKeySource: string | undefined
  #permissionMode: PermissionMode | undefined
  #pending = new Map<string, PendingApproval>()
  #input = new InputQueue()
  #query: Query | undefined
  #started = false
  #closed = false
  #runPromise: Promise<void> | undefined

  constructor(config: SessionRunnerConfig, id: string = randomUUID()) {
    this.#config = config
    this.#permissionMode = config.permissionMode
    this.id = id
    this.createdAt = Date.now()
  }

  get status(): SessionStatus {
    return this.#status
  }

  get sdkSessionId(): string | undefined {
    return this.#sdkSessionId
  }

  get lastSeq(): number {
    return this.#seq
  }

  /** 'oauth' = claude.ai subscription credentials; other values are API-key provenance. */
  get apiKeySource(): string | undefined {
    return this.#apiKeySource
  }

  get pendingApprovals(): PermissionRequest[] {
    return [...this.#pending.values()].map((p) => p.request)
  }

  info(): SessionInfo {
    return {
      id: this.id,
      sdkSessionId: this.#sdkSessionId,
      status: this.#status,
      cwd: this.#config.cwd,
      model: this.#model ?? this.#config.model,
      permissionMode: this.#permissionMode,
      apiKeySource: this.#apiKeySource,
      createdAt: this.createdAt,
      lastSeq: this.#seq,
      pendingPermissionCount: this.#pending.size,
      meta: this.#config.meta,
    }
  }

  /** Begin the session. Idempotent; returns the run promise (resolves when the query ends). */
  start(): Promise<void> {
    if (this.#started) return this.#runPromise!
    this.#started = true
    if (this.#config.prompt) this.sendMessage(this.#config.prompt)
    this.#runPromise = this.#run()
    return this.#runPromise
  }

  /** Queue a user message for the session (starts the next turn when idle). */
  sendMessage(text: string): void {
    if (this.#closed) throw new Error('session is closed')
    this.#input.push({
      type: 'user',
      message: { role: 'user', content: text },
      parent_tool_use_id: null,
      session_id: this.#sdkSessionId,
    })
  }

  /** Resolve a pending permission request. Returns false if the id is unknown (e.g. timed out). */
  resolvePermission(requestId: string, decision: PermissionDecision): boolean {
    const pending = this.#pending.get(requestId)
    if (!pending) return false
    this.#settleApproval(requestId, pending, decision, 'client')
    return true
  }

  async interrupt(): Promise<void> {
    await this.#query?.interrupt()
  }

  async setPermissionMode(mode: PermissionMode): Promise<void> {
    await this.#query?.setPermissionMode(mode)
    this.#permissionMode = mode
  }

  /** Emit a session_error and terminate. For host-enforced policy (e.g. requireApiKey). */
  fail(message: string): void {
    if (this.#closed) return
    this.#emit({ type: 'session_error', message })
    this.#setStatus('failed')
    this.close('error')
  }

  /** Terminate the session and the underlying CLI subprocess. */
  close(reason: 'client' | 'server' | 'error' = 'client'): void {
    if (this.#closed) return
    this.#closed = true
    for (const [id, pending] of this.#pending) {
      this.#settleApproval(id, pending, { behavior: 'deny', message: 'Session closed' }, 'policy')
    }
    this.#input.end()
    this.#query?.close()
    this.#emit({ type: 'session_closed', reason })
    this.#setStatus('closed')
  }

  /**
   * Replay buffered events with seq > afterSeq, then deliver live events.
   * Returns an unsubscribe function.
   */
  subscribe(listener: SessionEventListener, afterSeq = 0): () => void {
    for (const event of this.#events) {
      if (event.seq > afterSeq) listener(event)
    }
    this.#listeners.add(listener)
    return () => this.#listeners.delete(listener)
  }

  async #run(): Promise<void> {
    const queryFn = this.#config.queryFn ?? (sdkQuery as QueryFn)
    try {
      this.#query = queryFn({ prompt: this.#input, options: this.#buildOptions() })
      for await (const message of this.#query) {
        this.#handleMessage(message)
      }
      if (!this.#closed) {
        this.#closed = true
        this.#input.end()
        this.#emit({ type: 'session_closed', reason: 'server' })
        this.#setStatus('closed')
      }
    } catch (error) {
      if (!this.#closed) {
        this.#emit({
          type: 'session_error',
          message: error instanceof Error ? error.message : String(error),
        })
        this.#setStatus('failed')
        this.close('error')
      }
    }
  }

  #buildOptions(): Options {
    const c = this.#config
    const options: Options = {
      cwd: c.cwd,
      permissionMode: c.permissionMode,
      allowedTools: c.allowedTools,
      disallowedTools: c.disallowedTools,
      mcpServers: c.mcpServers as Options['mcpServers'],
      settingSources: c.settingSources,
      model: c.model,
      maxTurns: c.maxTurns,
      maxBudgetUsd: c.maxBudgetUsd,
      resume: c.resume,
      forkSession: c.forkSession,
      includePartialMessages: c.includePartialMessages ?? true,
      canUseTool: this.#canUseTool,
      env: c.env,
      pathToClaudeCodeExecutable: c.pathToClaudeCodeExecutable,
      ...(c.permissionMode === 'bypassPermissions'
        ? { allowDangerouslySkipPermissions: true }
        : {}),
      ...c.extraOptions,
    }
    return options
  }

  #handleMessage(msg: SDKMessage): void {
    if (msg.type === 'system' && msg.subtype === 'init') {
      this.#sdkSessionId = msg.session_id
      this.#model = msg.model
      this.#permissionMode = msg.permissionMode
      this.#apiKeySource = msg.apiKeySource
      this.#emit({
        type: 'system_init',
        sdkSessionId: msg.session_id,
        model: msg.model,
        cwd: msg.cwd,
        apiKeySource: msg.apiKeySource,
        tools: msg.tools,
        skills: msg.skills,
        slashCommands: msg.slash_commands,
        permissionMode: msg.permissionMode,
        claudeCodeVersion: msg.claude_code_version,
        mcpServers: msg.mcp_servers,
      })
      this.#setStatus('running')
      return
    }
    if (msg.type === 'system' && msg.subtype === 'session_state_changed') {
      // Authoritative turn-over signal — but a pending approval outranks it.
      if (this.#pending.size > 0) return
      if (msg.state === 'idle') this.#setStatus('idle')
      else if (msg.state === 'running') this.#setStatus('running')
      return
    }
    const body = normalizeSdkMessage(msg)
    if (body) {
      this.#emit(body)
      // Fallback for SDK versions without session_state_changed.
      if (body.type === 'turn_result' && this.#pending.size === 0) this.#setStatus('idle')
    }
  }

  #canUseTool: CanUseTool = (toolName, input, options) => {
    const id = randomUUID()
    const timeoutMs = this.#config.approvalTimeoutMs ?? this.#config.defaultApprovalTimeoutMs
      ?? DEFAULT_APPROVAL_TIMEOUT_MS
    const request: PermissionRequest = {
      id,
      toolName,
      input,
      toolUseId: options.toolUseID,
      title: options.title,
      displayName: options.displayName,
      description: options.description,
      decisionReason: options.decisionReason,
      agentId: options.agentID,
      expiresAt: Date.now() + timeoutMs,
    }
    return new Promise<PermissionResult>((resolve) => {
      const timer = setTimeout(() => {
        const pending = this.#pending.get(id)
        if (pending) {
          this.#settleApproval(
            id,
            pending,
            { behavior: 'deny', message: 'Approval timed out' },
            'timeout',
          )
        }
      }, timeoutMs)
      this.#pending.set(id, { request, resolve, timer })
      options.signal.addEventListener('abort', () => {
        const pending = this.#pending.get(id)
        if (pending) {
          this.#settleApproval(
            id,
            pending,
            { behavior: 'deny', message: 'Turn aborted' },
            'policy',
          )
        }
      })
      this.#emit({ type: 'permission_requested', request })
      this.#setStatus('awaiting_approval')
    })
  }

  #settleApproval(
    id: string,
    pending: PendingApproval,
    decision: PermissionDecision,
    resolvedBy: 'client' | 'timeout' | 'policy',
  ): void {
    clearTimeout(pending.timer)
    this.#pending.delete(id)
    if (decision.behavior === 'allow') {
      pending.resolve({
        behavior: 'allow',
        updatedInput: decision.updatedInput,
        toolUseID: pending.request.toolUseId,
      })
    } else {
      pending.resolve({
        behavior: 'deny',
        message: decision.message ?? 'Denied',
        interrupt: decision.interrupt,
        toolUseID: pending.request.toolUseId,
      })
    }
    this.#emit({
      type: 'permission_resolved',
      requestId: id,
      behavior: decision.behavior,
      resolvedBy,
      message: decision.behavior === 'deny' ? (decision.message ?? 'Denied') : undefined,
    })
    if (this.#pending.size === 0 && this.#status === 'awaiting_approval') {
      this.#setStatus('running')
    }
  }

  #setStatus(status: SessionStatus, detail?: string): void {
    if (this.#status === status && this.#statusDetail === detail) return
    // Terminal states win.
    if (this.#status === 'closed' || this.#status === 'failed') return
    this.#status = status
    this.#statusDetail = detail
    this.#emit({ type: 'status_changed', status, detail })
  }

  #emit(body: SessionEventBody): void {
    const event: SessionEvent = { ...body, seq: ++this.#seq, ts: Date.now() }
    this.#events.push(event)
    for (const listener of this.#listeners) {
      try {
        listener(event)
      } catch {
        // Listener errors must not break the runner loop.
      }
    }
  }
}
