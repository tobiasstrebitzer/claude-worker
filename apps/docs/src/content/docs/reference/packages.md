---
title: Packages
description: The seven packages, two apps, and the one dependency rule that holds them together.
order: 1
---

## The packages

| Package | What it is |
| --- | --- |
| [`@claude-worker/protocol`](https://www.npmjs.com/package/@claude-worker/protocol) | The wire protocol: session events, commands, REST shapes. Dependency-free, browser-safe. **This is the product boundary** — versioned from day one. |
| [`@claude-worker/core`](https://www.npmjs.com/package/@claude-worker/core) | The session runner: wraps `query()`, owns the streaming input, promotes `canUseTool` calls into pending approvals, normalizes SDK messages into protocol events, keeps a seq-numbered event log for attach/replay. Pure library, no transport. |
| [`@claude-worker/queue`](https://www.npmjs.com/package/@claude-worker/queue) | The job queue: remote services schedule one-shot runs; jobs execute as ordinary sessions with bounded concurrency and token budgets, delivering progress + completion via webhooks. Pluggable `QueueAdapter` (in-memory bundled; redis/bullmq/pubsub can implement the same contract). |
| [`@claude-worker/server`](https://www.npmjs.com/package/@claude-worker/server) | The gateway: HTTP + WebSocket, session registry (create/list/attach/interrupt/kill), pluggable auth hook, optional job-queue routes. Runs anywhere Node ≥22 runs. |
| [`@claude-worker/client`](https://www.npmjs.com/package/@claude-worker/client) | Typed protocol client for browsers and Node: REST + WebSocket attach with auto-reconnect and replay-from-last-seq. Zero runtime deps. |
| [`@claude-worker/react`](https://www.npmjs.com/package/@claude-worker/react) | The headless React layer: `useClaudeSession` hook + pure transcript reducer. No styling opinion. |
| [`@claude-worker/ui`](https://www.npmjs.com/package/@claude-worker/ui) | The styled agent-control component library: session panel (status bar, streaming transcript, tool-call cards, permission prompts, composer), session list, and the underlying primitives. Tailwind v4 + Base UI + cva; light/dark via tokens. |

## The apps

| App | What it is |
| --- | --- |
| `apps/web` | Full session-control web app (dashboard): session list, create/resume flow, live panel, jobs view, profiles, settings. TanStack Router, hash history. |

## The dependency rule

```text
              protocol
             /        \
   (server side)    (browser side)
        core           client
         |               |
       queue           react
         |               |
       server            ui
                         |
                        web
```

`@claude-worker/protocol` depends on nothing and everything depends on it. The browser side
(client / react / ui / apps) must never import core, server, or the Agent SDK — the wire
protocol is the only bridge. This rule is what keeps the protocol honest as the product
boundary: anything a client needs must be expressible as protocol events and commands.

## Which package do I need?

- Embedding a panel in a web app: `@claude-worker/client` + `@claude-worker/ui` (which pulls in
  `react`), against a running `@claude-worker/server`. See
  [Embedding](/claude-worker/docs/guides/embedding/).
- Custom rendering: `@claude-worker/client` + `@claude-worker/react` (headless).
- Sessions in-process with no server: `@claude-worker/core` directly.
- Scheduling unattended runs: the `queue` option on the server plus the client's job methods —
  or `@claude-worker/queue` directly to embed the queue in a custom host or write a
  shared-backend adapter. See [Job queue](/claude-worker/docs/guides/job-queue/).
- Speaking the wire format from another language or runtime: the shapes in
  [`@claude-worker/protocol`](https://www.npmjs.com/package/@claude-worker/protocol) — see
  [Protocol](/claude-worker/docs/reference/protocol/).
