---
title: Introduction
description: What claude-worker is, why it exists, and what it deliberately does not try to be.
order: 1
---

claude-worker runs a **close-to-real Claude Code session** programmatically via the
[Anthropic Agent SDK](https://code.claude.com/docs/en/agent-sdk), and exposes it to a host
application as something it can **embed, watch, and control** — a side-panel that brings Claude
Code into your app.

## Why it exists

Claude Code is a terminal program. The Agent SDK lets you run the same engine from Node, but it
hands you a raw message stream with no hosting layer: no server your web app can talk to, no wire
protocol, no way to render a transcript or approve a tool call from a browser. claude-worker adds
exactly that missing layer:

- a **session server** your web app can talk to (HTTP + WebSocket),
- a **typed wire protocol** for the message stream, versioned from day one,
- **embeddable panel components** with approve/deny controls.

## What "close-to-real" means

A session created here behaves like Claude Code launched in the same directory:

- same skills (`.claude/skills/`),
- same `CLAUDE.md`,
- same MCP config surface,
- same permission system.

Pass `settingSources: ['user', 'project']` when creating a session and it picks up the target
repo's skills and `CLAUDE.md` — a prompt can be plain text or a skill invocation like
`/verify-content 42`.

## The stack at a glance

Seven packages, two apps, one dependency rule:

| Package | What it is |
| --- | --- |
| `@claude-worker/protocol` | The wire protocol: session events, commands, REST shapes. Dependency-free, browser-safe. The product boundary. |
| `@claude-worker/core` | `SessionRunner`: wraps the SDK's `query()`, promotes `canUseTool` into pending approvals, keeps a seq-numbered event log. No transport. |
| `@claude-worker/queue` | Job queue: one-shot unattended runs with concurrency limits, token budgets, and webhooks. |
| `@claude-worker/server` | HTTP + WebSocket gateway: session registry, pluggable auth hook, optional job-queue routes. |
| `@claude-worker/client` | Typed protocol client for browsers and Node. Zero runtime deps. |
| `@claude-worker/react` | Headless React layer: `useClaudeSession` + a pure transcript reducer. |
| `@claude-worker/ui` | Styled agent-control components: `SessionPanel`, transcript, permission prompts, composer. |

Plus `apps/web` (a full session-control dashboard) and `apps/demo` (a minimal-chrome consumer
proving the UI is portable). The browser side never imports the server side; the protocol is the
only bridge. See [Packages](/claude-worker/docs/reference/packages/) for the full map.

## Honest constraints

- **Hosting: no serverless.** The SDK spawns the Claude Code CLI as a long-running subprocess
  with filesystem state. Edge/serverless functions cannot host this. Realistic targets: a VM, a
  container with min-instances, any Node ≥22 host with a real filesystem.
- **Sessions are single-host in V1.** Transcripts live on the server's local disk (the SDK
  default); resume works across process restarts on the same host via `resume: sdkSessionId`.
- **The server trusts its host app.** `CreateSessionRequest` accepts `mcpServers` and tool
  policy; gate session creation behind your own auth and use `allowedCwdRoots` +
  `buildRunnerConfig` to clamp what clients may request. See
  [Deployment](/claude-worker/docs/guides/deployment/).
- **No Anthropic auth of its own.** Credentials are resolved by the official SDK/CLI from the
  operator's environment — see [Auth & Anthropic's terms](/claude-worker/docs/guides/auth/).

## Where to go next

- [Quickstart](/claude-worker/docs/getting-started/quickstart/) — run the dev server and
  dashboard, create your first session.
- [Embedding](/claude-worker/docs/guides/embedding/) — put the panel in your own app.
- [Permissions](/claude-worker/docs/guides/permissions/) — the sharp edge that makes it safe to
  point at a real checkout.
