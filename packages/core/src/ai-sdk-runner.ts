import { randomUUID } from 'node:crypto'
import {
  ToolLoopAgent,
  isStepCount,
  type LanguageModel,
  type ModelMessage,
  type ToolSet,
} from 'ai'
import type {
  ContentBlock,
  CreateSessionRequest,
  PermissionMode,
  PermissionRequest,
  SessionEvent,
  SessionEventBody,
  SessionInfo,
  SessionStatus,
} from '@claude-worker/protocol'
import type { PermissionDecision, Runner, SessionEventListener } from './runner-interface.ts'

/** Permission modes this engine can honor. The rest of the protocol vocabulary
 * (acceptEdits/plan/auto) is Claude Code CLI semantics with no meaning here —
 * setPermissionMode rejects them, which the server surfaces as protocol_error. */
const SUPPORTED_PERMISSION_MODES: readonly PermissionMode[] = ['default', 'bypassPermissions', 'dontAsk']

/** `cwd` is optional for this engine: the loop has no host-filesystem coupling
 * (tools get scoped VFS handles instead). Defaults to process.cwd() for display. */
export type AiSdkRunnerConfig = Omit<CreateSessionRequest, 'cwd'> & {
  cwd?: string
  /** AI SDK language model instance (or gateway model id string). Provider
   * resolution from profiles happens host-side; core takes the resolved model. */
  languageModel: LanguageModel
  /** Tools available to the loop. Tools WITHOUT `execute` halt the loop when
   * called; their calls surface via `pendingToolCalls` and are answered with
   * `resolveToolCall()`, which re-enters the loop by message-state replay. */
  tools?: ToolSet
  /** System prompt (AI SDK v7 `instructions`). */
  instructions?: string
  /** Max loop steps per turn. Default 20. */
  maxSteps?: number
  /** Swap models mid-session (`set_model`). Unset = setModel() is rejected. */
  resolveModel?: (modelId: string | undefined) => LanguageModel
}

/** An external (execute-less) tool call the loop is parked on. */
export type PendingToolCall = {
  toolCallId: string
  toolName: string
  input: unknown
}

export type ToolCallOutput =
  | { type: 'text'; value: string }
  | { type: 'json'; value: unknown }

type AssistantPart = {
  type: string
  text?: string
  toolCallId?: string
  toolName?: string
  input?: unknown
  output?: { type: string; value?: unknown; reason?: string }
  [key: string]: unknown
}

/**
 * Model-agnostic runner over the AI SDK v7 ToolLoopAgent. The session's durable
 * state is its ModelMessage history: every turn — including continuation after an
 * externally-executed tool call — is a fresh generate() over that history
 * (message-state replay; the loop cannot be suspended). Emits the same
 * seq-numbered SessionEvent log as SessionRunner; engine-specific CLI telemetry
 * (system_init, capabilities, rate_limit, ...) is simply never emitted.
 */
export class AiSdkRunner implements Runner {
  readonly id: string
  readonly createdAt: number

  #config: AiSdkRunnerConfig
  #model: LanguageModel
  #events: SessionEvent[] = []
  #listeners = new Set<SessionEventListener>()
  #seq = 0
  #status: SessionStatus = 'starting'
  #permissionMode: PermissionMode
  #messages: ModelMessage[] = []
  #pendingToolCalls = new Map<string, PendingToolCall>()
  #turnChain: Promise<void> = Promise.resolve()
  #abort: AbortController | undefined
  /** Accumulates across every leg of one turn. A turn that parks on external
   * tool calls spans several generate() calls; usage and elapsed time must
   * cover all of them, not just the leg that happens to finish. */
  #turnAccum: { startedAt: number; input: number; output: number; cacheWrite: number; cacheRead: number } | undefined
  #numTurns = 0
  #totalUsage = { input: 0, output: 0, cacheWrite: 0, cacheRead: 0 }
  #lastActivityAt: number | undefined
  #started = false
  #closed = false

  constructor(config: AiSdkRunnerConfig, id: string = randomUUID()) {
    const mode = config.permissionMode ?? 'default'
    if (!SUPPORTED_PERMISSION_MODES.includes(mode)) {
      throw new Error(`permission mode '${mode}' is not supported by the AI SDK engine`)
    }
    this.#config = config
    this.#model = config.languageModel
    this.#permissionMode = mode
    this.id = id
    this.createdAt = Date.now()
  }

  get status(): SessionStatus {
    return this.#status
  }

  get lastSeq(): number {
    return this.#seq
  }

  /** The session's durable state — persist to park, replay to rehydrate. */
  get messages(): ModelMessage[] {
    return [...this.#messages]
  }

  /** External tool calls the loop is currently parked on. */
  get pendingToolCalls(): PendingToolCall[] {
    return [...this.#pendingToolCalls.values()]
  }

  get pendingApprovals(): PermissionRequest[] {
    return []
  }

  info(): SessionInfo {
    return {
      id: this.id,
      status: this.#status,
      cwd: this.#config.cwd ?? process.cwd(),
      profile: this.#config.profile,
      model: this.#modelId(),
      permissionMode: this.#permissionMode,
      createdAt: this.createdAt,
      lastSeq: this.#seq,
      pendingPermissionCount: 0,
      meta: this.#config.meta,
      title: this.#title(),
      numTurns: this.#numTurns || undefined,
      lastActivityAt: this.#lastActivityAt,
    }
  }

  start(): Promise<void> {
    if (this.#started) return this.#turnChain
    this.#started = true
    this.#setStatus('idle')
    if (this.#config.prompt) this.sendMessage(this.#config.prompt)
    return this.#turnChain
  }

  sendMessage(text: string): void {
    if (this.#closed) throw new Error('session is closed')
    this.#messages.push({ role: 'user', content: text })
    this.#emit({
      type: 'user_message',
      message: { role: 'user', content: text },
      parentToolUseId: null,
      uuid: randomUUID(),
    })
    this.#scheduleTurn()
  }

  /**
   * Deliver the result of an external (execute-less) tool call. Appends the
   * tool-result message and, once no calls remain pending, re-enters the loop.
   * Idempotent per toolCallId: unknown/already-settled ids return false.
   */
  resolveToolCall(toolCallId: string, output: ToolCallOutput, options?: { isError?: boolean }): boolean {
    const pending = this.#pendingToolCalls.get(toolCallId)
    if (!pending || this.#closed) return false
    this.#pendingToolCalls.delete(toolCallId)
    this.#messages.push({
      role: 'tool',
      content: [
        {
          type: 'tool-result',
          toolCallId,
          toolName: pending.toolName,
          output: (options?.isError
            ? { type: 'error-text', value: textValue(output) }
            : output) as never,
        },
      ],
    })
    this.#emit({
      type: 'user_message',
      message: {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: toolCallId,
            content: textValue(output),
            is_error: options?.isError,
          },
        ],
      },
      parentToolUseId: null,
      synthetic: true,
      uuid: randomUUID(),
    })
    if (this.#pendingToolCalls.size === 0) this.#scheduleTurn()
    return true
  }

  resolvePermission(_requestId: string, _decision: PermissionDecision): boolean {
    return false
  }

  async interrupt(): Promise<void> {
    this.#abort?.abort()
    await this.#turnChain
  }

  async setPermissionMode(mode: PermissionMode): Promise<void> {
    if (!SUPPORTED_PERMISSION_MODES.includes(mode)) {
      throw new Error(`permission mode '${mode}' is not supported by the AI SDK engine`)
    }
    this.#permissionMode = mode
    this.#emit({ type: 'permission_mode_changed', mode })
  }

  async setModel(model?: string): Promise<void> {
    const resolve = this.#config.resolveModel
    if (!resolve) throw new Error('set_model is not supported by this session')
    this.#model = resolve(model)
    this.#emit({ type: 'model_changed', model })
  }

  fail(message: string): void {
    if (this.#closed) return
    this.#emit({ type: 'session_error', message })
    this.#setStatus('failed')
    this.close('error')
  }

  close(reason: 'client' | 'server' | 'error' = 'client'): void {
    if (this.#closed) return
    this.#closed = true
    this.#abort?.abort()
    this.#pendingToolCalls.clear()
    this.#emit({ type: 'session_closed', reason })
    this.#setStatus('closed')
  }

  subscribe(listener: SessionEventListener, afterSeq = 0): () => void {
    for (const event of this.#events) {
      if (event.seq > afterSeq) listener(event)
    }
    this.#listeners.add(listener)
    return () => this.#listeners.delete(listener)
  }

  #scheduleTurn(): void {
    this.#turnChain = this.#turnChain.then(() => this.#runTurn())
  }

  async #runTurn(): Promise<void> {
    if (this.#closed || this.#pendingToolCalls.size > 0) return
    this.#setStatus('running')
    const agent = new ToolLoopAgent({
      model: this.#model,
      tools: this.#config.tools ?? {},
      instructions: this.#config.instructions,
      stopWhen: isStepCount(this.#config.maxSteps ?? 20),
    })
    const abort = new AbortController()
    this.#abort = abort
    const accum = (this.#turnAccum ??= {
      startedAt: Date.now(),
      input: 0,
      output: 0,
      cacheWrite: 0,
      cacheRead: 0,
    })
    try {
      const result = await agent.generate({
        messages: [...this.#messages],
        abortSignal: abort.signal,
      })
      if (this.#closed) return
      // v7's result.usage is already cumulative across THIS call's steps — add it
      // once per leg, never per step.
      accum.input += result.usage.inputTokens ?? 0
      accum.output += result.usage.outputTokens ?? 0
      accum.cacheWrite += result.usage.inputTokenDetails?.cacheWriteTokens ?? 0
      accum.cacheRead += result.usage.inputTokenDetails?.cacheReadTokens ?? 0
      this.#messages.push(...(result.responseMessages as ModelMessage[]))
      for (const message of result.responseMessages) {
        this.#emitResponseMessage(message as { role: string; content: unknown })
      }
      // Tool calls the SDK did not execute locally (no `execute`) park the loop.
      const settled = new Set(result.toolResults.map((r) => r.toolCallId))
      for (const call of result.toolCalls) {
        if (settled.has(call.toolCallId)) continue
        this.#pendingToolCalls.set(call.toolCallId, {
          toolCallId: call.toolCallId,
          toolName: call.toolName,
          input: call.input,
        })
      }
      if (this.#pendingToolCalls.size > 0) return // parked: no turn_result yet
      this.#finishTurn(result.text)
    } catch (error) {
      if (this.#closed) return
      const message = error instanceof Error ? error.message : String(error)
      this.#numTurns += 1
      this.#emit({
        type: 'turn_result',
        subtype: 'error_during_execution',
        isError: true,
        durationMs: Date.now() - accum.startedAt,
        numTurns: this.#numTurns,
        totalCostUsd: 0,
        errors: [abort.signal.aborted ? 'interrupted' : message],
        usage: turnUsage(accum),
      })
      this.#turnAccum = undefined
      this.#setStatus('idle')
    } finally {
      if (this.#abort === abort) this.#abort = undefined
    }
  }

  /** Emit the turn's result from the whole-turn accumulator, so a turn that
   * parked on external tool calls reports every leg's tokens and the full
   * elapsed time (including the time spent executing those tools). */
  #finishTurn(text: string): void {
    const accum = this.#turnAccum ?? { startedAt: Date.now(), input: 0, output: 0, cacheWrite: 0, cacheRead: 0 }
    this.#numTurns += 1
    this.#totalUsage.input += accum.input
    this.#totalUsage.output += accum.output
    this.#totalUsage.cacheWrite += accum.cacheWrite
    this.#totalUsage.cacheRead += accum.cacheRead
    this.#emit({
      type: 'turn_result',
      subtype: 'success',
      isError: false,
      durationMs: Date.now() - accum.startedAt,
      numTurns: this.#numTurns,
      totalCostUsd: 0,
      result: text,
      usage: turnUsage(accum),
    })
    this.#turnAccum = undefined
    this.#setStatus('idle')
  }

  #emitResponseMessage(message: { role: string; content: unknown }): void {
    if (message.role === 'assistant') {
      this.#emit({
        type: 'assistant_message',
        message: {
          role: 'assistant',
          content: assistantContentBlocks(message.content),
          model: this.#modelId(),
        },
        parentToolUseId: null,
        uuid: randomUUID(),
      })
      return
    }
    if (message.role === 'tool' && Array.isArray(message.content)) {
      const blocks: ContentBlock[] = (message.content as AssistantPart[])
        .filter((part) => part.type === 'tool-result')
        .map((part) => ({
          type: 'tool_result',
          tool_use_id: part.toolCallId ?? '',
          content: toolResultText(part.output),
          is_error: part.output?.type.includes('denied') || part.output?.type.includes('error')
            ? true
            : undefined,
        }))
      if (blocks.length === 0) return
      this.#emit({
        type: 'user_message',
        message: { role: 'user', content: blocks },
        parentToolUseId: null,
        synthetic: true,
        uuid: randomUUID(),
      })
    }
  }

  #modelId(): string | undefined {
    const model = this.#model
    if (typeof model === 'string') return model
    return (model as { modelId?: string }).modelId
  }

  #title(): string | undefined {
    const metaTitle = this.#config.meta?.title
    if (typeof metaTitle === 'string' && metaTitle.length > 0) return metaTitle
    const prompt = this.#config.prompt
    if (!prompt) return undefined
    return prompt.length > 80 ? prompt.slice(0, 77) + '…' : prompt
  }

  #setStatus(status: SessionStatus, detail?: string): void {
    if (this.#status === status) return
    if (this.#status === 'closed' || this.#status === 'failed') return
    this.#status = status
    this.#emit({ type: 'status_changed', status, detail })
  }

  #emit(body: SessionEventBody): void {
    const event: SessionEvent = { ...body, seq: ++this.#seq, ts: Date.now() }
    this.#lastActivityAt = event.ts
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

function turnUsage(accum: { input: number; output: number; cacheWrite: number; cacheRead: number }) {
  return {
    input_tokens: accum.input,
    output_tokens: accum.output,
    cache_creation_input_tokens: accum.cacheWrite,
    cache_read_input_tokens: accum.cacheRead,
  }
}

function assistantContentBlocks(content: unknown): ContentBlock[] {
  if (typeof content === 'string') return [{ type: 'text', text: content }]
  if (!Array.isArray(content)) return []
  const blocks: ContentBlock[] = []
  for (const part of content as AssistantPart[]) {
    if (part.type === 'text' && typeof part.text === 'string') {
      blocks.push({ type: 'text', text: part.text })
    } else if (part.type === 'reasoning' && typeof part.text === 'string') {
      blocks.push({ type: 'thinking', thinking: part.text })
    } else if (part.type === 'tool-call') {
      blocks.push({
        type: 'tool_use',
        id: part.toolCallId ?? '',
        name: part.toolName ?? '',
        input: part.input,
      })
    } else {
      blocks.push(part as ContentBlock)
    }
  }
  return blocks
}

function toolResultText(output: AssistantPart['output']): string {
  if (!output) return ''
  if (typeof output.value === 'string') return output.value
  if (output.value !== undefined) return JSON.stringify(output.value)
  if (output.reason) return output.reason
  return ''
}

function textValue(output: ToolCallOutput): string {
  return output.type === 'text' ? output.value : JSON.stringify(output.value)
}
