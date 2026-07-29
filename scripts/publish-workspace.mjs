#!/usr/bin/env node
/**
 * Publish every publishable workspace package, in dependency order.
 *
 * Used by `.github/workflows/publish.yml`, where authentication is npm trusted
 * publishing (OIDC) — no token, and the npm CLI notices the GitHub Actions OIDC
 * environment on its own. Locally the same command works through whatever auth
 * the operator already has (keybridge/Touch ID), which is why nothing here
 * touches credentials, registries, or .npmrc.
 *
 * Three things this does that a `for` loop over `npm publish` would not:
 *
 *   - Order is DERIVED, not listed. A package's build resolves a sibling's types
 *     through its published `build/index.d.mts`, so a sibling must be out first;
 *     a hardcoded order is one more thing to forget when a package is added.
 *     devDependencies are deliberately excluded from the graph — client devDeps
 *     on server, server deps on core, and that edge would make it a cycle.
 *   - A version already on the registry is skipped, not failed. Publishing 8
 *     packages is 8 chances to fail halfway; a re-run has to be able to finish
 *     the job rather than trip over the ones that already made it.
 *   - `npm publish` runs each package's own `prepack` (clean + tsdown build), so
 *     CI ships bytes built the same way a local publish builds them.
 *
 *   node scripts/publish-workspace.mjs                     # publish
 *   node scripts/publish-workspace.mjs --dry-run           # pack + report, no upload
 *   node scripts/publish-workspace.mjs --expect-version=0.5.0
 */
import { spawnSync } from 'node:child_process'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = new URL('..', import.meta.url).pathname
const PACKAGES = join(ROOT, 'packages')
const SCOPE = '@claude-worker/'
/** devDependencies excluded on purpose — see the header. */
const DEP_FIELDS = ['dependencies', 'peerDependencies', 'optionalDependencies']

const args = process.argv.slice(2)
const dryRun = args.includes('--dry-run')
const expected = args.find((a) => a.startsWith('--expect-version='))?.split('=')[1]

const fail = (message) => {
  console.error(message)
  process.exit(1)
}

const packages = readdirSync(PACKAGES, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => {
    const dir = join(PACKAGES, entry.name)
    return { dir, json: JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) }
  })
  .filter((pkg) => pkg.json.private !== true)

if (packages.length === 0) fail('no publishable packages found under packages/')

if (expected) {
  const wrong = packages.filter((pkg) => pkg.json.version !== expected)
  if (wrong.length > 0) {
    fail(
      `expected every package at ${expected}, but:\n` +
        wrong.map((pkg) => `  - ${pkg.json.name} is ${pkg.json.version}`).join('\n') +
        '\n\nfix with: pnpm version:set <version> && pnpm install --lockfile-only',
    )
  }
}

/** Topological order over local `@claude-worker/*` runtime deps. */
const byName = new Map(packages.map((pkg) => [pkg.json.name, pkg]))
const localDeps = (pkg) =>
  DEP_FIELDS.flatMap((field) => Object.keys(pkg.json[field] ?? {})).filter(
    (name) => name.startsWith(SCOPE) && byName.has(name),
  )

const ordered = []
const state = new Map() // name -> 'visiting' | 'done'
const visit = (pkg, trail) => {
  const seen = state.get(pkg.json.name)
  if (seen === 'done') return
  if (seen === 'visiting') fail(`dependency cycle: ${[...trail, pkg.json.name].join(' -> ')}`)
  state.set(pkg.json.name, 'visiting')
  for (const dep of localDeps(pkg).sort()) visit(byName.get(dep), [...trail, pkg.json.name])
  state.set(pkg.json.name, 'done')
  ordered.push(pkg)
}
for (const pkg of [...packages].sort((a, b) => a.json.name.localeCompare(b.json.name))) {
  visit(pkg, [])
}

console.log(`publish order: ${ordered.map((pkg) => pkg.json.name).join(' -> ')}\n`)

/** `npm view` exits non-zero with E404 for an unpublished name *or* version. */
const isPublished = (pkg) => {
  const { name, version } = pkg.json
  const result = spawnSync('npm', ['view', `${name}@${version}`, 'version', '--json'], {
    encoding: 'utf8',
  })
  if (result.status === 0) return result.stdout.trim() !== ''
  const stderr = result.stderr ?? ''
  if (stderr.includes('E404')) return false
  fail(`could not query the registry for ${name}@${version}:\n${stderr || result.error}`)
}

const published = []
const skipped = []

for (const pkg of ordered) {
  const { name, version } = pkg.json
  if (isPublished(pkg)) {
    console.log(`- ${name}@${version} already on the registry, skipping`)
    skipped.push(`${name}@${version}`)
    continue
  }
  console.log(`\n=== publishing ${name}@${version}${dryRun ? ' (dry run)' : ''} ===`)
  const result = spawnSync('npm', ['publish', ...(dryRun ? ['--dry-run'] : [])], {
    cwd: pkg.dir,
    stdio: 'inherit',
  })
  if (result.status !== 0) {
    fail(
      `\n${name}@${version} failed to publish.\n` +
        (published.length > 0
          ? `already published this run: ${published.join(', ')}\n` +
            'those are permanent — re-run this workflow once the cause is fixed and they will be skipped.'
          : 'nothing was published.'),
    )
  }
  published.push(`${name}@${version}`)
}

const verb = dryRun ? 'would publish' : 'published'
console.log(
  `\ndone — ${verb} ${published.length}${published.length > 0 ? ` (${published.join(', ')})` : ''}` +
    `, ${skipped.length} already on the registry`,
)
