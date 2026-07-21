# @claude-worker/react

Headless React layer for claude-worker: the `useClaudeSession` hook plus a pure transcript
reducer. No styling opinion — bring your own rendering, or use
[`@claude-worker/ui`](https://www.npmjs.com/package/@claude-worker/ui), the styled layer on top.

Part of [claude-worker](https://github.com/tobiasstrebitzer/claude-worker). It sits between
[`@claude-worker/client`](https://www.npmjs.com/package/@claude-worker/client) (REST + WebSocket
attach) and your components: the hook attaches to a session, folds the event stream through the
reducer, and hands back live state plus the control surface (send, approve/deny, interrupt,
permission mode, model).

## Install

```bash
npm install @claude-worker/react @claude-worker/client
```

`react` is a peer dependency (`^18 || ^19`).

## Usage

```tsx
import { ClaudeWorkerClient } from '@claude-worker/client'
import { useClaudeSession } from '@claude-worker/react'

const client = new ClaudeWorkerClient({ baseUrl: 'http://127.0.0.1:8787/v1' })

function Panel({ sessionId }: { sessionId: string }) {
  const { state, connected, send, approve, deny, interrupt } = useClaudeSession(client, sessionId)

  return (
    <div>
      <header>{state.status} {state.model} {connected ? '' : '(reconnecting)'}</header>
      {state.items.map((item) =>
        item.kind === 'assistant_text' ? <p key={item.id}>{item.text}</p> : null,
      )}
      {state.pendingApprovals.map((req) => (
        <div key={req.id}>
          {req.toolName}
          <button onClick={() => approve(req.id)}>Allow</button>
          <button onClick={() => deny(req.id)}>Deny</button>
        </div>
      ))}
      <input onKeyDown={(e) => e.key === 'Enter' && send(e.currentTarget.value)} />
    </div>
  )
}
```

The hook attaches on mount, detaches on unmount, and survives reconnects — the underlying handle
replays from the last seen seq, and the reducer ignores anything it has already applied.

### The transcript reducer, standalone

The state machine is framework-free and exported directly — usable in tests, workers, or any
non-React consumer of the event stream:

```ts
import { applyEvent, initialTranscriptState, seedFromSessionInfo } from '@claude-worker/react'

let state = initialTranscriptState
state = seedFromSessionInfo(state, sessionInfo) // optional: seed from the attach snapshot
for (const event of events) state = applyEvent(state, event)
```

`seedFromSessionInfo` fills fields (status, model, permission mode) a promptless session's event
stream doesn't carry yet; events stay authoritative once they arrive.

## What the state contains

`TranscriptState` is everything a session panel needs to render:

- `items` — the ordered transcript: `user`, `assistant_text` (with a `streaming` flag),
  `thinking`, `tool_call` (input + eventual result), `turn_result`, and `notice` items.
  Streaming deltas accumulate in-place and are superseded by the full assistant message.
- `pendingApprovals` — permission requests awaiting an approve/deny decision.
- `status` / `statusDetail`, `model`, `cwd`, `sdkSessionId`, `permissionMode`.
- `models` and `commands` — what the session can switch to / accepts (from `capabilities`).
- `contextUsage`, `rateLimits` (keyed by window; absent for API-key sessions — render nothing,
  not 0%), `totalCostUsd` (session-cumulative), and `lastSeq` for replay dedupe.

The reducer is pure and immutable: same events in, same state out — which is also how it is
unit-tested. Keep rendering logic out of it.

## License

MIT © Tobias Strebitzer — see
[LICENSE](https://github.com/tobiasstrebitzer/claude-worker/blob/master/LICENSE).
