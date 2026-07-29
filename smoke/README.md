# Manual smokes

Things `pnpm test` deliberately cannot check. Run these by hand.

| Script | Command | Costs money? |
| --- | --- | --- |
| Sandbox boundary | `pnpm smoke:sandbox` | No |
| Live model loop | `<KEY>=... pnpm smoke:live [provider] [model]` | **Yes — real tokens** |

## `smoke:sandbox` — the untrusted-code boundary

Eight scenarios covering the happy path, two escape attempts, two denial-of-service attempts,
the network gate, and cross-run isolation. Each prints what it proves, so a green run reads as
evidence rather than a wall of PASS lines. Exits non-zero if any scenario fails.

Run your own script inside the sandbox (the VFS is seeded with `/docs/example.txt`):

```bash
pnpm smoke:sandbox 'vfs.read("/docs/example.txt")'
pnpm smoke:sandbox 'while (true) {}'            # watch the deadline fire
pnpm smoke:sandbox 'require("fs")'              # watch it fail
```

## `smoke:live` — the model-agnostic loop against a real provider

The unit tests drive a fake model, so they cannot validate real tool-call payload shapes or
provider event drift. This closes that gap: the model is asked a question it can only answer by
running code over a file in the sandbox VFS, exercising **park → sandbox execute → message-state
replay → completion**.

```bash
MOONSHOT_API_KEY=...  pnpm smoke:live              # Kimi K3 (default)
OPENAI_API_KEY=...    pnpm smoke:live openai
ANTHROPIC_API_KEY=... pnpm smoke:live anthropic
ANTHROPIC_API_KEY=... pnpm smoke:live anthropic claude-opus-5
```

The document says `revenue: 4173`, `employees: 12`, so the only correct answer is **348** — a
model that guesses instead of running code gets it wrong visibly. The script exits non-zero if
the turn never completes, or if the model answered without calling the tool at all (which would
mean the loop was never exercised).

Run it against two providers to satisfy the PRD's SM-1 (same workflow, config swap only).
