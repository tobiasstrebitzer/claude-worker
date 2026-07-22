# Roadmap & open questions

What's shipped, what's next, and what's still undecided. Status as of 2026-07-22.

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

## Next

1. **Shared-backend `QueueAdapter`** (BullMQ or plain redis) — the reason the adapter contract
   exists. `claimNext` must stay atomic (BullMQ free; raw redis needs LMOVE/Lua) and honor
   `nextRunAt` (BullMQ delayed jobs); daily counters map to `INCRBY` on a dated key with TTL.
   Caveat: JobQueue assumes the claiming process runs the job — multi-worker deployments need a
   claim-lease/heartbeat so a dead worker doesn't strand jobs in `running`, and webhook ordering
   is per-process.
2. **Promote remaining `sdk_event` passthroughs** UIs care about: tool progress, task/subagent
   events, todo lists.
3. **Custom `SessionStore` / multi-host sessions** — V1 is single-host by design (SDK on-disk
   transcripts); a store adapter for cross-host resume is designed but unimplemented.

## Open questions

- **Naming.** `claude-worker` says "queue worker"; the product is a session runner/remote
  control. Also: "claude" in an npm scope needs care re Anthropic trademark guidelines. Decide
  before or shortly after the repo goes public.
- **Compliance posture.** Legal/compliance review of the auth stance is in progress — see
  README "Auth & Anthropic's terms". Keep that section honest as it settles.
- **Small:** the Jobs schedule form's cwd input is React-controlled with localStorage state;
  automation-driven `fill` won't change it (fine for humans).
