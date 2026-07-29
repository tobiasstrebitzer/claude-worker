# Architecture

How claude-worker is put together: eight packages, three apps, one dependency rule. Scope
guards behind this shape: no serverless hosting, no multi-tenant SaaS, no claude.ai auth. For
what's deliberately not built yet, see the [roadmap](./roadmap.md).

## The dependency rule

```
              protocol            sandbox
             /        \          (leaf; either side)
   (server side)    (browser side)
        core           client
         |               |
       queue           react
         |               |
       server            ui
                         |
                        web
```

`@claude-worker/protocol` depends on nothing and everything depends on it. The browser side
(client / react / ui / apps) must never import core, server, or the Agent SDK — the wire
protocol is the only bridge. This rule is what keeps the protocol honest as the product
boundary: anything a client needs must be expressible as protocol events and commands.

## Packages

- **`packages/protocol`** — wire protocol types: session events, commands, REST request/response
  shapes, `JobInfo`/queue frames. Dependency-free and browser-safe. Breaking changes bump
  `PROTOCOL_VERSION`. SDK unions the protocol mirrors (e.g. `PermissionMode`) must stay
  assignable both directions: SDK→protocol for events, protocol→SDK for options.
- **`packages/core`** — the engines. `SessionRunner` (Claude) wraps the Agent SDK's `query()`
  with: a push-based async input queue (`sendMessage` feeds the SDK's streaming-input iterable),
  promotion of `canUseTool` callbacks into pending approvals that block the tool until resolved
  (deny-on-timeout), normalization of every SDKMessage into typed protocol events, and a
  seq-numbered event log enabling attach/replay. No transport. Both engines implement the
  engine-independent `Runner` interface (`src/runner-interface.ts`) that server and queue type
  against. `AiSdkRunner` is the model-agnostic engine over the AI SDK's `ToolLoopAgent`: its
  durable state is a `ModelMessage[]` history, and because that loop *terminates* (never
  suspends) on a tool without a local `execute`, continuation is message-state replay —
  `resolveToolCall()` appends the result and re-invokes. Tool execution goes through the
  `ToolExecutor` seam, whose dispatch either settles inline or returns `pending` keyed by
  `executionId`, so a deferred or remote backend drops in without touching the runner or the
  protocol. `QuickJsExecutor` is the in-process backend over `packages/sandbox`;
  `BrowserBridgeExecutor` relays to an attached tab. `createToolContext` builds a session's
  capability-scoped tools — the agent's authority is exactly what is granted, there are no
  built-in fs/shell tools, and `fs_*` operate on an in-memory scratch VFS rather than the host
  disk. Each tool carries a trust level: `sandboxed` (no ambient authority, safe to execute
  anywhere, results untrusted) or `authoritative` (server-side with server credentials — MCP and
  secret-bearing APIs, never bridged, since bridging would let a browser forge authoritative
  results). `createEngineSession` assembles provider model + tools + executor into a session.
- **`packages/sandbox`** — the untrusted-code boundary: a QuickJS-NG WASM guest for
  LLM-generated scripts, an in-memory `memfs` scratch VFS, and a by-value host bridge (values
  cross as strings/JSON; a host object is never handed over by reference — the bridge, not the
  WASM boundary, is where sandboxes like Terrarium/CVE-2026-5752 actually failed). Limits are
  interpreter-enforced: `setMemoryLimit` for the allocator, an interrupt handler between
  bytecode ops for the wall-clock deadline (so infinite loops are preempted in-thread, no worker
  or cross-origin isolation needed). Note the deadline cannot preempt time inside a host
  function — every granted capability carries its own timeout. The engine variant is injected,
  so the server (Node asyncify) and a browser tab (singlefile asyncify) share one guest engine.
  A leaf package like `protocol`: it imports neither core/server nor any model SDK.
- **`packages/queue`** — `JobQueue` over the runner: one-shot unattended runs with bounded
  concurrency, per-session and daily token budgets, ordered webhook delivery, retries with
  exponential backoff, a wall-clock watchdog (`maxJobDurationMs` + force-close grace), and
  terminal-job retention pruning. The `QueueAdapter` contract is the seam for shared backends
  (redis/bullmq): `claimNext` must be atomic and must skip jobs whose `nextRunAt` is in the
  future; daily token counters are adapter-held. Only the in-memory adapter is bundled.
- **`packages/server`** — the gateway: `node:http` + `ws`, a session registry
  (create/list/attach/interrupt/kill), resume from the SDK's on-disk sessions, a pluggable
  `authenticate` hook (refuses to start without one unless `allowUnauthenticated: true`), and —
  when the `queue` option is set — `/jobs` + `/queue` routes plus a `/queue/ws` stream of job
  events and stats. Job sessions are ordinary registry sessions, so dashboards can watch them.
  Profiles (`profiles` option) bind names to Claude Code config dirs: creation resolves the
  request's profile (required when several are declared, implicit with one, auto-detected from
  `~/.claude` when unset), applies its defaults, and pins `CLAUDE_CONFIG_DIR` after the
  `buildRunnerConfig` hook; the principal's `allowedProfiles` scopes creation and
  `GET /profiles`. `BridgeHub` (always on, exposed as `server.bridge`) routes tool executions
  between a session and the tabs attached to it: it asks the first attached client and fails
  dispatch immediately when none is attached, which is what makes autonomous jobs simply never
  bridge.
- **`packages/client`** — typed protocol client on platform `fetch`/`WebSocket`: REST session
  and job management, WS attach with auto-reconnect and replay-from-last-seq, `attachQueue()`
  for the live queue stream. Zero runtime deps; browser and Node.
- **`packages/react`** — the headless React layer: `useClaudeSession` plus `src/transcript.ts`,
  a pure framework-free reducer folding protocol events into transcript state (messages, tool
  calls, approvals, session meta). Rendering logic stays out of it; it is the unit-test surface.
  Also the browser tool host (`createToolCallHost`, wrapped by `useToolCallHost`): it answers
  server-bridged tool calls by running them in the tab's own QuickJS guest, seeded from the
  request's VFS snapshot, so client-held documents can be evaluated without reaching the server.
  The guest engine loads on the first bridged call rather than at import, and the client refuses
  any tool it wasn't configured for — a server cannot talk a tab into running something it never
  opted into.
- **`packages/ui`** — the styled layer: shadcn-style primitives (`src/components/ui`) and agent
  components (`src/components/agent`: SessionPanel, Transcript, ToolCallCard, PermissionPrompt,
  QuestionPrompt, Composer, SessionList, StatusBar, ModelSelect). Tailwind v4 + Base UI + cva;
  design tokens with light/dark on `<html data-theme>`. Ships source styles that the consumer's
  Tailwind build compiles (`@source` scanning — wiring in the package README). The composer's
  input is a vendored copy of just-marketing/prompt-area (MIT) under `src/components/prompt-area`.
- **`apps/web`** — the full session-control dashboard (TanStack Router, hash history): session
  list, create/resume flow, live panel, jobs view, profiles view, settings.
- (A minimal second consumer, `apps/demo`, proved `client` + `ui` portability for the V1
  acceptance scope; it was removed once that was established — see git history.)

## Session lifecycle

1. `POST /v1/sessions` → registry creates a `SessionRunner`; the runner starts `query()` with a
   streaming-input iterable and re-pins `cwd` every call (the SDK treats it as per-query).
2. Every SDKMessage is normalized into a protocol event, stamped with a monotonic `seq`, logged,
   and fanned out to attached WebSockets. Unmodeled SDK messages pass through as `sdk_event` —
   the rule is to promote what UIs need to first-class events rather than parse payloads
   client-side.
3. Clients attach via `GET /v1/sessions/:id/ws?afterSeq=n` — the server replays logged events
   after `n`, then streams live. The client reconnects automatically and resumes from its last
   seen seq.
4. `canUseTool` promotes a tool call into a pending approval event; the tool blocks until a
   client resolves it via `POST /v1/sessions/:id/permissions/:requestId` (deny-on-timeout, 5
   minutes by default). Allowing must echo the tool input as `updatedInput` — the SDK requires
   it. `AskUserQuestion` rides the same path; `questionBehavior` policy-resolves it for
   unattended runs.
5. Resume: the SDK re-streams only user messages, so the runner backfills full history from the
   SDK's on-disk store as `replay: true` events; the transcript reducer dedupes doubled user
   messages by uuid. `SessionInfo.id` (server id) ≠ `sdkSessionId` (Agent SDK id used for
   `resume`).

## Job lifecycle

`POST /v1/jobs` → adapter enqueues → `JobQueue` claims (`claimNext`) when a concurrency slot
frees and budgets allow → the job runs as an ordinary registry session → webhooks deliver
`job_started` / `job_progress` (per assistant message and permission request) / `job_retrying` /
`job_completed` in order → first turn result completes the job and closes the session. Token
accounting sums per-turn `usage` (input + output + cache_creation + cache_read);
`total_cost_usd`/`num_turns` are session-cumulative and rolled up last-seen, never summed.

## Tooling conventions

pnpm workspace + turbo; TS 7 native preview (`tsgo`) for typecheck; oxlint; tsdown builds
`build/` only on `prepack`/CI. Dev never builds: every package exposes a
`@claude-worker/source` export condition pointing at `src/index.ts` — Node entrypoints run with
`node --conditions=@claude-worker/source --import @swc-node/register/esm-register`, Vite and
vitest set `resolve.conditions` (vitest configs additionally alias workspace deps to source).
Imports within a package use explicit `.ts` extensions.

## Testing

- `pnpm test`: core against a fake `queryFn` harness (no CLI spawn); server as real HTTP+WS
  integration against the fake harness (including job routes and a webhook receiver); queue
  against a fake runner; react as pure reducer unit tests.
- Real-SDK smoke (spawns actual Claude Code, costs tokens) is deliberately outside `pnpm test`:
  a `SessionRunner` with a trivial one-turn prompt. Anything touching the permission path or CLI
  control requests (`supportedModels`, `getContextUsage`) needs a smoke — the fake harness
  cannot validate those payload shapes.
