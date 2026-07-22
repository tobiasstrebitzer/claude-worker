---
title: Auth & Anthropic's terms
description: claude-worker performs no Anthropic authentication of its own — what that means for operators and contributors.
order: 6
---

**claude-worker performs no Anthropic authentication of its own — by design.** It spawns the
official Agent SDK, which spawns the official Claude Code CLI, which resolves whatever
credentials the *operator's* environment provides: `ANTHROPIC_API_KEY`, Bedrock/Vertex platform
auth, or the operator's own stored `claude login`. claude-worker never implements claude.ai
OAuth, never reads, stores, or proxies tokens, and never touches `~/.claude` credentials. Which
credentials your deployment uses — and whether that use complies with
[Anthropic's terms](https://www.anthropic.com/legal/consumer-terms) — is the operator's
responsibility.

## Where we understand the lines to be

Not legal advice:

- **API key (or Bedrock/Vertex) is the supported path** for anything that is a service:
  unattended/scheduled runs, multi-user deployments, anything you expose to others. Anthropic's
  Agent SDK docs are explicit that third-party developers may not offer claude.ai login or
  subscription rate limits in their products; the Consumer Terms restrict automated access
  except via API key. Set `ANTHROPIC_API_KEY` in the server environment, and consider
  `requireApiKey: true` on `createWorkerServer` to **fail closed**: sessions that initialize on
  subscription credentials (`apiKeySource: 'oauth'`) are terminated with an error.
- **Your own subscription, your own single-user use** (the equivalent of running `claude -p`
  yourself) is the one case where subscription credentials may be appropriate. Without
  `requireApiKey`, the server allows it but logs a one-time notice; the auth provenance is also
  visible per session as `apiKeySource` on `SessionInfo` and the `system_init` event.

## requireApiKey: fail closed

```ts
const worker = createWorkerServer({
  authenticate,
  requireApiKey: true, // recommended for services and any unattended use
})
```

Each session's credential provenance surfaces as `apiKeySource` on `SessionInfo` and the
`system_init` event; `'oauth'` means claude.ai subscription credentials, other values
(`'user' | 'project' | 'org' | 'temporary'`) are API-key provenance. With
`requireApiKey: true`, an `'oauth'` session is terminated with a `session_error` telling the
operator to set `ANTHROPIC_API_KEY` (or Bedrock/Vertex auth). Without it, the server logs a
one-time notice instead — appropriate only for personal single-user deployments.

## Profiles on shared machines

[Profiles](/claude-worker/docs/guides/profiles/) let one worker serve several operators, each
under their own Claude Code config dir — selected via the CLI's own `CLAUDE_CONFIG_DIR`
mechanism, never by touching the credential chain. The auth-relevant part: **scope profiles per
caller** with `allowedProfiles` on the `authenticate` principal. A shared dashboard where anyone
may run under anyone's account is multi-account pooling — exactly the red line below — while
each person running under their own profile is just each person using their own account. The
subscription notice logs per profile, and `apiKeySource` shows what each session actually used.

## Compliance status: under review

We are still working through greenlighting the compliance and legal posture of this project —
with our own legal/compliance specialists and, where appropriate, explicit approval from
Anthropic (whose Agent SDK docs provide for previously-approved exceptions). Until that
concludes, treat the guidance above as our good-faith reading, not a settled position, and do
your own diligence.

## Red lines for contributors

PRs crossing these will be rejected:

- no claude.ai OAuth flows or login UI,
- no extraction/storage/forwarding of subscription tokens,
- no spoofing of Claude Code's client identity,
- no multi-account pooling or rate-limit circumvention of any kind.

The auth layer stays 100% Anthropic-owned code. Policy enforcement lives in configuration
(`requireApiKey`, the one-time notice, `apiKeySource` visibility), never in tampering with the
credential chain.

## Related

- [Deployment](/claude-worker/docs/guides/deployment/) — the host-app auth hook
  (`authenticate`), which is a separate concern from Anthropic credentials.
- [Server reference](/claude-worker/docs/reference/server/) — `requireApiKey` and the rest of
  the options.
