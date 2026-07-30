# claude-worker

The turnkey [claude-worker](https://github.com/tobiasstrebitzer/claude-worker) instance: the
session gateway **and** the full dashboard, on one port, with nothing to clone.

```bash
npx claude-worker
```

That serves `http://127.0.0.1:8787` — dashboard at the root, API under `/v1` — and persists parked
sessions under `~/.claude-worker` so a restart doesn't drop them.

The `@claude-worker/*` packages are the libraries you embed in your own app. This one is the
service you run.

## Protecting it

```bash
npx claude-worker --auth-key "$SECRET" --host 0.0.0.0
```

One secret, two transports:

- **Browsers** get a login page, trade the secret for an `HttpOnly` session cookie, and use that
  for everything afterwards — including the WebSocket attach.
- **Services** send the same secret as an `x-claude-worker-key` header (or
  `Authorization: Bearer`).

The cookie is not a convenience. A browser cannot set a header on a WebSocket handshake at all, so
a cookie is the only credential a tab can present when it attaches to a session — and a cookie only
rides requests to the origin that set it. That is why the dashboard and the API share a port.

Neither transport authenticates *who* the person is; the secret is a door key. Put an
identity-aware proxy in front if you need more than that.

**Without `--auth-key`, the instance refuses to bind anything but a loopback address.** An
unauthenticated gateway on a routable interface is a Claude Code shell for anyone who can reach the
port. `--insecure` overrides that, for when something in front is doing the authenticating.

## Options

| Flag | Env | Default |
| --- | --- | --- |
| `--port <n>` | `CLAUDE_WORKER_PORT` | `8787` |
| `--host <addr>` | `CLAUDE_WORKER_HOST` | `127.0.0.1` |
| `--auth-key <secret>` | `CLAUDE_WORKER_AUTH_KEY` | none (no auth) |
| `--cwd-root <path>` (repeatable) | `CLAUDE_WORKER_CWD_ROOTS` (`:`-separated) | unrestricted |
| `--profile <name=dir>` (repeatable) | — | auto-detected from `~/.claude` |
| `--state-dir <path>` | `CLAUDE_WORKER_STATE_DIR` | beside the config file, else `~/.claude-worker` |
| `--no-parking-store` | — | durable parking on |
| `--config <path>` | — | `./claude-worker.config.mjs` |
| `--insecure`, `--open`, `--help`, `--version` | | |

Precedence is narrowest-wins: flags > env > config file > defaults.

## The config file

`authenticate`, `buildRunnerConfig` and `createEngineRunner` are functions, so they can't come from
a flag. `claude-worker.config.mjs` default-exports the
[`createWorkerServer` options](https://tobiasstrebitzer.github.io/claude-worker/docs/reference/server/)
(or a function, sync or async, returning them):

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
finding a credential the browser can actually present. There's a fuller example in
[`examples/claude-worker.config.mjs`](https://github.com/tobiasstrebitzer/claude-worker/blob/master/examples/claude-worker.config.mjs).

## Restart guard

```bash
npx claude-worker guard --wait 300 --allow-parked && systemctl restart claude-worker
```

Exits `0` when a restart is safe, `1` while a session is mid-turn, awaiting an approval, or parked
without durability behind it, and `2` when it couldn't tell — never treating "couldn't tell" as
safe. `--allow-parked` and `--allow-queued` are you asserting that the `SessionStore` and the
`QueueAdapter` respectively are durable; they're separate decisions. Point `--url` at any instance
and authenticate with `--token` or `--header name=value`.

## Credentials

claude-worker implements **no Anthropic auth**. The official SDK/CLI resolves credentials from the
operator's environment, per profile — `--auth-key` protects this gateway and nothing else. See the
project's
[Auth & Anthropic's terms](https://github.com/tobiasstrebitzer/claude-worker#auth--anthropics-terms).

## Mounting

The dashboard's assets resolve from an absolute `/assets/...`, so it must be served at a **domain
root**, not a subpath. A dedicated vhost reverse-proxying to the instance is the intended shape.

The dashboard itself is [`@claude-worker/web`](https://www.npmjs.com/package/@claude-worker/web),
a normal dependency of this package. Point `webRoot` in the config file at your own build to serve
a fork instead.

MIT
