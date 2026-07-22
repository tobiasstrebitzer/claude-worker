---
title: Profiles
description: Named Claude Code config directories — one worker, several operators, each with their own settings, memory, skills, and credentials.
order: 4
---

A **profile** binds a name to a Claude Code config directory. Sessions and jobs run *under* a
profile: the spawned CLI process gets that directory as `CLAUDE_CONFIG_DIR`, so it loads the
directory's settings, memory, skills — and resolves whatever credentials it holds. The canonical
use case is a shared machine where several team members each keep their own config dir:

```ts
createWorkerServer({
  authenticate: async (req) => {
    const user = await verifyMyAppToken(req.headers.authorization)
    return user && { allowedProfiles: user.profiles } // e.g. ['toby']
  },
  profiles: [
    { name: 'toby', configDir: '/Users/atomic/toby/.claude', defaults: { model: 'opus' } },
    { name: 'dan', configDir: '/Users/atomic/dan/.claude' },
  ],
})
```

## Rules

- Profiles are **declared at startup**; the API only reads them (`GET /v1/profiles` to list,
  `GET /v1/profiles/:name` for a view-only config snapshot — settings.json highlights, memory,
  skills, agents, commands; env var names only, never values — shown on the dashboard's profile
  detail page). A nonexistent `configDir` fails `createWorkerServer` fast — the CLI would
  otherwise silently start from an empty config.
- With **more than one** profile declared, every `POST /sessions` and `POST /jobs` must name its
  `profile` (400 without one); with **exactly one** it is implicit. The resolved name always
  lands on `SessionInfo.profile` and `JobInfo.profile`, even when implicit.
- **No `profiles` option** → a `default` profile is auto-created from `$CLAUDE_CONFIG_DIR` or
  `~/.claude` when that directory exists, so single-operator deployments need no configuration.
  Pass `[]` to run without profiles (no env pinning at all).
- `defaults` (`model`, `permissionMode`) fill request fields the caller left unset — they are
  defaults, not enforced caps; an explicit request value wins.
- Profile pinning composes with `buildRunnerConfig`: the hook runs first, then the profile's
  `CLAUDE_CONFIG_DIR` is applied on top — the profile wins even if the hook set its own `env`.

## Access control

The `authenticate` principal may carry `allowedProfiles: string[]`. The server enforces it on
session and job creation (403 otherwise) and filters `GET /profiles` to it, so pickers only
show what the caller may use. On a multi-operator machine this scoping is what keeps one worker
serving several people from degrading into account sharing — give each caller their own
profile(s) rather than a free choice. See
[Auth & Anthropic's terms](/claude-worker/docs/guides/auth/) for why that line matters.

## Credentials

Profiles never touch the credential chain — they only select which config directory the
official CLI reads, via its own `CLAUDE_CONFIG_DIR` mechanism. Two consequences:

- `ANTHROPIC_API_KEY` in the **server's** environment wins for *every* profile (the SDK's
  normal precedence). Per-session provenance stays visible as `apiKeySource` on `SessionInfo`.
- The subscription-credentials notice logs once **per profile**, and `requireApiKey: true`
  fails closed regardless of profile.
