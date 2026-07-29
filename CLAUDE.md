# claude-worker

Web-controlled Agent SDK session runner: embed, watch, and control a close-to-real Claude Code
session from a host app. Key docs — read before changing scope or structure:

- `docs/architecture.md` — package map, dependency rule, session/job lifecycles, tooling detail.
- Non-goals (don't relitigate): serverless hosting, multi-tenant SaaS, claude.ai auth.
- `docs/roadmap.md` — shipped / next / open questions (naming, compliance posture).

## Layout

- `packages/protocol` — wire protocol types (events/commands/REST). Dependency-free,
  browser-safe; everything depends on it, it depends on nothing. Breaking → bump `PROTOCOL_VERSION`.
- `packages/core` — engines. `SessionRunner` over the SDK's `query()`: input queue, pending
  approvals (`canUseTool`), SDKMessage→event normalization, seq-numbered event log. No transport.
  Both engines implement `Runner` (`src/runner-interface.ts`) — the interface server/queue type
  against. `AiSdkRunner` is the model-agnostic engine (AI SDK v7 `ToolLoopAgent`); tool execution
  goes through the `ToolExecutor` seam (`QuickJsExecutor` in-process, `BrowserBridgeExecutor` to a
  tab). `createToolContext` builds the capability-scoped tool set with the trust split
  (`sandboxed` = no `execute`, rides the seam; `authoritative` = server-side, never bridged);
  granted-or-absent backends: `search`, `download`, `webFetch` (`createWebFetch` in
  `web-fetch.ts`: SSRF-guarded fetch → markdown → model digest), `onFileDelivered`
  (`deliver_file` → `file_delivered` event). `DeferredExecutor` is the third backend: work that
  outlives the runner. `park()` → `RunnerSnapshot` (engine-neutral fields + opaque `state`) and
  `AiSdkRunnerConfig.restore` are the two halves of rehydration. `createEngineSession` + `connectMcpTools`
  assemble a provider session: the host wires the *backends*, the profile's `session` block and
  the request's `capabilities` decide which are granted (ungranted = not built into the tool set).
- `packages/sandbox` — untrusted-code boundary: QuickJS-NG WASM guest + in-memory map VFS
  (deliberately not a node-fs emulation — the tab-side host runs it unpolyfilled, and memfs
  dragged `node:buffer` into the browser) + by-value host bridge, interpreter-enforced
  memory/time limits. Leaf like `protocol` (no core/server/model-SDK
  imports); engine variant is injected so server and browser share one guest.
- `packages/queue` — `JobQueue` + `QueueAdapter` (in-memory bundled; `claimNext` must stay
  atomic and skip future `nextRunAt`). Concurrency, token budgets, webhooks, retries, watchdog,
  retention. Jobs are one-shot: first turn_result completes them and closes the session — but a
  run that parks on a deferred execution goes `parked` at that same finalize chokepoint, frees
  its slot, and stops its duration clock (`onSessionParking`/`onSessionResumed` are host-called;
  `maxParkedDurationMs` bounds the wait).
- `packages/server` — HTTP + WS gateway (`node:http` + `ws`), session registry, auth hook;
  `queue` option mounts `/jobs` + `/queue` routes and a `/queue/ws` JobEvents+stats stream.
  `profiles` option binds names to Claude Code config dirs (session env gets CLAUDE_CONFIG_DIR):
  required-unless-single on create, auto-default from ~/.claude when unset, `allowedProfiles`
  on the auth principal scopes create + `GET /profiles`. `profileStore` (seam in
  `profile-store.ts`; memory + JSON-file impls bundled) mounts profile CRUD, gated by
  `canManageProfiles` on the principal — startup-declared profiles stay immutable, stored ones
  carry `managed: true` on the way out. A profile with `engine: 'provider'`
  instead runs the model-agnostic engine, built by the `createEngineRunner` hook (so this package
  imports no model SDK and never resolves provider credentials itself).
  `GET /sessions/:id/files[/<path>]` serves session deliverables straight from `Runner.vfs`
  (attachment disposition; 404 for engines without a VFS — or from the snapshot when parked).
  `SessionParkManager` (`parking.ts`, exposed as `server.parking`) owns deferred execution:
  snapshot + evict on park, the `SessionStore` seam (memory bundled), the executionId→session
  index and its watchdog, and `POST /executions/:id/result`. Unwatched sessions park; watched
  ones stay live and park after the last detach; attaching to a parked one rehydrates it.
- `packages/client` — REST + WS client on platform `fetch`/`WebSocket`. Zero runtime deps. Owns
  the WS frame surface, so new frames need `SessionHandle` methods/events here. Tests run against
  a real server; `tsconfig.test.json` keeps them out of the main typecheck so `src` stays
  `types: []` (a Node-only API reaching the browser client must stay a type error).
- `packages/react` — headless: `useClaudeSession` + pure transcript reducer (`src/transcript.ts`,
  framework-free, unit-tested; keep rendering logic out) + the browser tool host
  (`src/tool-host.ts` framework-free, `use-tool-host.ts` the thin hook) that executes
  server-bridged tool calls in the tab against a lazily-loaded QuickJS guest.
  `useClaudeSession` exposes its `handle` so companions (the tool host) ride the SAME socket —
  the bridge asks the first attached client, so a second handle would never see the requests;
  `SessionPanel` hosts bridged calls by default on that handle. The bridge e2e test lives here
  (`test/bridge-e2e.test.ts`, node-typed via `tsconfig.test.json` like client's) — react may
  devDep on server for tests, but client must never devDep on react: that edge is the
  build-graph cycle turbo refuses.
- `packages/ui` — styled layer (Tailwind v4 + `@base-ui/react` + cva): primitives in
  `src/components/ui`, agent components in `src/components/agent`. Composer input is vendored
  prompt-area (`src/components/prompt-area`, MIT) — re-vendor + re-apply token-classname edits
  to update. Ships source styles (`theme.css` + `@source`-scanned classnames; wiring in its README).
- `apps/web` — dashboard (TanStack Router, hash history). Create forms are engine-aware through
  `src/lib/engine.ts` (`engineFormOptions`): it reconciles the sticky localStorage choices with
  the selected profile, so a Claude alias or a CLI-only mode carried over to a provider profile
  is coerced rather than submitted.
- `examples` — runnable dev entries with root-level deps the packages must not take
  (`provider-server.ts` wires model SDKs into `createEngineRunner`; see `examples/README.md`
  for the manual browser walkthrough).
- `apps/docs` — Astro docs site, deployed to GitHub Pages by `.github/workflows/docs.yml`.
- `docs/assets` — brand assets ("Session Stack" mark, app icons, banner source); rules and
  regeneration in `docs/assets/BRAND.md`. The mark is inlined in web's `BrandMark.tsx`,
  docs' `Header.astro`, and both favicons — keep geometry identical to `icon.svg`.

Dependency direction: `protocol ← core ← queue ← server`, `protocol ← client ← react ← ui ← web`,
with `sandbox` a leaf usable from either side. The browser side (client/react/ui/apps) must never
import core/server, the Agent SDK, or any model SDK.

## Tooling

pnpm workspace + turbo (`pnpm typecheck|test|build|lint`); typecheck is `tsgo` (TS 7 preview)
and covers `smoke/` + `examples/` too via `typecheck:extras` (they have tsconfigs but are not
packages, so turbo never ran them, and swc-node strips their types unchecked),
lint oxlint, `build/` via tsdown only on `prepack`/CI — dev never builds: the
`@claude-worker/source` export condition resolves packages to `src/index.ts` (Node runs with
`--conditions=@claude-worker/source` + swc-node; Vite/vitest set `resolve.conditions`, vitest
also aliases). In-package imports use explicit `.ts` extensions.

## Testing

`pnpm test` — core: fake `queryFn` harness (no CLI spawn); server: real HTTP+WS integration incl.
job routes + webhook receiver; queue: fake runner; react: reducer. Real-SDK smoke (spawns Claude
Code, costs tokens): one-turn `SessionRunner` prompt — never in `pnpm test`. Permission-path or
CLI-control-request changes need a smoke; the fake harness can't validate those payloads.
Model-agnostic smokes live in `smoke/` (see its README): `smoke:sandbox` is free; `smoke:live`
(in-process runner vs a real provider) and `smoke:sdk` (full server + client SDK + browser-host
stack) cost tokens.

## Wrapup Config

- check: `pnpm lint` + `pnpm typecheck`
- test: `pnpm test`
- push: yes (github.com/tobiasstrebitzer/claude-worker, branch `master`; repo private pending
  review — re-enable the docs.yml push trigger once Pages is on)
- version_bump: yes (aligned across all 8 packages; 0.4.0 tagged — `sandbox` first published at
  0.3.0)
- publish: yes — npm `@claude-worker` org via keybridge Touch ID: `npx -y keybridge@latest
  publish` from each package dir, dependency order (protocol/sandbox → core/client → queue →
  react → server → ui). keybridge runs plain `npm publish`, so pin `workspace:*` inter-deps to the
  release version first, publish, then `git checkout` the package.jsons. Run the gatekeeper
  audit before publishing. MIT (LICENSE per package; ui intentionally ships `src/`,
  allowlisted in `.claude/gatekeeper.json`).
- docs: root CLAUDE.md + README.md + docs/ + apps/docs (keep site content in sync with README)
- frontend_smoke: no (manual via `pnpm server` + `pnpm web`)
- co_authored_by: no (global)

## Auth red lines (non-negotiable)

claude-worker implements NO Anthropic auth: credentials are resolved by the official SDK/CLI from
the operator's environment. Never add — and reject any PR that adds — claude.ai OAuth flows or
login UI, subscription-token extraction/storage/forwarding, Claude Code client-identity spoofing,
or multi-account pooling / rate-limit circumvention. Policy enforcement lives in configuration
(`requireApiKey`, the one-time 'oauth' notice, `apiKeySource` on SessionInfo/system_init), never
in tampering with the credential chain. Compliance/legal review is in progress — keep the README
"Auth & Anthropic's terms" section's status honest as things settle.

## Gotchas

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
- Allowing a permission MUST echo the tool input as `updatedInput` (undefined → ZodError → tool
  errors). The fake harness can't catch this class of bug — permission changes need a smoke.
- Switching a live session into `bypassPermissions` needs `allowDangerouslySkipPermissions` at
  spawn (smoke-verified CLI refusal otherwise); `auto` mode is gated CLI-side (model/plan
  support, settings opt-out). Rejected `set_permission_mode` = `protocol_error` frame —
  `useClaudeSession` exposes it via `onProtocolError`; SessionPanel toasts it.
- `AskUserQuestion` rides canUseTool; answers = allow with `updatedInput.answers` (question →
  label(s), comma-joined). `questionBehavior` policy-resolves it unattended ('auto' first option,
  'deny' model decides); under 'ask', job webhooks carry the request for remote answering.
- streamdown (ui's markdown renderer) needs its whole `dist` dir `@source`-scanned; under pnpm it
  lives at `packages/ui/node_modules/streamdown`, not the workspace root.
- `createWorkerServer` refuses to start without `authenticate` unless `allowUnauthenticated: true`
  (loopback dev only). Keep it that way.
- Profiles pin `CLAUDE_CONFIG_DIR` *after* the `buildRunnerConfig` hook (profile wins over
  hook-set env); profile `defaults` fill unset request fields only. An `ANTHROPIC_API_KEY` in
  the server env still outranks every profile's config-dir credentials (SDK chain) — surface,
  don't fight it. The oauth notice is per-profile.
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
- Provider engines have no `supportedModels()`: the model picker offers `provider.models` as the
  operator declared it on the profile, falling back to `provider.model` alone. Don't ship a
  static per-provider model table — it goes stale and lies outright for openai-compatible
  endpoints. `SessionInfo.engine` is reported by each runner itself (not looked up from the
  profile) so any session surface can gate CLI-only affordances; no event carries it, the attach
  snapshot is the only source.
- CLI telemetry quirks (smoke-verified, SDK 0.3.217): `supportedModels()` leads with a
  `value: 'default'` sentinel (→ `set_model` undefined); `getContextUsage().categories[].color`
  holds CLI theme token names, not CSS; rate_limit events can omit `utilization` — render
  unknown, never 0%.
- Promptless sessions emit no `system_init` until the first message, but the CLI answers control
  requests immediately — the runner fetches capabilities/context eagerly; `useClaudeSession`
  seeds mode/model/status from the `attached` frame's SessionInfo.
- AI SDK v7 inverts two conventions this repo had baked in: `result.usage` is **already
  cumulative** across steps (summing per-step usage on top double-counts — `AiSdkRunner` maps it
  once per turn), and a tool without a local `execute` **terminates** the loop rather than pausing
  it. Continuation is therefore message-state replay (persist `responseMessages`, append a
  `ToolResultPart`, re-invoke), not resuming a suspended loop. Approvals map to v7's separate
  `toolApproval` mechanism, not to execute-less tools. v7 is ESM-only and needs Node ≥ 22.
  `AiSdkRunner` STREAMS every leg (`agent.stream`, never `generate`): `stream_delta` per token
  (suppressed by `includePartialMessages: false`) and assistant/tool messages flushed per step —
  so tests must mock `doStream` (model-level parts incl. a `finish` with usage), not
  `doGenerate`; only `generateDigest` still consumes `doGenerate`.
- A third v7 trap (hit live: a deepwiki MCP transport failure hung a session): a thrown
  `execute` yields a `tool-error` part that is **absent from `result.toolResults`** even though
  the SDK already fed the error back and kept looping. Deriving "which calls parked" from
  `toolResults` parks forever on an already-answered call — `AiSdkRunner` derives settled ids
  from `responseMessages` tool parts instead. Related invariants: tool results are spliced
  BEFORE user messages typed mid-park (providers reject non-adjacent results), `interrupt()`
  rescues a parked turn by failing its calls, and a turn whose history already ends with the
  assistant is skipped (double-scheduled turns must not double-generate).
- `PermissionMode`'s vocabulary is Claude Code's; `AiSdkRunner` supports only
  `default`/`bypassPermissions`/`dontAsk` and throws otherwise (surfacing as `protocol_error`).
  `supportsPermissionMode(engine, mode)` in protocol is the ONE source of truth for that
  restriction — create forms filter what they offer with it, the gateway 400s a session/job
  create with it, startup refuses a provider profile whose `defaults.permissionMode` fails it.
  Don't re-encode the list anywhere (the example used to coerce; it no longer does).
- Sandbox guest limits are interpreter-enforced, but the interrupt deadline **cannot preempt time
  inside a host function** — give every granted capability its own timeout (see
  `QuickJsExecutor#fetchText`). Host↔guest values cross **by value only**; never hand the guest a
  host object by reference (that prototype-chain leak is the CVE-2026-5752 failure shape, covered
  by a red-team test).
- A package that imports a workspace sibling needs the vitest workspace-source alias (see
  `packages/core/vitest.config.ts`) — the `@claude-worker/source` condition alone isn't enough,
  vite-node externalizes siblings to their unbuilt `build/` entries.
- Tool trust is load-bearing, not decorative: only `sandboxed` tools may leave the server, and
  they're the ones declared WITHOUT `execute` (the AI SDK halting on those IS the seam). MCP and
  any secret-bearing tool is `authoritative` — bridging one would let a browser forge
  authoritative results. `withMcpTools` throws on a name collision for that reason.
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
  only while the session lives — in-memory VFS; durability is the persistence tier (M5).
- `createEngineRunner` may return a promise, so per-session assembly (an MCP connect, a
  credential lookup) can be awaited there, disposed via `AiSdkRunnerConfig.onClose`; a rejection
  fails the create (session POST 500s with the message, a job goes straight to `failed`). The
  example and the SDK smoke still share ONE process-wide MCP client (sessions must not close it)
  — right for one public endpoint, not a constraint any more.
- Parking is a persistence boundary, not an ending, and its invariants are load-bearing:
  `park()` emits `status_changed: 'parked'` and NEVER `session_closed`, snapshots *after* that
  emit and keeps the seq counter (a rehydrated runner continuing at a reused seq is silently
  dropped by the reducer's and client's `seq <= lastSeq` dedupe), and refuses while a leg is in
  flight or any pending call is non-deferred. The runner announces the park only once **every**
  call of the batch has been dispatched — parking on the first `execution_dispatched` would
  snapshot a session whose remaining calls then dispatch into a discarded runner. The engine's
  `state` inside a snapshot is opaque on purpose: typing it would drag `ai`'s `ModelMessage` into
  `packages/server`, which must not resolve a model SDK at all. `registry.evict()` (not
  `remove()`) drops a parked runner — `remove()` closes it. A rebuild that ignores
  `EngineRunnerContext.restore` produces a fresh id and is refused with a loud error, because the
  silent version is a session that quietly forgot its task.
- Bridged tool calls: the server asks the **first attached** client and fails dispatch fast when
  none is attached (which is why autonomous jobs simply never bridge). Results are idempotent by
  `executionId` — a late answer racing a timeout is expected and must not error the client or
  re-open a settled call. The server feeds every bridged result into the session runner's
  optional `settleExecution` before the host's `bridge.onResult` observer — operators don't
  wire that loop themselves. A runner whose id isn't known yet at assembly time reaches its
  bridge executor via a dispatch-time delegate on `call.sessionId` (see `smoke/sdk-client.ts`). The browser guest engine is loaded on first bridged call, never at
  import; keep it that way (it is ~2 MB) and keep the variant an optional peer dep.
