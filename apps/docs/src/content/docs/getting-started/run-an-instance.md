---
title: Run an instance
description: npx claude-worker — the session gateway and the full dashboard on one port, with nothing to clone.
order: 2
---

If you want claude-worker *running* rather than embedded, there is nothing to clone:

```bash
npx claude-worker
```

That serves `http://127.0.0.1:8787` — the dashboard at the root, the API under `/v1` — and
persists parked sessions under `~/.claude-worker` so a restart doesn't drop them. Anthropic
credentials come from your environment, exactly as they would for `claude` in a terminal; see
[Auth & Anthropic's terms](/claude-worker/docs/guides/auth/).

The `@claude-worker/*` packages are the libraries you embed. This one — the unscoped
[`claude-worker`](https://www.npmjs.com/package/claude-worker) — is the service you run.

## Protecting it

```bash
npx claude-worker --host 0.0.0.0 --auth-key "$SECRET" --cwd-root ~/projects
```

One secret, two transports:

- **Browsers** get a login page, trade the secret for an `HttpOnly` session cookie, and use that
  for everything afterwards — including the WebSocket attach.
- **Services** send the same secret as an `x-claude-worker-key` header (or
  `Authorization: Bearer`).

The cookie is not a convenience. A browser cannot set a header on a WebSocket handshake at all, so
a cookie is the only credential a tab can present when it attaches to a session — and a cookie
only rides requests to the origin that set it. That is why the dashboard and the API share a port,
and why an explicit `Origin` check (not `SameSite` alone) guards the upgrade: WebSocket upgrades
are exempt from CORS.

Neither transport establishes *who* the person is; the secret is a door key. Put an
identity-aware proxy in front if you need more than that.

**Without `--auth-key` the instance refuses to bind anything but a loopback address.** An
unauthenticated gateway on a routable interface is a Claude Code shell for anyone who can reach
the port. `--insecure` overrides that, for when something in front is doing the authenticating.

Behind TLS termination, add `--trust-proxy` — otherwise the session cookie loses its `Secure`
flag and the origin check computes `http://` where the browser says `https://`.

## Options

| Flag | Env | Default |
| --- | --- | --- |
| `--port <n>` | `CLAUDE_WORKER_PORT` | `8787` |
| `--host <addr>` | `CLAUDE_WORKER_HOST` | `127.0.0.1` |
| `--auth-key <secret>` | `CLAUDE_WORKER_AUTH_KEY` | none (no auth, loopback only) |
| `--cwd-root <path>` (repeatable) | `CLAUDE_WORKER_CWD_ROOTS` (`:`-separated) | unrestricted |
| `--profile <name=dir>` (repeatable) | — | auto-detected from `~/.claude` |
| `--state-dir <path>` | `CLAUDE_WORKER_STATE_DIR` | beside the config file, else `~/.claude-worker` |
| `--trust-proxy` | — | off |
| `--allowed-origin <o>` / `--allowed-host <name>` (repeatable) | — | loopback names only |
| `--no-parking-store` | — | durable parking on |
| `--config <path>` | — | `./claude-worker.config.mjs` |
| `--insecure`, `--open`, `--help`, `--version` | | |

Precedence is narrowest-wins: flags > env > config file > defaults.

## The config file

`authenticate`, `buildRunnerConfig` and `createEngineRunner` are functions, so they can't come
from a flag. `claude-worker.config.mjs` default-exports the
[`createWorkerServer` options](/claude-worker/docs/reference/server/) — or a function, sync or
async, returning them:

```js
export default {
  allowedCwdRoots: ['/srv/projects'],
  profiles: [{ name: 'me', configDir: '/home/me/.claude' }],
  requireApiKey: true,
  buildRunnerConfig: (req) => ({ ...req, env: { ...process.env, CI: '1' } }),
}
```

Supplying your own `authenticate` turns the built-in shared-secret auth **off entirely** — one
hook, one scheme, rather than two paths where only one got audited. If you take it over, you own
finding a credential the browser can actually present (see above: cookie, query-string ticket, or
a proxy that stamps it server-side).

## Mounting behind a proxy

The dashboard's assets resolve from an absolute `/assets/…`, so it must be served at a **domain
root**, not a subpath — a dedicated vhost reverse-proxying to the instance is the intended shape.
The dashboard itself is [`@claude-worker/web`](https://www.npmjs.com/package/@claude-worker/web),
an ordinary dependency of the CLI; point `webRoot` at your own build to serve a fork instead.

## Restarting safely

```bash
npx claude-worker guard --wait 300 --allow-parked && systemctl restart claude-worker
```

Exits `0` when a restart is safe, `1` while a session is mid-turn, awaiting an approval, or parked
without durability behind it, and `2` when it couldn't tell — never treating "couldn't tell" as
safe. Details, including `--allow-queued` and authenticating against a custom `authenticate` hook,
are in [Deployment](/claude-worker/docs/guides/deployment/#restarts-parked-sessions-and-the-deploy-guard).

## Where to go next

- [Quickstart](/claude-worker/docs/getting-started/quickstart/) — create a first session, then
  embed the panel in your own app.
- [Permissions](/claude-worker/docs/guides/permissions/) — the approval flow you'll be clicking
  through.
- [Profiles](/claude-worker/docs/guides/profiles/) — what a session runs as, and how to run one
  worker for several people.
