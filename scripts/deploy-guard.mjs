#!/usr/bin/env node
/**
 * Restart guard for a deploy: ask a running worker whether anything would be lost
 * by stopping it, and exit non-zero while the answer is yes.
 *
 *   node scripts/deploy-guard.mjs --wait 300 --allow-parked && ./restart-worker
 *
 * What a restart costs, and why this is policy and not a server route: an in-flight
 * turn dies with the process (the CLI subprocess and the provider request both go),
 * a pending permission request dies with it, and a running job is left claimed.
 * Two more depend on configuration rather than on state, so each has an opt-out
 * flag that says "I made that durable":
 *
 *   --allow-parked   parked sessions survive with `createFileSessionStore`, not
 *                    with the default in-memory store. Note this covers the
 *                    *session*: a parked job's queue-side record lives in the
 *                    QueueAdapter, so with the bundled in-memory adapter the woken
 *                    session completes with no job attached to finish.
 *   --allow-queued   queued jobs survive only in a durable QueueAdapter; the
 *                    bundled one loses them with the process.
 *
 * Exit codes: 0 safe to restart, 1 still busy, 2 could not tell (bad URL, auth, or
 * an unexpected response — never treated as safe).
 *
 * Auth is whatever the host's `authenticate` hook wants: `--token` (sent as
 * `Authorization: Bearer …`, or CLAUDE_WORKER_TOKEN) covers the common case, and
 * `--header name=value` (repeatable) covers the rest.
 */
import { parseArgs } from 'node:util'

const BUSY_STATUSES = new Set(['starting', 'running', 'awaiting_approval'])

const { values } = parseArgs({
  options: {
    url: { type: 'string', default: process.env.CLAUDE_WORKER_URL ?? 'http://127.0.0.1:8787/v1' },
    token: { type: 'string', default: process.env.CLAUDE_WORKER_TOKEN },
    header: { type: 'string', multiple: true, default: [] },
    wait: { type: 'string', default: '0' },
    interval: { type: 'string', default: '5' },
    'allow-parked': { type: 'boolean', default: false },
    'allow-queued': { type: 'boolean', default: false },
    json: { type: 'boolean', default: false },
    help: { type: 'boolean', default: false },
  },
})

if (values.help) {
  process.stdout.write(
    'usage: deploy-guard.mjs [--url URL] [--token TOKEN] [--header name=value]\n' +
      '                       [--wait SECONDS] [--interval SECONDS]\n' +
      '                       [--allow-parked] [--allow-queued] [--json]\n' +
      '\n' +
      'exit 0 = safe to restart, 1 = busy, 2 = could not tell\n',
  )
  process.exit(0)
}

const base = values.url.replace(/\/$/, '')
const headers = { accept: 'application/json' }
if (values.token) headers.authorization = `Bearer ${values.token}`
for (const entry of values.header) {
  const at = entry.indexOf('=')
  if (at < 1) fail(`--header must be name=value, got '${entry}'`)
  headers[entry.slice(0, at).trim()] = entry.slice(at + 1).trim()
}
const waitMs = seconds('--wait', values.wait) * 1000
const intervalMs = Math.max(seconds('--interval', values.interval), 1) * 1000

/** One look at the server. Returns the reasons a restart would cost something. */
async function inspect() {
  const sessions = await get('/sessions')
  if (sessions.status === 'unreachable') return { unreachable: true, reasons: [] }
  if (!sessions.ok) return { error: `GET ${base}/sessions → ${sessions.detail}` }
  const listed = Array.isArray(sessions.body?.sessions) ? sessions.body.sessions : undefined
  if (!listed) return { error: `GET ${base}/sessions returned no session list` }

  const reasons = []
  /** Worth saying out loud, but not worth blocking a deploy over. */
  const notes = []
  const busy = listed.filter((session) => BUSY_STATUSES.has(session.status))
  for (const session of busy) {
    reasons.push(`session ${session.id} is ${session.status}`)
  }
  const parked = listed.filter((session) => session.status === 'parked')
  if (parked.length > 0 && !values['allow-parked']) {
    reasons.push(
      `${parked.length} parked session(s) — pass --allow-parked once the server ` +
        'runs a durable SessionStore, or they are lost on restart',
    )
  }

  // A queue is optional: 404 here means this server declares none.
  const queue = await get('/queue')
  if (!queue.ok && queue.status !== 'unreachable' && queue.code !== 404) {
    return { error: `GET ${base}/queue → ${queue.detail}` }
  }
  const stats = queue.ok ? queue.body?.stats : undefined
  if (stats?.running > 0) reasons.push(`${stats.running} job(s) running`)
  if (stats?.queued > 0 && !values['allow-queued']) {
    reasons.push(
      `${stats.queued} job(s) queued — pass --allow-queued once the server runs a ` +
        'durable QueueAdapter, or they are lost on restart',
    )
  }
  if (stats?.parked > 0 && values['allow-parked']) {
    // Not a blocking reason: the operator has already said parks are durable. But
    // session durability is not job durability, and only one of the two is theirs.
    notes.push(
      `${stats.parked} parked job(s): their queue-side records are the QueueAdapter's, ` +
        'not the SessionStore\'s — with the in-memory adapter they never finish',
    )
  }
  return { reasons, notes, sessions: listed.length, parked: parked.length }
}

async function get(path) {
  let res
  try {
    res = await fetch(base + path, { headers })
  } catch (error) {
    // Nothing listening on the URL we were pointed at: there is no session to lose.
    if (error?.cause?.code === 'ECONNREFUSED') return { ok: false, status: 'unreachable' }
    return { ok: false, detail: String(error?.message ?? error) }
  }
  if (!res.ok) return { ok: false, code: res.status, detail: `HTTP ${res.status}` }
  try {
    return { ok: true, body: await res.json() }
  } catch {
    return { ok: false, code: res.status, detail: 'response was not JSON' }
  }
}

function seconds(flag, raw) {
  const value = Number(raw)
  if (!Number.isFinite(value) || value < 0) fail(`${flag} must be a non-negative number of seconds`)
  return value
}

function fail(message) {
  process.stderr.write(`deploy-guard: ${message}\n`)
  process.exit(2)
}

function report(verdict, detail) {
  if (values.json) {
    process.stdout.write(`${JSON.stringify({ verdict, ...detail })}\n`)
    return
  }
  const lines = [
    ...(detail.reasons ?? []).map((reason) => `  - ${reason}`),
    ...(detail.notes ?? []).map((note) => `  note: ${note}`),
  ].join('\n')
  process.stdout.write(`deploy-guard: ${verdict}${lines ? `\n${lines}` : ''}\n`)
}

const deadline = Date.now() + waitMs
for (;;) {
  const result = await inspect()
  if (result.error) {
    report('unknown', { reasons: [result.error] })
    process.exit(2)
  }
  if (result.unreachable) {
    report('safe to restart (nothing listening on the given URL)', { reasons: [] })
    process.exit(0)
  }
  if (result.reasons.length === 0) {
    report('safe to restart', result)
    process.exit(0)
  }
  if (Date.now() + intervalMs > deadline) {
    report('busy — not safe to restart', result)
    process.exit(1)
  }
  report(`busy, waiting up to ${Math.round((deadline - Date.now()) / 1000)}s`, result)
  await new Promise((resolve) => setTimeout(resolve, intervalMs))
}
