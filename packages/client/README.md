# @claude-worker/client

Typed claude-worker protocol client for browsers and Node: REST session management plus a
WebSocket attach with auto-reconnect and replay-from-last-seq. Uses the platform's `fetch` and
`WebSocket`; zero runtime dependencies beyond the wire types.

Part of [claude-worker](https://github.com/tobiasstrebitzer/claude-worker). It speaks the
[`@claude-worker/protocol`](https://www.npmjs.com/package/@claude-worker/protocol) wire format to a
running [`@claude-worker/server`](https://www.npmjs.com/package/@claude-worker/server) gateway.
Layers above build on it:
[`@claude-worker/react`](https://www.npmjs.com/package/@claude-worker/react) (headless hook +
transcript reducer) and [`@claude-worker/ui`](https://www.npmjs.com/package/@claude-worker/ui)
(styled session panel).

## Install

```bash
npm install @claude-worker/client
```

Pairs with a running `@claude-worker/server` — the client is just the typed caller.

## Usage

```ts
import { ClaudeWorkerClient } from '@claude-worker/client'

const client = new ClaudeWorkerClient({
  baseUrl: 'http://127.0.0.1:8787/v1', // ws:// URL is derived from it
  headers: { authorization: 'Bearer …' }, // REST auth; use buildWsUrl/cookies for WS auth
})

const session = await client.createSession({
  cwd: '/srv/checkouts/my-repo',
  prompt: '/verify-content 42',
  settingSources: ['user', 'project'],
})

const handle = client.attach(session.id) // auto-reconnects, replays from last seen seq
handle.on('attached', (frame) => console.log('snapshot', frame.session.status))
handle.on('event', (event) => console.log(event.seq, event.type))
handle.on('connectionChange', (up) => console.log(up ? 'connected' : 'reconnecting'))

handle.send('also run the tests')
handle.approve(requestId)                // permission decisions
handle.deny(requestId, 'not this file')
handle.interrupt()
handle.setPermissionMode('acceptEdits')
handle.detach()                          // disconnect without touching the session
```

`attach()` accepts `{ afterSeq, reconnect }`. On reconnect the handle asks the server for events
after the last seq it saw, so the stream is gapless and duplicates are dropped; commands sent
while disconnected are buffered and flushed on reopen. REST surface:
`createSession` / `listSessions` / `getSession` / `deleteSession`, `resolvePermission` (answer a
pending approval or `AskUserQuestion` over REST), and `listSdkSessions` (on-disk sessions to feed
`createSession({ resume })`).

### Job queue

Against a server configured with `queue`:

```ts
const job = await client.createJob({
  session: { cwd: '/srv/checkout', prompt: '/verify-content 42' },
  webhook: { url: 'https://my-app.test/hooks/claude' },
  attempts: 3,
})
await client.getJob(job.id)      // plus listJobs(), cancelJob(id), queueStats()

const queue = client.attachQueue() // read-only live stream over /queue/ws
queue.on('event', (e) => console.log(e.type, e.job.id))
queue.on('stats', (s) => console.log(s.running, 'running of', s.maxConcurrency))
```

The queue stream has no replay: on (re)connect, re-list jobs and treat the stream as updates.

## Runtime

- **Browsers and Node** — built on platform `fetch` and `WebSocket` (global in Node ≥22). Both are
  injectable (`fetchImpl`, `WebSocketImpl`) for older runtimes, polyfills, and tests.
- **Zero runtime dependencies** — the only dependency is `@claude-worker/protocol`, which is
  itself dependency-free wire types.
- Browsers cannot set WS headers: authenticate the socket with a ticket query param via
  `buildWsUrl(sessionId, afterSeq)` (and `buildQueueWsUrl`) or with cookies.

## License

MIT © Tobias Strebitzer — see
[LICENSE](https://github.com/tobiasstrebitzer/claude-worker/blob/master/LICENSE).
