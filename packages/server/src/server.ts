import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { Duplex } from 'node:stream'
import { resolve as resolvePath, sep } from 'node:path'
import { WebSocketServer, type WebSocket } from 'ws'
import { listSessions as sdkListSessions } from '@anthropic-ai/claude-agent-sdk'
import type { SessionRunner, SessionRunnerConfig } from '@claude-worker/core'
import { JobQueue, type QueueAdapter } from '@claude-worker/queue'
import {
  PROTOCOL_VERSION,
  type ClientFrame,
  type CreateJobRequest,
  type CreateSessionRequest,
  type JobEvent,
  type QueueServerFrame,
  type SdkSessionSummary,
  type ServerFrame,
} from '@claude-worker/protocol'
import { SessionRegistry } from './registry.ts'

export type SdkSessionLister = (options: {
  dir?: string
  limit?: number
  offset?: number
}) => Promise<SdkSessionSummary[]>

const defaultSdkSessionLister: SdkSessionLister = async (options) => {
  const sessions = await sdkListSessions(options)
  return sessions.map((s) => ({
    sessionId: s.sessionId,
    summary: s.summary,
    lastModified: s.lastModified,
    createdAt: s.createdAt,
    customTitle: s.customTitle,
    firstPrompt: s.firstPrompt,
    gitBranch: s.gitBranch,
    cwd: s.cwd,
  }))
}

/**
 * Return a principal (any truthy value, attached to nothing yet) to accept the request,
 * or null/undefined to reject with 401. The host app supplies this — the worker has no
 * auth story of its own.
 */
export type Authenticator = (
  req: IncomingMessage,
) => unknown | Promise<unknown>

export type WorkerServerOptions = {
  /** Required unless `allowUnauthenticated: true` — the worker must never be exposed bare. */
  authenticate?: Authenticator
  /** Explicit opt-in to run without auth (local dev only). */
  allowUnauthenticated?: boolean
  /** If set, session cwd must resolve inside one of these roots. Strongly recommended. */
  allowedCwdRoots?: string[]
  /** Map/patch the incoming CreateSessionRequest into the runner config (inject queryFn,
   * env, tool policy, per-skill constraints...). Defaults to identity. */
  buildRunnerConfig?: (req: CreateSessionRequest) => SessionRunnerConfig
  /** URL prefix for all routes. Default '/v1'. */
  basePath?: string
  /** Max JSON body size in bytes. Default 1 MiB. */
  maxBodyBytes?: number
  /**
   * Fail closed on subscription credentials: if a session initializes with
   * `apiKeySource: 'oauth'` (a claude.ai login rather than an API key / Bedrock / Vertex),
   * it is terminated with a session_error. Recommended for services and any
   * unattended/scheduled use — Anthropic's terms require API-key auth for those.
   * Off by default: single-user personal deployments may legitimately run on the
   * operator's own subscription; the server then logs a one-time notice instead.
   */
  requireApiKey?: boolean
  /** Injectable lister for GET /sdk-sessions (tests). Defaults to the SDK's listSessions,
   * which reads the Agent SDK's on-disk session store. */
  listSdkSessions?: SdkSessionLister
  /** Enable the job queue (`/jobs` + `/queue` routes). Jobs run as ordinary registry
   * sessions — attachable over the sessions WS — governed by these limits. */
  queue?: QueueServerOptions
}

export type QueueServerOptions = {
  /** Concurrent job sessions. Default 1. */
  maxConcurrency?: number
  /** Token cap per job session (input+output+cache tokens); exceeding it kills the run. */
  sessionTokenLimit?: number
  /** Global job-token budget per UTC day; queued jobs are held once exhausted. */
  dailyTokenLimit?: number
  /** Wall-clock cap per job run — the watchdog against stuck CLIs. */
  maxJobDurationMs?: number
  /** Grace between interrupting a killed run and force-closing it. Default 5000. */
  killGraceMs?: number
  /** Expire terminal jobs after `maxAgeMs` (the in-memory adapter otherwise grows
   * unboundedly). */
  retention?: { maxAgeMs: number; sweepIntervalMs?: number }
  /** Queue backend. Defaults to the bundled in-memory adapter (single process,
   * no persistence) — redis/bullmq/pubsub adapters implement the same interface. */
  adapter?: QueueAdapter
  /** Webhook delivery attempts per event (default 3, exponential backoff). */
  webhookAttempts?: number
  webhookRetryDelayMs?: number
  /** Local observer for job lifecycle events (in addition to per-job webhooks). */
  onEvent?: (event: JobEvent) => void
}

export type WorkerServer = {
  server: Server
  registry: SessionRegistry
  /** The job queue, when `queue` options were provided. */
  queue?: JobQueue
  listen: (port: number, host?: string) => Promise<{ port: number }>
  close: () => Promise<void>
}

function json(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(payload),
  })
  res.end(payload)
}

async function readJsonBody(
  req: IncomingMessage,
  maxBytes: number,
): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    size += (chunk as Buffer).length
    if (size > maxBytes) throw new Error('request body too large')
    chunks.push(chunk as Buffer)
  }
  if (size === 0) return {}
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>
}

function cwdAllowed(cwd: string, roots: string[] | undefined): boolean {
  if (!roots || roots.length === 0) return true
  const resolved = resolvePath(cwd)
  return roots.some((root) => {
    const r = resolvePath(root)
    return resolved === r || resolved.startsWith(r + sep)
  })
}

export function createWorkerServer(options: WorkerServerOptions = {}): WorkerServer {
  if (!options.authenticate && !options.allowUnauthenticated) {
    throw new Error(
      'createWorkerServer: provide `authenticate` or explicitly set `allowUnauthenticated: true`',
    )
  }
  const basePath = options.basePath ?? '/v1'
  const maxBodyBytes = options.maxBodyBytes ?? 1024 * 1024
  const buildRunnerConfig = options.buildRunnerConfig ?? ((req: CreateSessionRequest) => req)
  const registry = new SessionRegistry()
  const wss = new WebSocketServer({ noServer: true })
  let subscriptionNoticeShown = false

  // Live queue watchers (`{basePath}/queue/ws`): every job event is fanned out, and
  // lifecycle changes push refreshed stats so dashboards stay current without polling.
  const queueSockets = new Set<WebSocket>()
  const sendQueueFrame = (ws: WebSocket, frame: QueueServerFrame): void => {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(frame))
  }
  const broadcastJobEvent = (event: JobEvent): void => {
    if (queueSockets.size === 0) return
    for (const ws of queueSockets) sendQueueFrame(ws, { type: 'job_event', event })
    if (event.type !== 'job_progress') {
      void queue
        ?.stats()
        .then((stats) => {
          for (const ws of queueSockets) sendQueueFrame(ws, { type: 'queue_stats', stats })
        })
        .catch(() => {})
    }
  }

  const queue = options.queue
    ? new JobQueue({
        ...options.queue,
        onEvent: (event) => {
          try {
            options.queue?.onEvent?.(event)
          } finally {
            broadcastJobEvent(event)
          }
        },
        // Job sessions are ordinary registry sessions (attachable/watchable) and go
        // through the same config hook and auth-provenance watcher as client sessions.
        createRunner: (config) => {
          const runner = registry.create(config)
          watchAuthSource(runner)
          return runner
        },
        buildRunnerConfig,
      })
    : undefined

  // Watch each session's init handshake for its auth provenance ('oauth' = claude.ai
  // subscription). The listener is a no-op after the first init; not worth unsubscribing.
  const watchAuthSource = (runner: SessionRunner): void => {
    let seen = false
    runner.subscribe((event) => {
      if (seen || event.type !== 'system_init') return
      seen = true
      if (event.apiKeySource !== 'oauth') return
      if (options.requireApiKey) {
        runner.fail(
          'This server requires API-key auth (requireApiKey), but the session initialized ' +
            "with claude.ai subscription credentials (apiKeySource 'oauth'). Set " +
            'ANTHROPIC_API_KEY (or Bedrock/Vertex auth) in the server environment.',
        )
      } else if (!subscriptionNoticeShown) {
        subscriptionNoticeShown = true
        console.warn(
          '[claude-worker] Sessions are using claude.ai subscription credentials ' +
            "(apiKeySource 'oauth'), not an API key. That is only appropriate for personal, " +
            'single-user use of your own account. Unattended/scheduled or multi-user use ' +
            "requires an API key under Anthropic's terms — set ANTHROPIC_API_KEY in the " +
            'server environment, or set requireApiKey: true to fail closed.',
        )
      }
    })
  }

  const authenticate = async (req: IncomingMessage): Promise<boolean> => {
    if (!options.authenticate) return true
    const principal = await options.authenticate(req)
    return principal !== null && principal !== undefined && principal !== false
  }

  // Route pattern: {basePath}/sessions[/:id[/ws]]
  const parseRoute = (url: string): { id?: string; ws?: boolean } | null => {
    const pathname = new URL(url, 'http://internal').pathname
    if (!pathname.startsWith(basePath + '/sessions')) return null
    const rest = pathname.slice((basePath + '/sessions').length)
    if (rest === '' || rest === '/') return {}
    const parts = rest.replace(/^\//, '').split('/')
    if (parts.length === 1) return { id: decodeURIComponent(parts[0]!) }
    if (parts.length === 2 && parts[1] === 'ws') {
      return { id: decodeURIComponent(parts[0]!), ws: true }
    }
    return null
  }

  const listSdkSessions = options.listSdkSessions ?? defaultSdkSessionLister

  const handleSdkSessions = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    if (req.method !== 'GET') {
      json(res, 405, { error: 'method not allowed' })
      return
    }
    const url = new URL(req.url ?? '/', 'http://internal')
    const dir = url.searchParams.get('dir') ?? undefined
    const roots = options.allowedCwdRoots
    if (roots && roots.length > 0) {
      // Without a dir the SDK lists sessions across ALL projects — never wider than
      // the cwd policy this server enforces on session creation.
      if (!dir) {
        json(res, 400, { error: 'dir is required when allowedCwdRoots is set' })
        return
      }
      if (!cwdAllowed(dir, roots)) {
        json(res, 403, { error: 'dir is outside the allowed roots' })
        return
      }
    }
    const limit = Number(url.searchParams.get('limit') ?? '') || undefined
    const offset = Number(url.searchParams.get('offset') ?? '') || undefined
    json(res, 200, { sdkSessions: await listSdkSessions({ dir, limit, offset }) })
  }

  const handleJobs = async (
    req: IncomingMessage,
    res: ServerResponse,
    pathname: string,
  ): Promise<void> => {
    if (!queue) {
      json(res, 404, { error: 'job queue not configured' })
      return
    }
    if (pathname === basePath + '/queue') {
      if (req.method !== 'GET') {
        json(res, 405, { error: 'method not allowed' })
        return
      }
      json(res, 200, { stats: await queue.stats() })
      return
    }
    const rest = pathname.slice((basePath + '/jobs').length).replace(/^\//, '')
    if (rest === '') {
      if (req.method === 'GET') {
        json(res, 200, { jobs: await queue.list() })
        return
      }
      if (req.method === 'POST') {
        const body = (await readJsonBody(req, maxBodyBytes)) as CreateJobRequest
        if (!body.session || typeof body.session !== 'object') {
          json(res, 400, { error: 'session is required' })
          return
        }
        if (!body.session.cwd || typeof body.session.cwd !== 'string') {
          json(res, 400, { error: 'session.cwd is required' })
          return
        }
        if (!body.session.prompt || typeof body.session.prompt !== 'string') {
          json(res, 400, { error: 'session.prompt is required' })
          return
        }
        if (!cwdAllowed(body.session.cwd, options.allowedCwdRoots)) {
          json(res, 403, { error: 'cwd is outside the allowed roots' })
          return
        }
        try {
          json(res, 201, { job: await queue.submit(body) })
        } catch (error) {
          json(res, 400, { error: error instanceof Error ? error.message : 'invalid job' })
        }
        return
      }
      json(res, 405, { error: 'method not allowed' })
      return
    }
    const id = decodeURIComponent(rest)
    if (id.includes('/')) {
      json(res, 404, { error: 'not found' })
      return
    }
    if (req.method === 'GET') {
      const job = await queue.get(id)
      if (job) json(res, 200, { job })
      else json(res, 404, { error: 'job not found' })
      return
    }
    if (req.method === 'DELETE') {
      const job = await queue.cancel(id)
      if (job) json(res, 200, { job })
      else json(res, 404, { error: 'job not found' })
      return
    }
    json(res, 405, { error: 'method not allowed' })
  }

  const handleRequest = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const pathname = new URL(req.url ?? '/', 'http://internal').pathname
    if (
      pathname === basePath + '/jobs' ||
      pathname.startsWith(basePath + '/jobs/') ||
      pathname === basePath + '/queue'
    ) {
      if (!(await authenticate(req))) {
        json(res, 401, { error: 'unauthorized' })
        return
      }
      await handleJobs(req, res, pathname)
      return
    }
    if (pathname === basePath + '/sdk-sessions') {
      if (!(await authenticate(req))) {
        json(res, 401, { error: 'unauthorized' })
        return
      }
      await handleSdkSessions(req, res)
      return
    }
    const route = parseRoute(req.url ?? '/')
    if (!route || route.ws) {
      json(res, 404, { error: 'not found' })
      return
    }
    if (!(await authenticate(req))) {
      json(res, 401, { error: 'unauthorized' })
      return
    }

    if (!route.id) {
      if (req.method === 'GET') {
        json(res, 200, { sessions: registry.list() })
        return
      }
      if (req.method === 'POST') {
        const body = (await readJsonBody(req, maxBodyBytes)) as CreateSessionRequest
        if (!body.cwd || typeof body.cwd !== 'string') {
          json(res, 400, { error: 'cwd is required' })
          return
        }
        if (!cwdAllowed(body.cwd, options.allowedCwdRoots)) {
          json(res, 403, { error: 'cwd is outside the allowed roots' })
          return
        }
        const runner = registry.create(buildRunnerConfig(body))
        watchAuthSource(runner)
        json(res, 201, { session: runner.info() })
        return
      }
      json(res, 405, { error: 'method not allowed' })
      return
    }

    const runner = registry.get(route.id)
    if (!runner) {
      json(res, 404, { error: 'session not found' })
      return
    }
    if (req.method === 'GET') {
      json(res, 200, { session: runner.info() })
      return
    }
    if (req.method === 'DELETE') {
      registry.remove(route.id)
      json(res, 200, { session: runner.info() })
      return
    }
    json(res, 405, { error: 'method not allowed' })
  }

  const server = createServer((req, res) => {
    handleRequest(req, res).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : 'internal error'
      if (!res.headersSent) json(res, error instanceof SyntaxError ? 400 : 500, { error: message })
      else res.end()
    })
  })

  server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    void (async () => {
      const pathname = new URL(req.url ?? '/', 'http://internal').pathname
      if (pathname === basePath + '/queue/ws') {
        if (!queue) {
          socket.write('HTTP/1.1 404 Not Found\r\n\r\n')
          socket.destroy()
          return
        }
        if (!(await authenticate(req))) {
          socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n')
          socket.destroy()
          return
        }
        wss.handleUpgrade(req, socket, head, (ws) => {
          queueSockets.add(ws)
          ws.on('close', () => queueSockets.delete(ws))
          void queue
            .stats()
            .then((stats) =>
              sendQueueFrame(ws, { type: 'queue_attached', protocolVersion: PROTOCOL_VERSION, stats }),
            )
            .catch(() => {})
        })
        return
      }
      const route = parseRoute(req.url ?? '/')
      if (!route?.ws || !route.id) {
        socket.destroy()
        return
      }
      if (!(await authenticate(req))) {
        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n')
        socket.destroy()
        return
      }
      const runner = registry.get(route.id)
      if (!runner) {
        socket.write('HTTP/1.1 404 Not Found\r\n\r\n')
        socket.destroy()
        return
      }
      wss.handleUpgrade(req, socket, head, (ws) => {
        attachClient(ws, runner, req)
      })
    })().catch(() => socket.destroy())
  })

  const attachClient = (ws: WebSocket, runner: SessionRunner, req: IncomingMessage): void => {
    const url = new URL(req.url ?? '/', 'http://internal')
    const afterSeq = Number(url.searchParams.get('afterSeq') ?? '0') || 0

    const send = (frame: ServerFrame): void => {
      if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(frame))
    }

    send({
      type: 'attached',
      protocolVersion: PROTOCOL_VERSION,
      session: runner.info(),
      replayingFrom: afterSeq,
    })
    const unsubscribe = runner.subscribe((event) => send({ type: 'event', event }), afterSeq)

    ws.on('message', (data: Buffer) => {
      let frame: ClientFrame
      try {
        frame = JSON.parse(data.toString('utf8')) as ClientFrame
      } catch {
        send({ type: 'protocol_error', message: 'invalid JSON frame' })
        return
      }
      handleCommand(frame, runner).catch((error: unknown) => {
        send({
          type: 'protocol_error',
          message: error instanceof Error ? error.message : 'command failed',
        })
      })
    })
    ws.on('close', unsubscribe)
  }

  const handleCommand = async (frame: ClientFrame, runner: SessionRunner): Promise<void> => {
    switch (frame.type) {
      case 'user_message':
        runner.sendMessage(frame.text)
        return
      case 'permission_decision':
        if (frame.behavior === 'allow') {
          runner.resolvePermission(frame.requestId, {
            behavior: 'allow',
            updatedInput: frame.updatedInput,
          })
        } else {
          runner.resolvePermission(frame.requestId, {
            behavior: 'deny',
            message: frame.message,
            interrupt: frame.interrupt,
          })
        }
        return
      case 'interrupt':
        await runner.interrupt()
        return
      case 'set_permission_mode':
        await runner.setPermissionMode(frame.mode)
        return
      case 'set_model':
        await runner.setModel(frame.model)
        return
      case 'close':
        runner.close('client')
        return
      default:
        throw new Error(`unknown command: ${(frame as { type?: string }).type}`)
    }
  }

  return {
    server,
    registry,
    queue,
    listen: (port, host) =>
      new Promise((resolve, reject) => {
        server.once('error', reject)
        server.listen(port, host, () => {
          const address = server.address()
          resolve({ port: typeof address === 'object' && address ? address.port : port })
        })
      }),
    close: () =>
      new Promise((resolve) => {
        queue?.close()
        registry.closeAll()
        for (const ws of queueSockets) ws.close()
        queueSockets.clear()
        wss.close()
        server.close(() => resolve())
        server.closeAllConnections()
      }),
  }
}
