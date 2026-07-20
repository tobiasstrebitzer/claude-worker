// Local-dev entry: unauthenticated server on localhost. Never expose this beyond loopback.
import { createWorkerServer } from './server.ts'

const port = Number(process.env.PORT ?? 8787)
const cwdRoots = process.env.CLAUDE_WORKER_CWD_ROOTS?.split(':').filter(Boolean)

const { listen } = createWorkerServer({
  allowUnauthenticated: true,
  allowedCwdRoots: cwdRoots,
})

const { port: boundPort } = await listen(port, '127.0.0.1')
console.log(`[claude-worker] dev server (NO AUTH) on http://127.0.0.1:${boundPort}/v1/sessions`)
if (!cwdRoots?.length) {
  console.log('[claude-worker] tip: set CLAUDE_WORKER_CWD_ROOTS=/path/a:/path/b to restrict session cwds')
}
