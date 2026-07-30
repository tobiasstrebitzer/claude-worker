import { existsSync } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { join } from 'node:path'
import { createFileSessionStore, createWorkerServer, type WorkerServer } from '@claude-worker/server'
import { dashboardDir } from '@claude-worker/web'
import { createCliAuth, type CliAuth } from './auth.ts'
import { hostnameOf, isLoopbackHostname, type ResolvedConfig } from './config.ts'
import { renderLoginPage } from './login-page.ts'
import { looksLikeAsset, resolveWithinRoot, sendHtml, serveFile } from './static.ts'

export type Instance = {
  server: WorkerServer
  url: string
  port: number
  /** Resolves when the instance stops serving. */
  closed: Promise<void>
  close: () => Promise<void>
}

/**
 * The dashboard comes from `@claude-worker/web`, which ships it prebuilt and
 * exports the path to it. Depending on the package rather than vendoring a copy
 * means one dashboard, versioned in lockstep with everything else.
 *
 * In a checkout that directory only exists once the app has been built — dev
 * never builds — so the miss is worth a real message rather than a stack trace
 * from the static host.
 */
export function resolveWebRoot(): string {
  if (existsSync(join(dashboardDir, 'index.html'))) return dashboardDir
  throw new Error(
    `no dashboard build at ${dashboardDir}\n` +
      `  in a checkout: pnpm --filter @claude-worker/web run build`,
  )
}

/**
 * The Host-header gate for an unauthenticated instance. `allowedHosts` is null
 * whenever auth is on, and then this is the identity function — with a
 * credential in play a rebound origin holds no cookie and fails `authenticate`
 * anyway. Loopback *names* are what's checked, not the socket: the attacker in
 * this scenario controls DNS, so the connection genuinely arrives on 127.0.0.1;
 * what they cannot control is the name the victim's browser writes into Host.
 */
export function createHostGuard(allowedHosts: Set<string> | null): (req: IncomingMessage) => boolean {
  if (allowedHosts === null) return () => true
  return (req) => {
    const header = req.headers.host
    // No Host at all is an HTTP/1.0 client or a raw script, never a browser
    // being driven cross-origin — and it cannot be a rebinding victim.
    if (header === undefined) return true
    const hostname = hostnameOf(header)
    if (hostname === '') return false
    return isLoopbackHostname(hostname) || allowedHosts.has(hostname)
  }
}

/**
 * Everything outside `/v1`. Order matters: the auth endpoints first (they are
 * how a browser gets a session in the first place), then assets, which stay
 * ungated — they are the app's own code, hold no secrets, and gating them would
 * only mean the login page could not be styled by the app it gates. Documents
 * come last, and that is the single place the auth decision is made.
 */
function createFallback(
  auth: CliAuth,
  webRoot: string,
  hostAllowed: (req: IncomingMessage) => boolean,
): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  return async (req, res) => {
    if (!hostAllowed(req)) {
      res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' })
      res.end(
        'unrecognised Host header.\n\nThis instance runs without auth, so it only answers to ' +
          'loopback host names. Use --allowed-host <name>, or set --auth-key.\n',
      )
      return
    }
    if (await auth.handleAuthRequest(req, res)) return

    const pathname = new URL(req.url ?? '/', 'http://internal').pathname

    if (looksLikeAsset(pathname)) {
      const filePath = resolveWithinRoot(webRoot, pathname)
      if (!filePath) {
        res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' })
        res.end('bad request')
        return
      }
      // Hashed filenames are immutable by construction; index.html never is, and
      // it is served below as a document, not here.
      const result = await serveFile(req, res, filePath, {
        immutable: pathname.startsWith('/assets/'),
      })
      if (result === 'served') return
      if (result === 'method-not-allowed') {
        res.writeHead(405, { allow: 'GET, HEAD' })
        res.end()
        return
      }
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
      res.end('not found')
      return
    }

    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { allow: 'GET, HEAD' })
      res.end()
      return
    }

    if (auth.enabled && !auth.hasValidSession(req)) {
      sendHtml(req, res, 401, renderLoginPage(auth.loginPage(req)), 'no-store')
      return
    }

    // The SPA uses hash history, so every route is `#/…` and the server only
    // ever serves the entry document — no rewrite rules, and a deep link works
    // on a static host. `no-cache` on it is what lets an update actually land.
    const entry = join(webRoot, 'index.html')
    const result = await serveFile(req, res, entry, { immutable: false })
    if (result !== 'served') {
      res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' })
      res.end('dashboard build is missing its entry document')
    }
  }
}

export async function startInstance(
  config: ResolvedConfig,
  options: { quiet?: boolean } = {},
): Promise<Instance> {
  const webRoot = config.webRoot ?? resolveWebRoot()
  const auth = createCliAuth(
    config.hostAuthenticates ? { ...config.auth, secret: undefined } : config.auth,
  )
  const hostAllowed = createHostGuard(config.allowedHosts)
  const fallback = createFallback(auth, webRoot, hostAllowed)

  const parking = { ...config.options.parking }
  if (config.stateDir && !parking.store) {
    parking.store = createFileSessionStore({
      dir: join(config.stateDir, 'parked'),
      onError: (error, context) => {
        process.stderr.write(
          `[claude-worker] parked-session store ${context.op} failed for ${context.path}: ` +
            `${error instanceof Error ? error.message : String(error)}\n`,
        )
      },
    })
  }

  const server = createWorkerServer({
    ...config.options,
    parking,
    fallback,
    // A config file's own `authenticate` wins outright — mixing two auth schemes
    // on one hook is how you end up with a bypass nobody meant to write. The
    // host guard still wraps it, but it is a no-op whenever auth is on.
    //
    // Note the unauthenticated case supplies an `authenticate` too rather than
    // `allowUnauthenticated`: the Host check has to cover `/v1`, which is the
    // half of the surface a rebinding attack actually wants.
    authenticate: config.hostAuthenticates
      ? (req) => (hostAllowed(req) ? config.options.authenticate!(req) : null)
      : (req) => (hostAllowed(req) ? auth.authenticate(req) : null),
  })

  const { port } = await server.listen(config.port, config.host)
  const displayHost = config.host === '0.0.0.0' || config.host === '::' ? 'localhost' : config.host
  const url = `http://${displayHost.includes(':') ? `[${displayHost}]` : displayHost}:${port}`

  let resolveClosed: () => void = () => {}
  const closed = new Promise<void>((r) => {
    resolveClosed = r
  })

  if (!options.quiet) {
    const line = (text: string): void => void process.stdout.write(`${text}\n`)
    line('')
    line(`  claude-worker  ${url}`)
    if (config.hostAuthenticates) line('  auth: the config file supplies its own `authenticate`')
    else if (auth.enabled) line('  auth: shared key — browsers sign in, services send a header')
    else line('  NO AUTH — anyone who can reach this port gets a session')
    line(
      config.stateDir
        ? `  parked sessions persist in ${join(config.stateDir, 'parked')}`
        : '  parked sessions are in memory only — a restart drops them',
    )
    if (config.configPath) line(`  config ${config.configPath}`)
    line('')
  }

  return {
    server,
    url,
    port,
    closed,
    close: async () => {
      await server.close()
      resolveClosed()
    },
  }
}
