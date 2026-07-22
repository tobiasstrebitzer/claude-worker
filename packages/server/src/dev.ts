// Local-dev entry: unauthenticated server on localhost. Never expose this beyond loopback.
import { createWorkerServer } from './server.ts'

const port = Number(process.env.PORT ?? 8787)
const cwdRoots = process.env.CLAUDE_WORKER_CWD_ROOTS?.split(':').filter(Boolean)

const envNumber = (name: string): number | undefined => {
  const value = Number(process.env[name])
  return Number.isFinite(value) && value > 0 ? value : undefined
}

const { listen } = createWorkerServer({
  allowUnauthenticated: true,
  allowedCwdRoots: cwdRoots,
  // Set CLAUDE_WORKER_DISABLE_BYPASS=1 to refuse bypassPermissions server-wide.
  disableBypassPermissions: process.env.CLAUDE_WORKER_DISABLE_BYPASS === '1',
  queue: {
    maxConcurrency: envNumber('CLAUDE_WORKER_QUEUE_CONCURRENCY') ?? 2,
    sessionTokenLimit: envNumber('CLAUDE_WORKER_QUEUE_SESSION_TOKENS'),
    dailyTokenLimit: envNumber('CLAUDE_WORKER_QUEUE_DAILY_TOKENS'),
    // Watchdog + retention keep the dev queue from wedging on a stuck CLI or
    // growing without bound across a long-lived server.
    maxJobDurationMs: envNumber('CLAUDE_WORKER_QUEUE_MAX_JOB_MS') ?? 30 * 60 * 1000,
    retention: { maxAgeMs: envNumber('CLAUDE_WORKER_QUEUE_RETENTION_MS') ?? 24 * 60 * 60 * 1000 },
  },
  profiles: [
    { name: 'default', configDir: '/Users/atomic/.claude' },
    { name: 'test', configDir: '/Users/atomic/.claude-test' }
  ]
})

const { port: boundPort } = await listen(port, '127.0.0.1')
console.log(`[claude-worker] dev server (NO AUTH) on http://127.0.0.1:${boundPort}/v1/sessions`)
console.log(
  '[claude-worker] job queue enabled (CLAUDE_WORKER_QUEUE_CONCURRENCY / _SESSION_TOKENS / _DAILY_TOKENS to tune)',
)
if (!cwdRoots?.length) {
  console.log('[claude-worker] tip: set CLAUDE_WORKER_CWD_ROOTS=/path/a:/path/b to restrict session cwds')
}
