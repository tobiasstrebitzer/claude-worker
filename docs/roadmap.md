# Roadmap & open questions

What's shipped, what's next, and what's still undecided. Status as of 2026-07-30.

## Shipped

- **V1 runner + protocol + server + client + panel** (2026-07-20) — the original acceptance
  scope: create/attach/interrupt a live session, approve/deny from the panel, resume after
  reload, prove embeddability with a second consumer.
- **Styled UI layer + web dashboard** (2026-07-20) — `packages/ui`, `apps/web`, headless
  `@claude-worker/react`, resume backfill, SessionInfo rollups.
- **Model switching, slash commands, prompt-area composer** (2026-07-21).
- **Job queue + hardening** (2026-07-21) — budgets, retries, watchdog, retention, live
  `/queue/ws` stream, question prompts + `questionBehavior` policies.
- **Session telemetry** (2026-07-21) — `context_usage` / `rate_limit` / `permission_mode_changed`
  promoted first-class; StatusBar usage rings (render nothing, never 0%, until data arrives —
  API-key sessions may never emit rate-limit events); model + permission-mode selects.
- **Profiles** (2026-07-22) — named Claude Code config dirs (`CLAUDE_CONFIG_DIR` per session):
  server-declared with per-profile defaults, required-unless-single on create, auto-detected
  `default` from `~/.claude`, `allowedProfiles` scoping on the auth principal, `GET /profiles`
  (+ `/profiles/:name` config snapshot), dashboard Profiles list/detail + pickers on both
  create forms.
- **Permission-mode fixes** (2026-07-22) — `allowDangerouslySkipPermissions` passthrough so
  live sessions can switch into `bypassPermissions` (smoke-verified CLI refusal without it);
  `dontAsk` added to the mode select; `protocol_error` frames surfaced (`onProtocolError` →
  SessionPanel toast); pre-session model list synced to the CLI's current lineup.
- **SDK 0.3 + bypass policy** (2026-07-22) — agent-sdk `^0.2.86` → `^0.3.217` (bundled CLI now
  reports the current model lineup; `canUseTool` gained `requestId`, `SessionMessage` gained
  `parent_agent_id` — tests updated, protocol mirrors unchanged); `disableBypassPermissions`
  server policy (403 explicit mode, strip the capability, refuse the WS switch); per-job
  bypass opt-in on the schedule form.

- **Model-agnostic runtime** (2026-07-29, branch `feat/model-agnostic-runtime`) — `AiSdkRunner`
  (AI SDK v7 ToolLoopAgent, streamed: per-token `stream_delta` + per-step messages) behind the
  shared `Runner` interface; provider profiles +
  `createEngineRunner`; QuickJS sandbox package with browser-bridged execution; capability-scoped
  tools (`fs_*`, `eval_script`, `web_search`, `download`, `web_fetch` with SSRF guard + model
  digest, `deliver_file` → `file_delivered` + `GET /sessions/:id/files` routes + download card);
  live MCP over http/sse (`connectMcpTools`, DeepWiki-verified `smoke:mcp`). Protocol v3.

- **Deferred execution** (2026-07-29) — a session can now park on work nothing here is doing:
  `DeferredExecutor` + per-call `describe()` on the executor seam, `Runner.park()` →
  `RunnerSnapshot` → `restore` (same id, same event log, same seq numbering, mid-turn),
  `SessionParkManager` + the `SessionStore` seam in the server, `POST /executions/:id/result`
  with idempotent-by-`executionId` application, an execution watchdog whose timeout reaches the
  agent as ordinary tool output, and `parked` job runs that free their concurrency slot and stop
  their wall-clock budget (`job_parked` / `job_resumed`, `maxParkedDurationMs`). Parked sessions
  stay readable and downloadable from their snapshot; attaching wakes them. Protocol v4.

- **Release pipeline** (2026-07-30) — a `v*` tag publishes all 8 packages from CI under npm
  trusted publishing (OIDC, no NPM_TOKEN, automatic provenance). Inter-package deps went back to
  `workspace:*` now that `pnpm publish -r` does the packing, which retired the exact-pin scheme,
  both release scripts, and the `check:versions` guard. 0.4.1 is the first release through it.

## Next

1. **Dual-engine as the product shape.** The model-agnostic runner is the new direction — not a
   side experiment. Both engines (Claude Code via the Agent SDK, and the AI SDK runner) as
   cleanly co-equal options, aligned with the web UI.
   *Done (2026-07-29):* engine-aware create forms and session surfaces — `SessionInfo.engine`
   reported by each runner, `supportsPermissionMode` as the single source of truth for the
   restriction (forms filter, gateway 400s, startup refuses a bad profile default), operator-
   declared `provider.models` driving the model picker, CLI-only affordances (resumable SDK
   sessions, setting sources, bypass pre-authorization, the config-dir card) hidden for provider
   profiles; `createEngineRunner` may now be async, which unblocks per-session MCP connects.
   Also done: session grants on the profile (`session.capabilities` / `mcpServers` /
   `instructions`), with `CreateSessionRequest.capabilities` narrowing but never widening (400
   otherwise), MCP named-not-configured on the wire, and client-supplied MCP refused for provider
   sessions.
   Also done: profile management (`profileStore` seam with memory + JSON-file stores,
   `canManageProfiles` on the principal, `allowedConfigDirRoots` bounding managed Claude
   profiles, create/edit/delete in the dashboard). Startup-declared profiles stay immutable.
   *Left:* nothing structural — the dual-engine work is feature-complete for M4.5.
2. **Shared-backend `QueueAdapter`** (BullMQ or plain redis) — the reason the adapter contract
   exists. `claimNext` must stay atomic (BullMQ free; raw redis needs LMOVE/Lua) and honor
   `nextRunAt` (BullMQ delayed jobs); daily counters map to `INCRBY` on a dated key with TTL.
   Caveat: JobQueue assumes the claiming process runs the job — multi-worker deployments need a
   claim-lease/heartbeat so a dead worker doesn't strand jobs in `running`, and webhook ordering
   is per-process.
3. **Promote remaining `sdk_event` passthroughs** UIs care about: tool progress, task/subagent
   events, todo lists.
4. **Managed sandbox tier-2** — a hosted execution backend (Vercel/E2B) behind the existing
   `ToolExecutor` seam. Deliberately after deferred execution: if a third backend needs no
   runner-loop or protocol change, the seam held.
5. **Durable `SessionStore` / multi-host sessions** — the seam exists and parked sessions round-
   trip through it, but only the in-memory store is bundled, so a park survives a disconnect and
   not a restart. A durable store (and, for Claude-engine sessions, cross-host resume over the
   SDK's on-disk transcripts) is the remaining half.

## Open questions

- **Naming.** `claude-worker` says "queue worker"; the product is a session runner/remote
  control. Also: "claude" in an npm scope needs care re Anthropic trademark guidelines. Decide
  before or shortly after the repo goes public.
- **Compliance posture.** Legal/compliance review of the auth stance is in progress — see
  README "Auth & Anthropic's terms". Keep that section honest as it settles.
- **Small:** the Jobs schedule form's cwd input is React-controlled with localStorage state;
  automation-driven `fill` won't change it (fine for humans).
