# claude-worker

Web-controlled Agent SDK session runner: embed, watch, and control a close-to-real Claude Code
session from a host app. PRD: `docs/prd-claude-worker.md`. Read it before changing scope — job
queues, serverless, multi-tenant SaaS, and claude.ai auth are explicit non-goals for V1.

## Layout

- `packages/protocol` — wire protocol types (events/commands/REST). Dependency-free, browser-safe.
  Breaking changes bump `PROTOCOL_VERSION`. Everything else depends on this; it depends on nothing.
- `packages/core` — `SessionRunner` over the Agent SDK's `query()`: input queue, pending
  approvals (`canUseTool`), SDKMessage→event normalization, seq-numbered event log. No transport.
- `packages/server` — HTTP + WS gateway (`node:http` + `ws`), session registry, auth hook.
- `packages/client` — REST + WS client on platform `fetch`/`WebSocket`. Zero runtime deps.
- `packages/react` — panel components + `useClaudeSession`. `src/transcript.ts` is a pure reducer
  (framework-free, unit-tested); keep rendering logic out of it.
- `apps/demo` — Vite consumer of client+react against a local server.

Dependency direction: `protocol ← core ← server`, `protocol ← client ← react ← demo`. The browser
side (client/react/demo) must never import core/server or the Agent SDK.

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
  against the fake harness; react: transcript reducer.
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
- `createWorkerServer` refuses to start without `authenticate` unless `allowUnauthenticated: true`
  (loopback dev only). Keep it that way.
