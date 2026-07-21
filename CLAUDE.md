# claude-worker

Web-controlled Agent SDK session runner: embed, watch, and control a close-to-real Claude Code
session from a host app. Key docs — read before changing scope or structure:

- `docs/architecture.md` — package map, dependency rule, session/job lifecycles, tooling detail.
- Non-goals (don't relitigate): serverless hosting, multi-tenant SaaS, claude.ai auth.
- `docs/roadmap.md` — shipped / next / open questions (naming, compliance posture).

## Layout

- `packages/protocol` — wire protocol types (events/commands/REST). Dependency-free,
  browser-safe; everything depends on it, it depends on nothing. Breaking → bump `PROTOCOL_VERSION`.
- `packages/core` — `SessionRunner` over the SDK's `query()`: input queue, pending approvals
  (`canUseTool`), SDKMessage→event normalization, seq-numbered event log. No transport.
- `packages/queue` — `JobQueue` + `QueueAdapter` (in-memory bundled; `claimNext` must stay
  atomic and skip future `nextRunAt`). Concurrency, token budgets, webhooks, retries, watchdog,
  retention. Jobs are one-shot: first turn_result completes them and closes the session.
- `packages/server` — HTTP + WS gateway (`node:http` + `ws`), session registry, auth hook;
  `queue` option mounts `/jobs` + `/queue` routes and a `/queue/ws` JobEvents+stats stream.
- `packages/client` — REST + WS client on platform `fetch`/`WebSocket`. Zero runtime deps.
- `packages/react` — headless: `useClaudeSession` + pure transcript reducer (`src/transcript.ts`,
  framework-free, unit-tested; keep rendering logic out).
- `packages/ui` — styled layer (Tailwind v4 + `@base-ui/react` + cva): primitives in
  `src/components/ui`, agent components in `src/components/agent`. Composer input is vendored
  prompt-area (`src/components/prompt-area`, MIT) — re-vendor + re-apply token-classname edits
  to update. Ships source styles (`theme.css` + `@source`-scanned classnames; wiring in its README).
- `apps/web` — dashboard (TanStack Router, hash history). `apps/demo` — minimal-chrome consumer.
- `apps/docs` — Astro docs site, deployed to GitHub Pages by `.github/workflows/docs.yml`.

Dependency direction: `protocol ← core ← queue ← server`, `protocol ← client ← react ← ui ← web|demo`.
The browser side (client/react/ui/apps) must never import core/server or the Agent SDK.

## Tooling

pnpm workspace + turbo (`pnpm typecheck|test|build|lint`); typecheck is `tsgo` (TS 7 preview),
lint oxlint, `build/` via tsdown only on `prepack`/CI — dev never builds: the
`@claude-worker/source` export condition resolves packages to `src/index.ts` (Node runs with
`--conditions=@claude-worker/source` + swc-node; Vite/vitest set `resolve.conditions`, vitest
also aliases). In-package imports use explicit `.ts` extensions.

## Testing

`pnpm test` — core: fake `queryFn` harness (no CLI spawn); server: real HTTP+WS integration incl.
job routes + webhook receiver; queue: fake runner; react: reducer. Real-SDK smoke (spawns Claude
Code, costs tokens): one-turn `SessionRunner` prompt — never in `pnpm test`. Permission-path or
CLI-control-request changes need a smoke; the fake harness can't validate those payloads.

## Wrapup Config

- check: `pnpm lint` + `pnpm typecheck`
- test: `pnpm test`
- push: yes (github.com/tobiasstrebitzer/claude-worker, branch `master`; repo private pending
  review — re-enable the docs.yml push trigger once Pages is on)
- version_bump: yes (aligned across all 7 packages; 0.1.0 on npm, 0.1.1 tagged awaiting publish)
- publish: yes — npm `@claude-worker` org via keybridge (`/npm-publish`); run the gatekeeper
  audit first. MIT (LICENSE per package; ui intentionally ships `src/`, allowlisted in
  `.claude/gatekeeper.json`).
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
- The SDK version floats (`^0.2.x`) and its unions grow; protocol mirrors must stay assignable
  BOTH ways (SDK→protocol for events, protocol→SDK for options). Unmodeled SDK messages pass
  through as `sdk_event` — extend the protocol first-class, don't parse payloads client-side.
- `total_cost_usd`/`num_turns` on result messages are session-cumulative — roll up last-seen,
  never sum. `usage` is per-turn — token accounting sums input+output+cache_creation+cache_read.
- On `resume` the SDK re-streams only user messages; the runner backfills full history as
  `replay: true` events and the reducer dedupes doubled user messages by uuid. The SDK never
  echoes streamed-input user messages — the runner emits `user_message` itself in `sendMessage()`.
- Allowing a permission MUST echo the tool input as `updatedInput` (undefined → ZodError → tool
  errors). The fake harness can't catch this class of bug — permission changes need a smoke.
- `AskUserQuestion` rides canUseTool; answers = allow with `updatedInput.answers` (question →
  label(s), comma-joined). `questionBehavior` policy-resolves it unattended ('auto' first option,
  'deny' model decides); under 'ask', job webhooks carry the request for remote answering.
- streamdown (ui's markdown renderer) needs its whole `dist` dir `@source`-scanned; under pnpm it
  lives at `packages/ui/node_modules/streamdown`, not the workspace root.
- `createWorkerServer` refuses to start without `authenticate` unless `allowUnauthenticated: true`
  (loopback dev only). Keep it that way.
- CLI telemetry quirks (smoke-verified, SDK 0.2.141): `supportedModels()` leads with a
  `value: 'default'` sentinel (→ `set_model` undefined); `getContextUsage().categories[].color`
  holds CLI theme token names, not CSS; rate_limit events can omit `utilization` — render
  unknown, never 0%.
- Promptless sessions emit no `system_init` until the first message, but the CLI answers control
  requests immediately — the runner fetches capabilities/context eagerly; `useClaudeSession`
  seeds mode/model/status from the `attached` frame's SessionInfo.
