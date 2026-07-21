---
title: Permissions
description: Pending approvals, deny-on-timeout, permission modes, tool allowlists, and AskUserQuestion policies.
order: 2
---

Permissions are the sharp edge: they are what makes it safe to point a session at a real
checkout.

## The pending-approval flow

The runner's `canUseTool` hook promotes each tool call not covered by the permission mode into a
**pending approval**: a `permission_requested` event carrying a `PermissionRequest` (tool name,
input, display title/description, optional `expiresAt`). The tool blocks until a client resolves
it — over the WebSocket (`permission_decision` command), over REST, or via the runner directly:

```ts
runner.subscribe((event) => {
  if (event.type === 'permission_requested') {
    runner.resolvePermission(event.request.id, { behavior: 'allow' })
  }
})
```

Resolution emits `permission_resolved` with `resolvedBy: 'client' | 'timeout' | 'policy'`.

Two rules to know:

- **Deny-on-timeout.** Unresolved requests are denied after 5 minutes by default. Configurable
  server-wide (`defaultApprovalTimeoutMs` on the runner config) and per session
  (`approvalTimeoutMs` on `CreateSessionRequest`).
- **Allowing must echo the tool input.** The SDK's `PermissionResult` requires `updatedInput` to
  be a record on allow — the runner echoes the original input back for an unmodified allow. A
  client may instead pass a modified `updatedInput` to run the tool with edited arguments.

Denials can carry a `message` (reason surfaced to the model) and `interrupt: true` to also stop
the running turn.

## Permission modes

`permissionMode` on `CreateSessionRequest` (changeable live via the `set_permission_mode`
command): `default`, `acceptEdits`, `bypassPermissions`, `plan`, `dontAsk`, `auto`. Hosts choose
per session — `dontAsk` for unattended runs of trusted, allowlisted-tool skills vs interactive
approval for anything touching state.

## Tool allowlists and cwd clamping

Sessions can be constrained with `allowedTools` / `disallowedTools` on `CreateSessionRequest`,
and the server clamps where sessions may run with `allowedCwdRoots`. Use `buildRunnerConfig` on
the server to enforce policy regardless of what clients request — see
[Embedding](/claude-worker/docs/guides/embedding/).

## The REST resolve endpoint

`POST /v1/sessions/:id/permissions/:requestId` is the REST counterpart of the WS
`permission_decision` command, for controllers without a socket (e.g. answering a job's question
from a webhook consumer):

```json
{ "behavior": "allow", "updatedInput": { } }
```

or

```json
{ "behavior": "deny", "message": "not this file", "interrupt": true }
```

404 means the request is unknown, already resolved, or expired.

## AskUserQuestion and questionBehavior

The model's `AskUserQuestion` tool rides the same `canUseTool` path as any permission request.
Answers go back as an allow with `updatedInput.answers`: question text mapped to the chosen
option label(s), multi-select labels comma-joined — the shape the CLI's own UI uses. By the
tool's convention the first option of each question is the model's recommended choice.

`questionBehavior` on `CreateSessionRequest` policy-resolves it for unattended runs:

- **`'ask'`** (default) — a pending permission like any other. Interactive UIs render the
  question form; under the [job queue](/claude-worker/docs/guides/job-queue/), webhooks carry
  the full request on `job_progress` so a remote controller can answer over the REST resolve
  endpoint.
- **`'auto'`** — resolved immediately with each question's first (recommended) option.
- **`'deny'`** — the tool is refused with guidance to decide autonomously.
