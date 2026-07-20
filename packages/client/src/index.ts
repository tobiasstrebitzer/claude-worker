import type {
  AttachedFrame,
  ClientFrame,
  CreateSessionRequest,
  PermissionMode,
  SdkSessionSummary,
  ServerFrame,
  SessionEvent,
  SessionInfo,
} from '@claude-worker/protocol'

export type ClientOptions = {
  /** REST base, e.g. "http://127.0.0.1:8787/v1". The ws:// URL is derived from it. */
  baseUrl: string
  /** Extra headers for REST calls (auth). Browsers can't set WS headers — use
   * `buildWsUrl` (ticket query param) or cookies for WS auth. */
  headers?: Record<string, string>
  /** Override WS URL construction (auth tickets, proxies). */
  buildWsUrl?: (sessionId: string, afterSeq: number) => string
  /** Injectable for non-browser environments/tests. Defaults to globalThis.WebSocket. */
  WebSocketImpl?: typeof WebSocket
  fetchImpl?: typeof fetch
}

export type AttachOptions = {
  /** Replay events with seq greater than this. Default 0 (full replay). */
  afterSeq?: number
  /** Auto-reconnect with backoff on unexpected disconnects. Default true. */
  reconnect?: boolean
}

export type SessionHandleEvents = {
  /** Fired on every (re)attach with the server's session snapshot. */
  attached: AttachedFrame
  /** Every session event, replayed and live, in seq order. */
  event: SessionEvent
  protocolError: string
  /** WS connectivity: true on open, false on close. */
  connectionChange: boolean
}

type Listener<T> = (payload: T) => void

export class SessionHandle {
  readonly sessionId: string
  #client: ClaudeWorkerClient
  #options: Required<Pick<AttachOptions, 'reconnect'>> & AttachOptions
  #ws: WebSocket | undefined
  #listeners = new Map<keyof SessionHandleEvents, Set<Listener<never>>>()
  #lastSeq: number
  #closed = false
  #retries = 0
  #outbox: string[] = []

  constructor(client: ClaudeWorkerClient, sessionId: string, options: AttachOptions = {}) {
    this.#client = client
    this.sessionId = sessionId
    this.#options = { reconnect: true, ...options }
    this.#lastSeq = options.afterSeq ?? 0
    this.#connect()
  }

  get lastSeq(): number {
    return this.#lastSeq
  }

  on<K extends keyof SessionHandleEvents>(
    kind: K,
    listener: Listener<SessionHandleEvents[K]>,
  ): () => void {
    let set = this.#listeners.get(kind)
    if (!set) {
      set = new Set()
      this.#listeners.set(kind, set)
    }
    set.add(listener as Listener<never>)
    return () => set.delete(listener as Listener<never>)
  }

  send(text: string): void {
    this.#sendFrame({ type: 'user_message', text })
  }

  approve(requestId: string, updatedInput?: Record<string, unknown>): void {
    this.#sendFrame({ type: 'permission_decision', requestId, behavior: 'allow', updatedInput })
  }

  deny(requestId: string, message?: string, interrupt?: boolean): void {
    this.#sendFrame({ type: 'permission_decision', requestId, behavior: 'deny', message, interrupt })
  }

  interrupt(): void {
    this.#sendFrame({ type: 'interrupt' })
  }

  setPermissionMode(mode: PermissionMode): void {
    this.#sendFrame({ type: 'set_permission_mode', mode })
  }

  /** Ask the server to terminate the session (the handle disconnects too). */
  closeSession(): void {
    this.#sendFrame({ type: 'close' })
    this.detach()
  }

  /** Disconnect this handle without touching the session. */
  detach(): void {
    this.#closed = true
    this.#ws?.close()
    this.#ws = undefined
  }

  #emit<K extends keyof SessionHandleEvents>(kind: K, payload: SessionHandleEvents[K]): void {
    const set = this.#listeners.get(kind)
    if (!set) return
    for (const listener of set) {
      try {
        ;(listener as Listener<SessionHandleEvents[K]>)(payload)
      } catch {
        // listener errors must not break the stream
      }
    }
  }

  #sendFrame(frame: ClientFrame): void {
    const payload = JSON.stringify(frame)
    // readyState 1 === OPEN (avoid touching the WebSocket global; impl may be injected)
    if (this.#ws && this.#ws.readyState === 1) this.#ws.send(payload)
    else this.#outbox.push(payload)
  }

  #connect(): void {
    if (this.#closed) return
    const ws = this.#client.openSocket(this.sessionId, this.#lastSeq)
    this.#ws = ws
    ws.onopen = () => {
      this.#retries = 0
      this.#emit('connectionChange', true)
      for (const payload of this.#outbox.splice(0)) ws.send(payload)
    }
    ws.onmessage = (msg: MessageEvent) => {
      const frame = JSON.parse(String(msg.data)) as ServerFrame
      if (frame.type === 'attached') {
        this.#emit('attached', frame)
      } else if (frame.type === 'event') {
        if (frame.event.seq <= this.#lastSeq) return
        this.#lastSeq = frame.event.seq
        this.#emit('event', frame.event)
      } else if (frame.type === 'protocol_error') {
        this.#emit('protocolError', frame.message)
      }
    }
    ws.onclose = () => {
      this.#emit('connectionChange', false)
      if (this.#closed || !this.#options.reconnect) return
      const delay = Math.min(500 * 2 ** this.#retries++, 10_000)
      setTimeout(() => this.#connect(), delay)
    }
    ws.onerror = () => {
      // onclose follows; reconnect handled there
    }
  }
}

export class ClaudeWorkerClient {
  #options: ClientOptions
  #fetch: typeof fetch
  #WebSocketImpl: typeof WebSocket

  constructor(options: ClientOptions) {
    this.#options = options
    this.#fetch = options.fetchImpl ?? fetch.bind(globalThis)
    this.#WebSocketImpl = options.WebSocketImpl ?? WebSocket
  }

  async createSession(request: CreateSessionRequest): Promise<SessionInfo> {
    const body = await this.#call('POST', '/sessions', request)
    return (body as { session: SessionInfo }).session
  }

  async listSessions(): Promise<SessionInfo[]> {
    const body = await this.#call('GET', '/sessions')
    return (body as { sessions: SessionInfo[] }).sessions
  }

  async getSession(id: string): Promise<SessionInfo> {
    const body = await this.#call('GET', `/sessions/${encodeURIComponent(id)}`)
    return (body as { session: SessionInfo }).session
  }

  async deleteSession(id: string): Promise<SessionInfo> {
    const body = await this.#call('DELETE', `/sessions/${encodeURIComponent(id)}`)
    return (body as { session: SessionInfo }).session
  }

  /** List the Agent SDK's on-disk sessions (for resume across server restarts).
   * Feed a result's `sessionId` to createSession({ resume }). */
  async listSdkSessions(params?: {
    dir?: string
    limit?: number
    offset?: number
  }): Promise<SdkSessionSummary[]> {
    const search = new URLSearchParams()
    if (params?.dir) search.set('dir', params.dir)
    if (params?.limit !== undefined) search.set('limit', String(params.limit))
    if (params?.offset !== undefined) search.set('offset', String(params.offset))
    const qs = search.size > 0 ? `?${search.toString()}` : ''
    const body = await this.#call('GET', `/sdk-sessions${qs}`)
    return (body as { sdkSessions: SdkSessionSummary[] }).sdkSessions
  }

  attach(sessionId: string, options?: AttachOptions): SessionHandle {
    return new SessionHandle(this, sessionId, options)
  }

  /** @internal used by SessionHandle */
  openSocket(sessionId: string, afterSeq: number): WebSocket {
    const url =
      this.#options.buildWsUrl?.(sessionId, afterSeq) ??
      `${this.#options.baseUrl.replace(/^http/, 'ws')}/sessions/${encodeURIComponent(sessionId)}/ws?afterSeq=${afterSeq}`
    return new this.#WebSocketImpl(url)
  }

  async #call(method: string, path: string, body?: unknown): Promise<unknown> {
    const res = await this.#fetch(`${this.#options.baseUrl}${path}`, {
      method,
      headers: {
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        ...this.#options.headers,
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    })
    const payload = (await res.json().catch(() => ({}))) as { error?: string }
    if (!res.ok) {
      throw new Error(payload.error ?? `${method} ${path} failed with ${res.status}`)
    }
    return payload
  }
}
