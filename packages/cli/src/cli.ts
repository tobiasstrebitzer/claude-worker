#!/usr/bin/env node
import { spawn } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ConfigError, loadConfigFile, parseArgs, resolveInstanceConfig } from './config.ts'
import { startInstance } from './instance.ts'

const HELP = `claude-worker — run a claude-worker instance: session gateway + dashboard, one port.

Usage
  claude-worker [options]
  claude-worker guard [options]     check whether it is safe to restart an instance

Options
  -p, --port <n>            port to listen on (default 8787, CLAUDE_WORKER_PORT)
      --host <addr>         interface to bind (default 127.0.0.1, CLAUDE_WORKER_HOST)
      --auth-key <secret>   shared secret, min 12 chars; browsers log in with it,
                            services send it as x-claude-worker-key
                            (CLAUDE_WORKER_AUTH_KEY). Unset = no auth, which is
                            refused on anything but a loopback address.
      --trust-proxy         trust x-forwarded-proto/-host/-for from one reverse
                            proxy. Required behind TLS termination, or the session
                            cookie loses its Secure flag and the origin check
                            computes http:// where the browser says https://.
      --allowed-origin <o>  extra origin accepted on browser requests, for when a
                            proxy rewrites Host (repeatable)
      --allowed-host <name> extra Host header accepted when running without auth
                            (repeatable; loopback names are always accepted)
      --profile <name=dir>  Claude config dir a session may run under (repeatable)
      --cwd-root <path>     restrict session cwds to this root (repeatable,
                            CLAUDE_WORKER_CWD_ROOTS as a ':'-separated list)
      --state-dir <path>    where parked sessions are persisted
                            (default: beside the config file, else ~/.claude-worker)
      --no-parking-store    keep parked sessions in memory only; a restart drops them
  -c, --config <path>       config file (default: ./claude-worker.config.mjs)
      --insecure            allow no-auth on a non-loopback address. Only when
                            something in front is doing the authenticating.
      --open                open the dashboard in a browser once it is up
  -h, --help                show this
  -v, --version             print the version

Config file
  Options that cannot fit on a command line — \`authenticate\`, \`buildRunnerConfig\`,
  \`createEngineRunner\` are functions — live in claude-worker.config.mjs, which
  default-exports the createWorkerServer options (or a function returning them).
  Flags and env override it. Supplying your own \`authenticate\` turns the built-in
  shared-secret auth off entirely.

Credentials
  claude-worker implements no Anthropic auth of its own: the official SDK/CLI
  resolves credentials from the environment, per profile. --auth-key protects this
  gateway, nothing else.
`

async function readVersion(): Promise<string> {
  // src/cli.ts and build/cli.mjs are both one level under the package root.
  const pkgPath = join(dirname(fileURLToPath(import.meta.url)), '..', 'package.json')
  try {
    const raw = await readFile(pkgPath, 'utf8')
    return (JSON.parse(raw) as { version?: string }).version ?? 'unknown'
  } catch {
    return 'unknown'
  }
}

/** Best-effort: a browser that won't open is a convenience missed, not a failure. */
function openInBrowser(url: string): void {
  const command =
    process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open'
  try {
    const child = spawn(command, [url], {
      stdio: 'ignore',
      detached: true,
      shell: process.platform === 'win32',
    })
    child.on('error', () => {})
    child.unref()
  } catch {
    // ignored
  }
}

async function main(argv: string[]): Promise<number> {
  if (argv[0] === 'guard') {
    const { runGuard } = await import('./guard.ts')
    return await runGuard(argv.slice(1))
  }

  const flags = parseArgs(argv)
  if (flags.help) {
    process.stdout.write(HELP)
    return 0
  }
  if (flags.version) {
    process.stdout.write(`${await readVersion()}\n`)
    return 0
  }

  const loaded = await loadConfigFile(flags.config)
  const config = resolveInstanceConfig(flags, loaded)
  const instance = await startInstance(config)

  if (config.open) openInBrowser(instance.url)

  const shutdown = (signal: string): void => {
    process.stdout.write(`\n[claude-worker] ${signal} — shutting down\n`)
    // Parked sessions are already on disk; this is about letting in-flight
    // requests finish rather than dropping sockets on the floor.
    instance
      .close()
      .then(() => process.exit(0))
      .catch(() => process.exit(1))
  }
  process.on('SIGINT', () => shutdown('SIGINT'))
  process.on('SIGTERM', () => shutdown('SIGTERM'))

  // Resolves only on close; the process stays up serving.
  await instance.closed
  return 0
}

main(process.argv.slice(2))
  .then((code) => {
    if (code !== 0) process.exit(code)
  })
  .catch((error: unknown) => {
    if (error instanceof ConfigError) {
      process.stderr.write(`[claude-worker] ${error.message}\n`)
      process.exit(2)
    }
    process.stderr.write(
      `[claude-worker] ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
    )
    process.exit(1)
  })
