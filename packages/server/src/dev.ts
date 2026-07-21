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
  queue: {
    maxConcurrency: envNumber('CLAUDE_WORKER_QUEUE_CONCURRENCY') ?? 2,
    sessionTokenLimit: envNumber('CLAUDE_WORKER_QUEUE_SESSION_TOKENS'),
    dailyTokenLimit: envNumber('CLAUDE_WORKER_QUEUE_DAILY_TOKENS'),
  },
})

const { port: boundPort } = await listen(port, '127.0.0.1')
console.log(`[claude-worker] dev server (NO AUTH) on http://127.0.0.1:${boundPort}/v1/sessions`)
console.log(
  '[claude-worker] job queue enabled (CLAUDE_WORKER_QUEUE_CONCURRENCY / _SESSION_TOKENS / _DAILY_TOKENS to tune)',
)
if (!cwdRoots?.length) {
  console.log('[claude-worker] tip: set CLAUDE_WORKER_CWD_ROOTS=/path/a:/path/b to restrict session cwds')
}
