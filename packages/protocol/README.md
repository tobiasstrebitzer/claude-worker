# @claude-worker/protocol

The claude-worker wire protocol: typed session events, commands, and REST shapes shared by the
server and every client. Dependency-free, browser-safe. This protocol is the product boundary —
versioned from day one.

Part of [claude-worker](https://github.com/tobiasstrebitzer/claude-worker), the web-controlled
Agent SDK session runner. Everything else in the stack depends on this package; it depends on
nothing. [`@claude-worker/core`](https://www.npmjs.com/package/@claude-worker/core) produces these
events, [`@claude-worker/server`](https://www.npmjs.com/package/@claude-worker/server) puts them
on the wire, and [`@claude-worker/client`](https://www.npmjs.com/package/@claude-worker/client)
consumes them. Anthropic API message content is modeled structurally (`ApiMessage`,
`ContentBlock`) so browsers can render transcripts without the Agent SDK.

## Install

```bash
npm install @claude-worker/protocol
```

Type-only for most consumers; the single runtime export is `PROTOCOL_VERSION`.

## Usage

One session = one ordered stream of `SessionEvent`s, each stamped with a monotonically increasing
`seq`, plus a small `SessionCommand` set. Clients attach over WebSocket, optionally replaying from
a known `seq`, and drive the session with commands:

```ts
import {
  PROTOCOL_VERSION,
  type ServerFrame,
  type SessionCommand,
} from '@claude-worker/protocol'

ws.onmessage = ({ data }) => {
  const frame = JSON.parse(data) as ServerFrame
  if (frame.type === 'attached' && frame.protocolVersion !== PROTOCOL_VERSION) {
    throw new Error('protocol mismatch')
  }
  if (frame.type === 'event' && frame.event.type === 'assistant_message') {
    render(frame.event.message) // ApiMessage — plain Anthropic content blocks
  }
}

const approve: SessionCommand = { type: 'permission_decision', requestId, behavior: 'allow' }
ws.send(JSON.stringify(approve))
```

`PROTOCOL_VERSION` is bumped on any breaking change to events, commands, or REST shapes; the
server reports it in the `attached` (and `queue_attached`) frame so clients can detect skew.

## At a glance

**Events (server → client)** — `system_init`, `status_changed`, `capabilities`, `model_changed`,
`permission_mode_changed`, `context_usage`, `rate_limit`, `assistant_message`, `user_message`,
`stream_delta`, `turn_result`, `permission_requested`, `permission_resolved`, `sdk_event`
(forward-compatible passthrough for unmodeled SDK messages), `session_error`, `session_closed`.

**Commands (client → server)** — `user_message`, `permission_decision`, `interrupt`,
`set_permission_mode`, `set_model`, `close`.

**REST shapes** — `CreateSessionRequest` / `SessionInfo` and their response wrappers,
`ResolvePermissionRequest` (the REST counterpart of `permission_decision`), and
`SdkSessionSummary` for listing the Agent SDK's on-disk sessions to offer resume.

**Job queue** — `CreateJobRequest` / `JobInfo` / `JobEvent` / `QueueStats` and the
`QueueServerFrame` union for the one-way queue WebSocket, used when the server mounts the
[`@claude-worker/queue`](https://www.npmjs.com/package/@claude-worker/queue) routes.

Forward compatibility is deliberate: unknown content blocks fall back to `UnknownBlock`, unions
the SDK may grow (`apiKeySource`, rate-limit fields) stay `string`, and unmodeled SDK messages
ride through as `sdk_event` rather than breaking older clients.

## License

MIT © Tobias Strebitzer —
[LICENSE](https://github.com/tobiasstrebitzer/claude-worker/blob/master/LICENSE)
