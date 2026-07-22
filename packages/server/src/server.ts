import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { homedir } from 'node:os'
import type { Duplex } from 'node:stream'
import { join, resolve as resolvePath, sep } from 'node:path'
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
  type ProfileConfigSnapshot,
  type ProfileInfo,
  type QueueServerFrame,
  type ResolvePermissionRequest,
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
 * Return a principal (any truthy value) to accept the request, or null/undefined to
 * reject with 401. The host app supplies this — the worker has no auth story of its
 * own. A principal object may carry `allowedProfiles: string[]` to restrict which
 * profiles the caller can create sessions/jobs under (and see in GET /profiles) —
 * without it the caller may use every declared profile.
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
  /**
   * Named Claude Code config directories sessions can run under (each becomes the
   * session's CLAUDE_CONFIG_DIR — settings, memory, skills, and the credentials the
   * SDK resolves from it). Declared here at startup; the API only reads them
   * (GET {basePath}/profiles). With more than one declared, every session/job create
   * must name its profile; with exactly one it is implicit. Unset: a 'default'
   * profile is auto-created from $CLAUDE_CONFIG_DIR or ~/.claude when that directory
   * exists. Pass [] to run without profiles (no env pinning at all).
   */
  profiles?: ProfileInfo[]
  /** Map/patch the incoming CreateSessionRequest into the runner config (inject queryFn,
   * env, tool policy, per-skill constraints...). Defaults to identity. */
  buildRunnerConfig?: (req: CreateSessionRequest) => SessionRunnerConfig
  /** URL prefix for all routes. Default '/v1'. */
  basePath?: string
  /** Max JSON body size in bytes. Default 1 MiB. */
  maxBodyBytes?: number
  /**
   * Server-wide bypass policy: refuse `permissionMode: 'bypassPermissions'` on
   * session/job creation (403), and strip the `allowDangerouslySkipPermissions`
   * pre-authorization from requests (so clients that ask for the capability by
   * default keep working — their later switch attempt fails with the CLI's own
   * visible error instead). Mirrors Claude Code's
   * `permissions.disableBypassPermissionsMode` setting, enforced at the gateway.
   */
  disableBypassPermissions?: boolean
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

/**
 * Curated, view-only snapshot of a profile's config dir for GET /profiles/:name.
 * Best-effort: a missing or unparseable settings.json just omits the settings block.
 * Env var VALUES are never read into the response — names only.
 */
function readProfileConfig(profile: ProfileInfo): ProfileConfigSnapshot {
  const dir = profile.configDir
  const listDirs = (path: string): string[] => {
    try {
      return readdirSync(path, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
        .sort()
    } catch {
      return []
    }
  }
  const listMd = (path: string): string[] => {
    try {
      return readdirSync(path)
        .filter((file) => file.endsWith('.md'))
        .map((file) => file.slice(0, -3))
        .sort()
    } catch {
      return []
    }
  }
  const snapshot: ProfileConfigSnapshot = {
    hasUserMemory: existsSync(join(dir, 'CLAUDE.md')),
    skills: listDirs(join(dir, 'skills')),
    agents: listMd(join(dir, 'agents')),
    commands: listMd(join(dir, 'commands')),
  }
  try {
    const raw = JSON.parse(readFileSync(join(dir, 'settings.json'), 'utf8')) as Record<
      string,
      unknown
    >
    const permissions = (raw.permissions ?? {}) as Record<string, unknown>
    const count = (rules: unknown): number => (Array.isArray(rules) ? rules.length : 0)
    snapshot.settings = {
      model: typeof raw.model === 'string' ? raw.model : undefined,
      defaultPermissionMode:
        typeof permissions.defaultMode === 'string' ? permissions.defaultMode : undefined,
      permissionRules: {
        allow: count(permissions.allow),
        ask: count(permissions.ask),
        deny: count(permissions.deny),
      },
      envKeys:
        raw.env && typeof raw.env === 'object' ? Object.keys(raw.env).sort() : undefined,
      hooks:
        raw.hooks && typeof raw.hooks === 'object' ? Object.keys(raw.hooks).sort() : undefined,
    }
  } catch {
    // settings.json absent or unparseable — snapshot ships without the block
  }
  return snapshot
}

/** Auto-created profile when none are declared: the operator's own config dir. */
function detectDefaultProfiles(): ProfileInfo[] {
  const dir = process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude')
  return existsSync(dir) ? [{ name: 'default', configDir: dir }] : []
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
  const hostBuildRunnerConfig =
    options.buildRunnerConfig ?? ((req: CreateSessionRequest): SessionRunnerConfig => req)

  // Profiles: declared at startup, or a single 'default' auto-created from the
  // operator's own config dir. Misdeclared dirs fail fast — the CLI would otherwise
  // silently start from an empty config (and a different credential chain).
  const profiles = options.profiles ?? detectDefaultProfiles()
  const profileByName = new Map(profiles.map((p) => [p.name, p]))
  if (profileByName.size !== profiles.length) {
    throw new Error('createWorkerServer: duplicate profile names in `profiles`')
  }
  for (const p of options.profiles ?? []) {
    if (!existsSync(p.configDir)) {
      throw new Error(
        `createWorkerServer: profile '${p.name}' configDir does not exist: ${p.configDir}`,
      )
    }
    if (options.disableBypassPermissions && p.defaults?.permissionMode === 'bypassPermissions') {
      throw new Error(
        `createWorkerServer: profile '${p.name}' defaults to bypassPermissions but ` +
          'disableBypassPermissions is set',
      )
    }
  }

  /** Enforce the server's bypass policy on a create request. Returns a 403 message
   * for an explicit bypass-mode request; strips the pre-authorization capability
   * silently (see the option's doc for why). */
  const applyBypassPolicy = (req: CreateSessionRequest): string | null => {
    if (!options.disableBypassPermissions) return null
    if (req.permissionMode === 'bypassPermissions') {
      return 'bypassPermissions is disabled on this server (disableBypassPermissions)'
    }
    delete req.allowDangerouslySkipPermissions
    return null
  }

  /** Profile-aware config hook: fill the profile's defaults into unset request fields,
   * run the host hook, then pin CLAUDE_CONFIG_DIR — the profile wins even when the
   * host hook set its own env. Handed to the queue too, so jobs inherit profiles. */
  const buildRunnerConfig = (req: CreateSessionRequest): SessionRunnerConfig => {
    const profile = req.profile !== undefined ? profileByName.get(req.profile) : undefined
    if (!profile) return hostBuildRunnerConfig(req)
    const config = hostBuildRunnerConfig({
      ...req,
      model: req.model ?? profile.defaults?.model,
      permissionMode: req.permissionMode ?? profile.defaults?.permissionMode,
    })
    return {
      ...config,
      env: { ...(config.env ?? process.env), CLAUDE_CONFIG_DIR: profile.configDir },
    }
  }

  /** Resolve a request's profile: required when several are declared, implicit with
   * exactly one, scoped by the principal's allowedProfiles. Returns the resolved
   * profile (undefined when the server declares none) or a response-ready error. */
  const resolveProfile = (
    name: unknown,
    allowedProfiles: string[] | undefined,
  ): { ok: true; profile?: ProfileInfo } | { ok: false; status: number; error: string } => {
    if (name !== undefined && typeof name !== 'string') {
      return { ok: false, status: 400, error: 'profile must be a string' }
    }
    if (profiles.length === 0) {
      return name !== undefined
        ? { ok: false, status: 400, error: 'no profiles are configured on this server' }
        : { ok: true }
    }
    const effective = name ?? (profiles.length === 1 ? profiles[0]!.name : undefined)
    if (effective === undefined) {
      const available = profiles.map((p) => p.name).join(', ')
      return { ok: false, status: 400, error: `profile is required (available: ${available})` }
    }
    const profile = profileByName.get(effective)
    if (!profile) return { ok: false, status: 400, error: `unknown profile: ${effective}` }
    if (allowedProfiles && !allowedProfiles.includes(profile.name)) {
      return { ok: false, status: 403, error: `profile not allowed: ${profile.name}` }
    }
    return { ok: true, profile }
  }

  const registry = new SessionRegistry()
  const wss = new WebSocketServer({ noServer: true })
  /** Profiles (by name; '' = none) whose oauth notice has been logged. */
  const subscriptionNoticeShown = new Set<string>()

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
      } else {
        // Per profile, not global: distinct profiles are distinct accounts, and each
        // operator deserves the notice once.
        const profileName = runner.info().profile ?? ''
        if (subscriptionNoticeShown.has(profileName)) return
        subscriptionNoticeShown.add(profileName)
        const scope = profileName ? `Sessions under profile '${profileName}'` : 'Sessions'
        console.warn(
          `[claude-worker] ${scope} are using claude.ai subscription credentials ` +
            "(apiKeySource 'oauth'), not an API key. That is only appropriate for personal, " +
            'single-user use of your own account. Unattended/scheduled or multi-user use ' +
            "requires an API key under Anthropic's terms — set ANTHROPIC_API_KEY in the " +
            'server environment, or set requireApiKey: true to fail closed.',
        )
      }
    })
  }

  type AuthContext = { ok: boolean; allowedProfiles?: string[] }
  const authenticate = async (req: IncomingMessage): Promise<AuthContext> => {
    if (!options.authenticate) return { ok: true }
    const principal = await options.authenticate(req)
    if (principal === null || principal === undefined || principal === false) return { ok: false }
    const allowed = (principal as { allowedProfiles?: unknown }).allowedProfiles
    return {
      ok: true,
      allowedProfiles:
        Array.isArray(allowed) && allowed.every((p) => typeof p === 'string')
          ? (allowed as string[])
          : undefined,
    }
  }

  // Route pattern: {basePath}/sessions[/:id[/ws | /permissions/:requestId]]
  const parseRoute = (
    url: string,
  ): { id?: string; ws?: boolean; permissionId?: string } | null => {
    const pathname = new URL(url, 'http://internal').pathname
    if (!pathname.startsWith(basePath + '/sessions')) return null
    const rest = pathname.slice((basePath + '/sessions').length)
    if (rest === '' || rest === '/') return {}
    const parts = rest.replace(/^\//, '').split('/')
    if (parts.length === 1) return { id: decodeURIComponent(parts[0]!) }
    if (parts.length === 2 && parts[1] === 'ws') {
      return { id: decodeURIComponent(parts[0]!), ws: true }
    }
    if (parts.length === 3 && parts[1] === 'permissions') {
      return { id: decodeURIComponent(parts[0]!), permissionId: decodeURIComponent(parts[2]!) }
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
    auth: AuthContext,
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
        const refused = applyBypassPolicy(body.session)
        if (refused) {
          json(res, 403, { error: refused })
          return
        }
        const resolved = resolveProfile(body.session.profile, auth.allowedProfiles)
        if (!resolved.ok) {
          json(res, resolved.status, { error: resolved.error })
          return
        }
        // Normalize to the resolved name so an implicit single profile still lands
        // on JobInfo.profile and reaches the runner config at claim time.
        body.session.profile = resolved.profile?.name
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
      const auth = await authenticate(req)
      if (!auth.ok) {
        json(res, 401, { error: 'unauthorized' })
        return
      }
      await handleJobs(req, res, pathname, auth)
      return
    }
    if (pathname === basePath + '/profiles' || pathname.startsWith(basePath + '/profiles/')) {
      const auth = await authenticate(req)
      if (!auth.ok) {
        json(res, 401, { error: 'unauthorized' })
        return
      }
      if (req.method !== 'GET') {
        json(res, 405, { error: 'method not allowed' })
        return
      }
      const rest = pathname.slice((basePath + '/profiles').length).replace(/^\//, '')
      if (rest === '') {
        const visible = auth.allowedProfiles
          ? profiles.filter((p) => auth.allowedProfiles!.includes(p.name))
          : profiles
        json(res, 200, { profiles: visible })
        return
      }
      const name = decodeURIComponent(rest)
      const profile = name.includes('/') ? undefined : profileByName.get(name)
      if (!profile) {
        json(res, 404, { error: 'profile not found' })
        return
      }
      if (auth.allowedProfiles && !auth.allowedProfiles.includes(profile.name)) {
        json(res, 403, { error: `profile not allowed: ${profile.name}` })
        return
      }
      json(res, 200, { profile, config: readProfileConfig(profile) })
      return
    }
    if (pathname === basePath + '/sdk-sessions') {
      if (!(await authenticate(req)).ok) {
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
    const auth = await authenticate(req)
    if (!auth.ok) {
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
        const refused = applyBypassPolicy(body)
        if (refused) {
          json(res, 403, { error: refused })
          return
        }
        const resolved = resolveProfile(body.profile, auth.allowedProfiles)
        if (!resolved.ok) {
          json(res, resolved.status, { error: resolved.error })
          return
        }
        // Resolved name (even when implicit) so SessionInfo.profile is always set.
        body.profile = resolved.profile?.name
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
    if (route.permissionId) {
      // REST counterpart of the WS permission_decision command, for controllers
      // without a socket (e.g. answering a job's AskUserQuestion from a webhook).
      if (req.method !== 'POST') {
        json(res, 405, { error: 'method not allowed' })
        return
      }
      const body = (await readJsonBody(req, maxBodyBytes)) as ResolvePermissionRequest
      if (body?.behavior !== 'allow' && body?.behavior !== 'deny') {
        json(res, 400, { error: "behavior must be 'allow' or 'deny'" })
        return
      }
      if (!runner.resolvePermission(route.permissionId, body)) {
        json(res, 404, { error: 'permission request not found (already resolved or expired)' })
        return
      }
      json(res, 200, { resolved: true })
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
        if (!(await authenticate(req)).ok) {
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
      if (!(await authenticate(req)).ok) {
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
        if (frame.mode === 'bypassPermissions' && options.disableBypassPermissions) {
          throw new Error('bypassPermissions is disabled on this server (disableBypassPermissions)')
        }
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
