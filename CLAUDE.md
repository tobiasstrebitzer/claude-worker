# claude-worker

Web-controlled Agent SDK session runner: embed, watch, and control a close-to-real Claude Code
session from a host app; a second, model-agnostic engine runs any AI SDK provider on the same
protocol. Read these before changing scope or structure:

- `docs/gotchas.md` — **the invariants that bite.** Skim the headings for whatever you're about
  to touch: engine, permission, parking, bridge, packaging.
- `docs/architecture.md` — package map, dependency rule, session/job/parking lifecycles.
- `docs/roadmap.md` — shipped / next / open questions. Non-goals (don't relitigate): serverless
  hosting, multi-tenant SaaS, claude.ai auth.

## Layout

- `packages/protocol` — wire types (events/commands/REST). Dependency-free, browser-safe, depends
  on nothing and everything depends on it. Breaking → bump `PROTOCOL_VERSION`.
- `packages/core` — the engines. `SessionRunner` (Claude, over the SDK's `query()`) and
  `AiSdkRunner` (provider, over AI SDK v7), both behind `Runner` (`src/runner-interface.ts`),
  which is what server and queue type against. No transport. Tool execution rides the
  `ToolExecutor` seam (`QuickJsExecutor` in-process, `BrowserBridgeExecutor` to a tab,
  `DeferredExecutor` for work outliving the runner); `createToolContext` builds the
  capability-scoped tool set with the `sandboxed`/`authoritative` trust split; `park()` →
  `RunnerSnapshot` + `restore` are the two halves of rehydration.
- `packages/sandbox` — untrusted-code boundary: QuickJS-NG WASM guest, in-memory map VFS (not a
  node-fs emulation — the tab-side host runs it unpolyfilled), by-value host bridge,
  interpreter-enforced limits. Leaf like `protocol`; engine variant injected, so server and
  browser share one guest.
- `packages/queue` — `JobQueue` + `QueueAdapter` (in-memory bundled; `claimNext` must stay atomic
  and skip future `nextRunAt`). Concurrency, token budgets, webhooks, retries, watchdog, retention.
  Jobs are one-shot, but a run that parks frees its slot and stops its duration clock.
- `packages/server` — HTTP + WS gateway (`node:http` + `ws`): session registry, auth hook,
  optional `/jobs` + `/queue` routes, profiles (+ `profileStore` CRUD), `GET /sessions/:id/files`,
  `SessionParkManager` (`parking.ts`) owning deferred execution. Imports no model SDK — a provider
  profile is built by the host's `createEngineRunner` hook.
- `packages/client` — REST + WS client on platform `fetch`/`WebSocket`; zero runtime deps. Owns
  the WS frame surface, so new frames need `SessionHandle` methods/events here.
- `packages/react` — headless: `useClaudeSession`, the pure transcript reducer
  (`src/transcript.ts`, framework-free, unit-tested — keep rendering out), and the browser tool
  host (`tool-host.ts`) running server-bridged calls in the tab. Companions must ride the hook's
  own `handle` — the bridge asks the first attached client, so a second handle sees nothing.
- `packages/ui` — styled layer (Tailwind v4 + `@base-ui/react` + cva): `src/components/ui`
  primitives, `src/components/agent` components, vendored prompt-area composer (MIT). Ships source
  styles (`theme.css` + `@source`-scanned classnames; wiring in its README).
- `apps/web` — dashboard (TanStack Router, hash history); create forms are engine-aware via
  `src/lib/engine.ts`, reconciling sticky localStorage choices against the chosen profile.
- `apps/docs` — Astro site → Pages via `docs.yml`. `examples` — dev entries with root-level deps
  the packages must not take. `docs/assets` — brand assets (rules in `BRAND.md`); the mark is
  inlined in `BrandMark.tsx`, `Header.astro` and both favicons — keep geometry identical.

Dependency direction: `protocol ← core ← queue ← server`, `protocol ← client ← react ← ui ← web`,
`sandbox` a leaf either side may use. The browser side (client/react/ui/apps) must never import
core/server, the Agent SDK, or any model SDK; `client` must never devDep on `react` — that edge is
the build-graph cycle turbo refuses.

## Tooling

pnpm workspace + turbo (`pnpm typecheck|test|build|lint`); typecheck is `tsgo` (TS 7 preview) and
covers `smoke/` + `examples/` too via `typecheck:extras` (they have tsconfigs but aren't packages,
so turbo never ran them); lint oxlint; `build/` via tsdown only on `prepack`/CI. Dev never builds
— the `@claude-worker/source` export condition resolves packages to `src/index.ts` (Node runs with
`--conditions=@claude-worker/source` + swc-node; Vite/vitest set `resolve.conditions`, vitest also
aliases). In-package imports use explicit `.ts` extensions. Releases go through **pnpm only** —
`npm publish` would ship `workspace:*` verbatim; see the packaging section of `docs/gotchas.md`
before touching versioning or the publish workflow.

## Testing

`pnpm test` — core: fake `queryFn` harness (no CLI spawn); server: real HTTP+WS integration incl.
job routes + webhook receiver; queue: fake runner; react: reducer + bridge e2e. Real-SDK smokes
cost tokens and never run in `pnpm test`, but permission-path or CLI-control-request changes need
one — the fake harness can't validate those payloads. Model-agnostic smokes live in `smoke/`:
`smoke:sandbox` is free, `smoke:live` and `smoke:sdk` are not.

## Wrapup Config

- check: `pnpm lint` + `pnpm typecheck`
- test: `pnpm test`
- push: yes — branch `master`, repo is public, and every push deploys the docs site.
- version_bump: yes — `pnpm version:set <x.y.z> && pnpm install --lockfile-only` (the 8 packages
  only; `workspace:*` needs no bumping, so the lockfile step is a no-op). 0.4.2 published.
- publish: yes — npm `@claude-worker` org, always through pnpm. Push a `v<x.y.z>` tag:
  `.github/workflows/publish.yml` runs `pnpm publish -r` under npm trusted publishing (OIDC, no
  NPM_TOKEN, automatic provenance), re-running the full CI gate, refusing a tag that disagrees
  with `packages/*/package.json`, and skipping versions already on the registry — a half-failed
  run is safe to re-run, and a prerelease tag goes out under `next`. Manual fallback is `pnpm
  publish:all`. Gatekeeper audit first. MIT (ui ships `src/` — allowlisted in gatekeeper.json).
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
