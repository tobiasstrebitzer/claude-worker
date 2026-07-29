#!/usr/bin/env node
/**
 * The workspace's version, set in one place.
 *
 * Publishable packages pin their `@claude-worker/*` dependencies to an exact
 * version rather than `workspace:*`, because publishing goes through plain
 * `npm publish` (via keybridge/Touch ID), which — unlike `pnpm publish` — does
 * NOT rewrite the workspace protocol. An unrewritten `workspace:*` reaches npm
 * verbatim and is uninstallable for every consumer.
 *
 * Pinning is only safe if `version` and every inter-package specifier move
 * together: `linkWorkspacePackages: true` symlinks a local package only while
 * the range still matches its version, so a half-done bump silently resolves
 * from the registry instead — you'd be developing against the last published
 * copy without a single error. Hence one script for both, and `--check` in CI.
 *
 * The apps stay on `workspace:*` on purpose: they are private, never published,
 * and so never need to be touched by a release.
 *
 *   node scripts/set-version.mjs 0.5.0   # bump everything, then: pnpm install --lockfile-only
 *   node scripts/set-version.mjs --check # verify consistency (CI, wrapup)
 */
import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = new URL('..', import.meta.url).pathname
const PACKAGES = join(ROOT, 'packages')
const SCOPE = '@claude-worker/'
const DEP_FIELDS = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']

const read = (dir) => {
  const path = join(PACKAGES, dir, 'package.json')
  return { path, dir, json: JSON.parse(readFileSync(path, 'utf8')) }
}

const packages = readdirSync(PACKAGES, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => read(entry.name))
  .filter((pkg) => pkg.json.private !== true)

if (packages.length === 0) {
  console.error('no publishable packages found under packages/')
  process.exit(1)
}

/** Local packages by name, so a dep on a sibling is distinguishable from a dep
 * on some other `@claude-worker/*` that isn't in this workspace. */
const local = new Map(packages.map((pkg) => [pkg.json.name, pkg]))

const arg = process.argv[2]

if (arg === '--check' || arg === undefined) {
  const problems = []
  const versions = new Set(packages.map((pkg) => pkg.json.version))
  if (versions.size > 1) {
    problems.push(
      `packages are not on one version: ${packages
        .map((pkg) => `${pkg.json.name}@${pkg.json.version}`)
        .join(', ')}`,
    )
  }
  for (const pkg of packages) {
    for (const field of DEP_FIELDS) {
      for (const [name, range] of Object.entries(pkg.json[field] ?? {})) {
        if (!name.startsWith(SCOPE) || !local.has(name)) continue
        const want = local.get(name).json.version
        if (range === want) continue
        problems.push(
          range.startsWith('workspace:')
            ? `${pkg.json.name} ${field}.${name} is '${range}' — publishing that through ` +
              '`npm publish` ships it verbatim and breaks every consumer'
            : `${pkg.json.name} ${field}.${name} is '${range}', but ${name} is ${want} — ` +
              'pnpm will resolve it from the registry instead of linking the local package',
        )
      }
    }
  }
  if (problems.length > 0) {
    console.error('version check failed:\n' + problems.map((p) => `  - ${p}`).join('\n'))
    console.error('\nfix with: pnpm version:set <version> && pnpm install --lockfile-only')
    process.exit(1)
  }
  console.log(`version check ok — ${packages.length} packages at ${[...versions][0]}`)
  process.exit(0)
}

if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(arg)) {
  console.error(`not a version: '${arg}'\nusage: node scripts/set-version.mjs <x.y.z> | --check`)
  process.exit(1)
}

let changed = 0
for (const pkg of packages) {
  const before = JSON.stringify(pkg.json)
  pkg.json.version = arg
  for (const field of DEP_FIELDS) {
    for (const name of Object.keys(pkg.json[field] ?? {})) {
      if (name.startsWith(SCOPE) && local.has(name)) pkg.json[field][name] = arg
    }
  }
  if (JSON.stringify(pkg.json) === before) continue
  writeFileSync(pkg.path, JSON.stringify(pkg.json, null, 2) + '\n')
  changed += 1
}

console.log(`set ${changed} package${changed === 1 ? '' : 's'} to ${arg}`)
console.log('now run: pnpm install --lockfile-only   (keeps the lockfile in step)')
