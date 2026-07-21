# @claude-worker/core

The claude-worker session runner: wraps the Agent SDK's `query()` with a push-based input queue,
promotes `canUseTool` calls into pending approvals, normalizes SDK messages into wire-protocol
events, and keeps a seq-numbered event log for attach/replay. Pure library, no transport.

Part of [claude-worker](https://github.com/tobiasstrebitzer/claude-worker). A `SessionRunner`
behaves like Claude Code launched in the session's directory — same skills, same `CLAUDE.md`, same
permission system — and emits [`@claude-worker/protocol`](https://www.npmjs.com/package/@claude-worker/protocol)
events. [`@claude-worker/server`](https://www.npmjs.com/package/@claude-worker/server) bridges
runners to HTTP + WebSocket; use core directly when you want sessions in-process with no server.

## Install

```bash
npm install @claude-worker/core
```

Depends on `@anthropic-ai/claude-agent-sdk`, which spawns the official Claude Code CLI. Needs
Node ≥ 22 and a real filesystem. claude-worker implements no Anthropic auth: the SDK/CLI resolves
credentials from the operator's environment (`ANTHROPIC_API_KEY`, Bedrock/Vertex, or a personal
`claude login`).

## Usage

`SessionRunnerConfig` is a protocol `CreateSessionRequest` plus host-side extras (`env`,
`extraOptions`, `defaultApprovalTimeoutMs`, injectable `queryFn`/`historyFn` for tests):

```ts
import { SessionRunner } from '@claude-worker/core'

const runner = new SessionRunner({
  cwd: '/srv/checkouts/my-repo',
  prompt: 'Summarize the failing tests', // or a skill invocation like '/verify-content 42'
  settingSources: ['user', 'project'],   // pick up the repo's skills + CLAUDE.md
  permissionMode: 'default',
})

const unsubscribe = runner.subscribe((event) => {
  switch (event.type) {
    case 'assistant_message':
      console.log(event.message)
      break
    case 'permission_requested':
      // Blocks the tool until resolved; denied on timeout (default 5 minutes).
      runner.resolvePermission(event.request.id, { behavior: 'allow' })
      break
  }
})

const done = runner.start()               // idempotent; resolves when the query ends
runner.sendMessage('Now fix the flakiest one') // queues the next turn
await done
```

Other controls: `interrupt()`, `setPermissionMode(mode)`, `setModel(model?)`, `close(reason?)`,
`fail(message)` for host-enforced policy, and `info()` for a protocol `SessionInfo` snapshot
(status, cost, pending approval count, title). `runner.id` is the server-side id;
`runner.sdkSessionId` is the Agent SDK's — the one you pass back as `resume`.

## Approvals, event log, resume

- **Pending approvals** — the runner's `canUseTool` hook turns each uncovered tool call into a
  `permission_requested` event and a `PendingApproval` that blocks the tool until
  `resolvePermission()` (or the timeout) settles it. Allowing echoes the tool input back as
  `updatedInput` — the SDK requires a record even for an unmodified allow. `AskUserQuestion`
  rides the same path; `questionBehavior: 'auto' | 'deny'` policy-resolves it for unattended runs.
- **Event log** — every event gets a monotonic `seq`; `subscribe(listener, afterSeq)` replays the
  buffer past `afterSeq` before delivering live events, so late attachers always catch up.
- **Resume** — pass `resume: sdkSessionId` (optionally `forkSession`). The SDK only re-streams
  user messages, so the runner backfills the full prior transcript from the SDK's on-disk store
  as `replay: true` events before the query starts (`backfillHistory: false` to skip).
- **Capabilities + usage** — after init (and eagerly for promptless sessions) the runner fetches
  supported models/slash commands and a context-window snapshot, emitting `capabilities` and
  `context_usage` events; context usage is re-polled after every turn.

Also exported: `InputQueue` (the push-based `AsyncIterable` bridging `sendMessage()` into the
SDK's streaming prompt) and `normalizeSdkMessage`/`toApiMessage` (SDKMessage → protocol event
normalization). Tests inject a fake `queryFn` — no real CLI spawn needed.

## License

MIT © Tobias Strebitzer —
[LICENSE](https://github.com/tobiasstrebitzer/claude-worker/blob/master/LICENSE)
