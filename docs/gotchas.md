# Gotchas & invariants

Things that cost someone a debugging session. Each one is load-bearing: the obvious-looking
change is the wrong one. Grouped by where they bite. Architecture lives in
[architecture.md](./architecture.md); this is the list of ways to get it wrong.

## Claude engine (Agent SDK / CLI)

- `cwd` is per-query in the SDK; the runner re-pins it every call. `SessionInfo.id` (server id) ≠
  `sdkSessionId` (SDK session id used for `resume`).
- The SDK version floats (`^0.3.x`) and its unions grow; protocol mirrors must stay assignable
  BOTH ways (SDK→protocol for events, protocol→SDK for options). Unmodeled SDK messages pass
  through as `sdk_event` — extend the protocol first-class, don't parse payloads client-side.
- `total_cost_usd`/`num_turns` on result messages are session-cumulative — roll up last-seen,
  never sum. `usage` is per-turn — token accounting sums input+output+cache_creation+cache_read.
- On `resume` the SDK re-streams only user messages; the runner backfills full history as
  `replay: true` events and the reducer dedupes doubled user messages by uuid. The SDK never
  echoes streamed-input user messages — the runner emits `user_message` itself in `sendMessage()`.
- Promptless sessions emit no `system_init` until the first message, but the CLI answers control
  requests immediately — the runner fetches capabilities/context eagerly; `useClaudeSession`
  seeds mode/model/status from the `attached` frame's SessionInfo.
- CLI telemetry quirks (smoke-verified, SDK 0.3.217): `supportedModels()` leads with a
  `value: 'default'` sentinel (→ `set_model` undefined); `getContextUsage().categories[].color`
  holds CLI theme token names, not CSS; rate_limit events can omit `utilization` — render
  unknown, never 0%.

## Permissions

- Allowing a permission MUST echo the tool input as `updatedInput` (undefined → ZodError → tool
  errors). The fake harness can't catch this class of bug — permission changes need a smoke.
- Switching a live session into `bypassPermissions` needs `allowDangerouslySkipPermissions` at
  spawn (smoke-verified CLI refusal otherwise); `auto` mode is gated CLI-side (model/plan
  support, settings opt-out). Rejected `set_permission_mode` = `protocol_error` frame —
  `useClaudeSession` exposes it via `onProtocolError`; SessionPanel toasts it.
- `AskUserQuestion` rides canUseTool; answers = allow with `updatedInput.answers` (question →
  label(s), comma-joined). `questionBehavior` policy-resolves it unattended ('auto' first option,
  'deny' model decides); under 'ask', job webhooks carry the request for remote answering.
- `PermissionMode`'s vocabulary is Claude Code's; `AiSdkRunner` supports only
  `default`/`bypassPermissions`/`dontAsk` and throws otherwise (surfacing as `protocol_error`).
  `supportsPermissionMode(engine, mode)` in protocol is the ONE source of truth for that
  restriction — create forms filter what they offer with it, the gateway 400s a session/job
  create with it, startup refuses a provider profile whose `defaults.permissionMode` fails it.
  Don't re-encode the list anywhere (the example used to coerce; it no longer does).

## Provider engine (AI SDK v7)

- v7 inverts two conventions this repo had baked in: `result.usage` is **already cumulative**
  across steps (summing per-step usage on top double-counts — `AiSdkRunner` maps it once per
  turn), and a tool without a local `execute` **terminates** the loop rather than pausing it.
  Continuation is therefore message-state replay (persist `responseMessages`, append a
  `ToolResultPart`, re-invoke), not resuming a suspended loop. Approvals map to v7's separate
  `toolApproval` mechanism, not to execute-less tools. v7 is ESM-only and needs Node ≥ 22.
- `AiSdkRunner` STREAMS every leg (`agent.stream`, never `generate`): `stream_delta` per token
  (suppressed by `includePartialMessages: false`) and assistant/tool messages flushed per step —
  so tests must mock `doStream` (model-level parts incl. a `finish` with usage), not
  `doGenerate`; only `generateDigest` still consumes `doGenerate`.
- A third v7 trap (hit live: a deepwiki MCP transport failure hung a session): a thrown `execute`
  yields a `tool-error` part that is **absent from `result.toolResults`** even though the SDK
  already fed the error back and kept looping. Deriving "which calls parked" from `toolResults`
  parks forever on an already-answered call — `AiSdkRunner` derives settled ids from
  `responseMessages` tool parts instead. Related invariants: tool results are spliced BEFORE user
  messages typed mid-park (providers reject non-adjacent results), `interrupt()` rescues a parked
  turn by failing its calls, and a turn whose history already ends with the assistant is skipped
  (double-scheduled turns must not double-generate).
- Provider engines have no `supportedModels()`: the model picker offers `provider.models` as the
  operator declared it on the profile, falling back to `provider.model` alone. Don't ship a
  static per-provider model table — it goes stale and lies outright for openai-compatible
  endpoints. `SessionInfo.engine` is reported by each runner itself (not looked up from the
  profile) so any session surface can gate CLI-only affordances; no event carries it, the attach
  snapshot is the only source.
- `createEngineRunner` may return a promise, so per-session assembly (an MCP connect, a
  credential lookup) can be awaited there, disposed via `AiSdkRunnerConfig.onClose`; a rejection
  fails the create (session POST 500s with the message, a job goes straight to `failed`). The
  example and the SDK smoke still share ONE process-wide MCP client (sessions must not close it)
  — right for one public endpoint, not a constraint any more.

## Tool trust & the sandbox

- Tool trust is load-bearing, not decorative: only `sandboxed` tools may leave the server, and
  they're the ones declared WITHOUT `execute` (the AI SDK halting on those IS the seam). MCP and
  any secret-bearing tool is `authoritative` — bridging one would let a browser forge
  authoritative results. `withMcpTools` throws on a name collision for that reason.
- Sandbox guest limits are interpreter-enforced, but the interrupt deadline **cannot preempt time
  inside a host function** — give every granted capability its own timeout (see
  `QuickJsExecutor#fetchText`). Host↔guest values cross **by value only**; never hand the guest a
  host object by reference (that prototype-chain leak is the CVE-2026-5752 failure shape, covered
  by a red-team test).
- AI SDK MCP lives in `@ai-sdk/mcp` (not `ai`) as of v7, is imported lazily, and supports
  **http/sse only** — stdio is local-only upstream and is rejected explicitly. Claude-engine
  sessions still do stdio, since the CLI spawns those itself.
- `web_fetch` is layered: `createWebFetch` (core) does the SSRF-guarded fetch (DNS-resolved,
  private/link-local denied per redirect hop; cross-host redirects surface a notice instead of
  following; 15-min page cache by URL) and the digest pass runs on the **session's own model**
  via `AiSdkRunner.generateDigest`, which adds its tokens into `#turnAccum` — any extra model
  call made outside that method loses tokens from the turn's accounting. The digest is never
  cached (it's per-prompt).
- `deliver_file` exists only when `onFileDelivered` is wired; `createEngineSession` grants it by
  default (`capabilities.deliverFiles: false` withholds it). Delivered files are downloadable
  only while the session lives — in-memory VFS; durability is the persistence tier.

## Parking & bridged execution

- Parking is a persistence boundary, not an ending, and its invariants are load-bearing:
  `park()` emits `status_changed: 'parked'` and NEVER `session_closed`, snapshots *after* that
  emit and keeps the seq counter (a rehydrated runner continuing at a reused seq is silently
  dropped by the reducer's and client's `seq <= lastSeq` dedupe), and refuses while a leg is in
  flight or any pending call is non-deferred. The runner announces the park only once **every**
  call of the batch has been dispatched — parking on the first `execution_dispatched` would
  snapshot a session whose remaining calls then dispatch into a discarded runner.
- The engine's `state` inside a snapshot is opaque on purpose: typing it would drag `ai`'s
  `ModelMessage` into `packages/server`, which must not resolve a model SDK at all.
  `registry.evict()` (not `remove()`) drops a parked runner — `remove()` closes it. A rebuild
  that ignores `EngineRunnerContext.restore` produces a fresh id and is refused with a loud
  error, because the silent version is a session that quietly forgot its task.
- Bridged tool calls: the server asks the **first attached** client and fails dispatch fast when
  none is attached (which is why autonomous jobs simply never bridge). Results are idempotent by
  `executionId` — a late answer racing a timeout is expected and must not error the client or
  re-open a settled call. The server feeds every bridged result into the session runner's
  optional `settleExecution` before the host's `bridge.onResult` observer — operators don't wire
  that loop themselves. A runner whose id isn't known yet at assembly time reaches its bridge
  executor via a dispatch-time delegate on `call.sessionId` (see `smoke/sdk-client.ts`). The
  browser guest engine is loaded on first bridged call, never at import; keep it that way (it is
  ~2 MB) and keep the variant an optional peer dep.

## Server, profiles & auth

- `createWorkerServer` refuses to start without `authenticate` unless `allowUnauthenticated: true`
  (loopback dev only). Keep it that way.
- Profiles pin `CLAUDE_CONFIG_DIR` *after* the `buildRunnerConfig` hook (profile wins over
  hook-set env); profile `defaults` fill unset request fields only. An `ANTHROPIC_API_KEY` in the
  server env still outranks every profile's config-dir credentials (SDK chain) — surface, don't
  fight it. The oauth notice is per-profile.
- Profile management is doubly opt-in (a `profileStore` AND `canManageProfiles`) and the two
  profile sets never mix: `profiles` from server options are code — immutable over HTTP, and they
  win a name collision — while the store holds UI-created ones. `validateProfile` is shared by
  startup and the routes so a POSTed profile can never be one startup would have refused, and
  `managed` is recomputed on every response (never persisted, never trusted from a client). A
  managed *Claude* profile needs `allowedConfigDirRoots`: naming a config dir is choosing a
  credential store, so unset means the routes create provider profiles only. Profiles can't be
  renamed — sessions and jobs are pinned to the name. A store does NOT suppress the auto-detected
  `default` profile; opting out of that is still `profiles: []`.
- Provider-session grants live on `ProfileInfo.session` (`capabilities`, `mcpServers`,
  `instructions`) and narrow — never widen — via `CreateSessionRequest.capabilities`; the gateway
  400s a widening request rather than silently downgrading it. MCP is **named, never configured**
  there: a transport config's headers can carry credentials and `ProfileInfo` is served by
  `GET /profiles`, so the names refer to servers the host connected in `createEngineRunner` and
  `selectMcpTools` filters by the `<server>__<tool>` namespace. For the same reason a provider
  session request carrying its own `mcpServers` is refused (MCP tools are authoritative — a
  client that could name one could point an authoritative tool anywhere); Claude sessions still
  bring their own, since the CLI spawns them under the operator's own config dir.

## Build, test & packaging

- A package that imports a workspace sibling needs the vitest workspace-source alias (see
  `packages/core/vitest.config.ts`) — the `@claude-worker/source` condition alone isn't enough,
  vite-node externalizes siblings to their unbuilt `build/` entries.
- Inter-package deps are `workspace:*`, and **pnpm must be what packs them**: `pnpm publish`/`pnpm
  pack` rewrite the protocol to the concrete version, `npm publish` does not — npm can't resolve
  it, since this workspace is declared to pnpm alone (no `workspaces` field in the root
  package.json), so it would ship `workspace:*` verbatim and break every consumer.
- npm trusted publishing needs npm ≥ 11.5.1 / Node ≥ 22.14, and pnpm's own OIDC support needs
  pnpm ≥ 11.1.0: `actions/setup-node` writes an unresolved `${NODE_AUTH_TOKEN}` into `.npmrc`,
  and 11.0.8 sent that placeholder as auth (404s). A trusted publisher is configured per package
  on npmjs.com against the workflow *filename*, and a tag runs the workflow from the TAGGED
  commit — so a tag that predates `publish.yml` publishes nothing.
- streamdown (ui's markdown renderer) needs its whole `dist` dir `@source`-scanned; under pnpm it
  lives at `packages/ui/node_modules/streamdown`, not the workspace root.
