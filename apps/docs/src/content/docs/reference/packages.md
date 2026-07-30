---
title: Packages
description: The eight packages, two apps, and the one dependency rule that holds them together.
order: 1
---

## The packages

| Package | What it is |
| --- | --- |
| [`@claude-worker/protocol`](https://www.npmjs.com/package/@claude-worker/protocol) | The wire protocol: session events, commands, REST shapes. Dependency-free, browser-safe. **This is the product boundary** — versioned from day one. |
| [`@claude-worker/core`](https://www.npmjs.com/package/@claude-worker/core) | The engines. `SessionRunner` wraps `query()`, owns the streaming input, promotes `canUseTool` calls into pending approvals, normalizes SDK messages into protocol events, keeps a seq-numbered event log for attach/replay. `AiSdkRunner` is the model-agnostic engine over the AI SDK's `ToolLoopAgent`, with tool execution behind a swappable `ToolExecutor` seam (in-process sandbox, browser tab, or deferred) and `park()`/`restore` for work that outlives the runner. Both implement one `Runner` interface. Pure library, no transport. |
| [`@claude-worker/sandbox`](https://www.npmjs.com/package/@claude-worker/sandbox) | The untrusted-code boundary: a QuickJS-NG WASM guest with interpreter-enforced memory and time limits, an in-memory scratch VFS, and a by-value host bridge. A leaf like `protocol` — usable from the server or a browser tab, importing neither. |
| [`@claude-worker/queue`](https://www.npmjs.com/package/@claude-worker/queue) | The job queue: remote services schedule one-shot runs; jobs execute as ordinary sessions with bounded concurrency and token budgets, delivering progress + completion via webhooks. A run waiting on a deferred execution parks — no slot, no ticking clock — and resumes when the result lands. Pluggable `QueueAdapter` (in-memory bundled; redis/bullmq/pubsub can implement the same contract). |
| [`@claude-worker/server`](https://www.npmjs.com/package/@claude-worker/server) | The gateway: HTTP + WebSocket, session registry (create/list/attach/interrupt/kill), pluggable auth hook, profiles (which also pick the engine), optional job-queue routes, the browser tool-call bridge, and parked-session storage for deferred execution. Runs anywhere Node ≥22 runs. |
| [`@claude-worker/client`](https://www.npmjs.com/package/@claude-worker/client) | Typed protocol client for browsers and Node: REST + WebSocket attach with auto-reconnect and replay-from-last-seq. Zero runtime deps. |
| [`@claude-worker/react`](https://www.npmjs.com/package/@claude-worker/react) | The headless React layer: `useClaudeSession` hook + pure transcript reducer. No styling opinion. |
| [`@claude-worker/ui`](https://www.npmjs.com/package/@claude-worker/ui) | The styled agent-control component library: session panel (status bar, streaming transcript, tool-call cards, permission prompts, composer), session list, and the underlying primitives. Tailwind v4 + Base UI + cva; light/dark via tokens. |
| [`@claude-worker/web`](https://www.npmjs.com/package/@claude-worker/web) | The dashboard as **prebuilt static files**, for serving from your own host: `dashboardDir` is a path to `index.html` + hashed assets. Zero runtime dependencies — React, the router and Tailwind are compiled in. Must be mounted at a domain root with the gateway same-origin under `/v1`. |

## The instance

Everything above is a library you embed. This one is a service you run.

| Package | What it is |
| --- | --- |
| [`claude-worker`](https://www.npmjs.com/package/claude-worker) | The turnkey instance: `npx claude-worker` serves the gateway and the full dashboard on one port, with shared-secret auth (login cookie for browsers, header for services), durable parking, and `claude-worker guard`. Config that can't fit on a command line goes in a `claude-worker.config.mjs` default-exporting the `createWorkerServer` options. |

## The apps

| App | What it is |
| --- | --- |
| `apps/docs` | This documentation site (Astro), deployed to GitHub Pages on push to `master`. |

## The dependency rule

```text
              protocol            sandbox
             /        \          (leaf: either side)
   (server side)    (browser side)
        core           client
         |               |
       queue           react
         |               |
       server            ui
                         |
                        web
```

`@claude-worker/protocol` depends on nothing and everything depends on it; `@claude-worker/sandbox`
is the same kind of leaf, usable from either side. The browser side (client / react / ui / apps)
must never import core, server, the Agent SDK, or any model SDK — the wire protocol is the only
bridge. This rule is what keeps the protocol honest as the product
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
