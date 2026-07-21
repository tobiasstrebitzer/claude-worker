# claude-worker

Web-controlled Agent SDK session runner: embed, watch, and control a close-to-real Claude Code
session from a host app. PRD: `docs/prd-claude-worker.md`. Read it before changing scope —
serverless, multi-tenant SaaS, and claude.ai auth are explicit non-goals. The job queue (the
PRD's "later" layer) landed 2026-07-21 as `packages/queue`; redis/bullmq adapters remain future
work behind its `QueueAdapter` interface.

## Layout

- `packages/protocol` — wire protocol types (events/commands/REST). Dependency-free, browser-safe.
  Breaking changes bump `PROTOCOL_VERSION`. Everything else depends on this; it depends on nothing.
- `packages/core` — `SessionRunner` over the Agent SDK's `query()`: input queue, pending
  approvals (`canUseTool`), SDKMessage→event normalization, seq-numbered event log. No transport.
- `packages/queue` — job queue over the runner: `QueueAdapter` contract (in-memory bundled;
  claimNext must stay atomic for future shared backends and skip future `nextRunAt`) + `JobQueue`
  (concurrency, per-session + daily token budgets, ordered webhook delivery, retries with
  backoff (`attempts`), wall-clock watchdog (`maxJobDurationMs` + force-close grace), terminal-job
  retention pruning). Jobs are one-shot: first turn_result completes them and closes the session.
  No transport.
- `packages/server` — HTTP + WS gateway (`node:http` + `ws`), session registry, auth hook;
  `queue` option mounts `/jobs` + `/queue` routes plus a `/queue/ws` stream of JobEvents + stats
  (job sessions are ordinary registry sessions).
- `packages/client` — REST + WS client on platform `fetch`/`WebSocket`. Zero runtime deps.
- `packages/react` — the **headless** React layer: `useClaudeSession` + `src/transcript.ts`, a
  pure reducer (framework-free, unit-tested); keep rendering logic out of it. No styling.
- `packages/ui` — the **styled** agent-control library (Tailwind v4 + `@base-ui/react` + cva):
  primitives in `src/components/ui`, agent components (SessionPanel/Transcript/ToolCallCard/
  PermissionPrompt/Composer/SessionList) in `src/components/agent`. The Composer's input is
  `src/components/prompt-area` — vendored from just-marketing/prompt-area (MIT, via its shadcn
  registry) so its popover/chips ride this theme's token bridge; re-vendor + re-apply the
  token-classname edits to update it. Ships source styles
  (`@claude-worker/ui/theme.css` + `@source`-scanned classnames — consumer wiring in its README).
  Design tokens copied from a sibling app; light/dark swaps on `<html data-theme>`.
- `apps/web` — session-control dashboard (TanStack Router, hash history) consuming client+ui.
- `apps/demo` — minimal-chrome consumer of client+ui proving portability.

Dependency direction: `protocol ← core ← queue ← server`, `protocol ← client ← react ← ui ← web|demo`.
The browser side (client/react/ui/apps) must never import core/server or the Agent SDK.

## Tooling conventions (mirrors a sibling app)

- pnpm workspace, `workspace:*` deps symlinked. TS 7 native preview: typecheck is `tsgo`, not `tsc`.
- **Source-link:** every package exposes a `@claude-worker/source` export condition pointing at
  `src/index.ts`. Dev/never-build: Node entrypoints run with
  `node --conditions=@claude-worker/source --import @swc-node/register/esm-register`; Vite/vitest
  set `resolve.conditions`. vitest configs additionally alias `@claude-worker/*` to source because
  vite-node externalizes workspace deps to their unbuilt `build/` entries.
- `build/` via tsdown only on `prepack`/CI. Never commit or rely on `build/` in dev.
- Lint: root `oxlint.json`. Orchestration: turbo (`pnpm typecheck|test|build|lint` at root).
- Imports within a package use explicit `.ts` extensions (`allowImportingTsExtensions`).

## Testing

- `pnpm test` — core: fake `queryFn` harness (no real CLI spawn); server: real HTTP+WS integration
  against the fake harness (incl. job routes + webhook receiver); queue: JobQueue against a fake
  runner; react: transcript reducer.
- Real-SDK smoke (spawns actual Claude Code, costs tokens): create a `SessionRunner` with a trivial
  one-turn prompt — see git history / scratchpad `smoke.mjs` pattern. Don't add it to `pnpm test`.

## Wrapup Config

- check: `pnpm lint` + `pnpm typecheck`
- test: `pnpm test`
- push: no (no remote yet — repo home is an open PRD question)
- version_bump: no (until first publish; naming/trademark unresolved)
- publish: no
- docs: root CLAUDE.md + README.md + docs/ (PRD, session-prep notes)
- frontend_smoke: no (demo app; manual via `pnpm server` + `pnpm demo`)
- co_authored_by: no (global)

## Auth red lines (non-negotiable)

claude-worker implements NO Anthropic auth: credentials are resolved by the official SDK/CLI from
the operator's environment. Never add — and reject any PR that adds — claude.ai OAuth flows or
login UI, subscription-token extraction/storage/forwarding, Claude Code client-identity spoofing,
or multi-account pooling / rate-limit circumvention. Policy enforcement lives in configuration
(`requireApiKey`, the one-time 'oauth' notice, `apiKeySource` on SessionInfo/system_init), never
in tampering with the credential chain. Compliance/legal posture is still under review (see
README "Auth & Anthropic's terms") — keep that section's status honest as things settle.

## Gotchas

- `cwd` is per-query in the SDK; the runner re-pins it every call. `SessionInfo.id` (server id) ≠
  `sdkSessionId` (Agent SDK session id used for `resume`).
- The SDK version floats (`^0.2.x`) and its unions grow (e.g. `PermissionMode` gained `'auto'`);
  protocol mirrors must be kept assignable BOTH ways (SDK→protocol for events, protocol→SDK for
  options).
- Unmodeled SDK messages pass through as `sdk_event` — extend the protocol first-class instead of
  parsing payloads client-side.
- `total_cost_usd`/`num_turns` on SDK result messages are **session-cumulative** — roll up with
  last-seen, never sum. `usage` on the same messages is **per-turn** (smoke-verified) — token
  accounting sums it; the queue counts input+output+cache_creation+cache_read.
- On `resume`, the SDK re-streams only *user* messages; the runner backfills full history from
  `getSessionMessages` as `replay: true` events, and the transcript reducer dedupes the doubled
  user messages by uuid. `historyFn`/`listSdkSessions` are injectable on runner/server for tests.
- The SDK does **not** echo streamed-input user messages back at all — the runner emits the
  `user_message` event itself in `sendMessage()` (the one place input enters).
- Allowing a permission **must** echo the tool input: the SDK's `PermissionResult` requires
  `updatedInput` to be a record on allow (undefined → ZodError → the tool errors). The fake
  harness can't catch schema bugs like this — permission changes need a real-SDK smoke.
- `packages/ui` renders markdown via streamdown, which styles itself with Tailwind classes split
  across `dist/` **chunk files** — consumers must `@source` the whole streamdown `dist` dir, and
  under pnpm it lives at `packages/ui/node_modules/streamdown`, not the workspace root.
- `createWorkerServer` refuses to start without `authenticate` unless `allowUnauthenticated: true`
  (loopback dev only). Keep it that way.
- Usage telemetry quirks (confirmed via real-SDK smoke, SDK 0.2.141): `supportedModels()` leads
  with a `value: 'default'` sentinel row (ModelSelect translates it to `set_model` undefined);
  `getContextUsage().categories[].color` holds CLI theme token names ('inactive', 'promptBorder'),
  not CSS colors; rate_limit events can omit `utilization` — render unknown, never 0%.
- A promptless session emits no `system_init` until its first message, but the CLI **does**
  answer control requests (supportedModels/getContextUsage/...) immediately — the runner fetches
  capabilities + a context baseline eagerly, and `useClaudeSession` seeds permissionMode/model/
  status from the `attached` frame's SessionInfo so the UI isn't blank pre-init.
