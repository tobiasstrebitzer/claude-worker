import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import {
  ConfigError,
  defaultStateDir,
  isLoopback,
  loadConfigFile,
  parseArgs,
  resolveInstanceConfig,
} from '../src/config.ts'

const noConfig = { path: null, options: {} }

/**
 * Config fixtures live under the package rather than in os tmpdir: vitest loads
 * them through vite's module graph, which will not read a file outside the
 * project root. The CLI itself has no such limit — it runs on plain Node.
 */
const created: string[] = []
const tempConfigDir = async (): Promise<string> => {
  const dir = await mkdtemp(join(import.meta.dirname, '.tmp-config-'))
  created.push(dir)
  return dir
}
afterAll(async () => {
  await Promise.all(created.map((dir) => rm(dir, { recursive: true, force: true })))
})

describe('parseArgs', () => {
  it('parses the common flags', () => {
    const flags = parseArgs(['--port', '9000', '--host', '0.0.0.0', '--auth-key', 's3cret'])
    expect(flags.port).toBe(9000)
    expect(flags.host).toBe('0.0.0.0')
    expect(flags.authKey).toBe('s3cret')
  })

  it('accepts repeated profiles and cwd roots, resolving paths', () => {
    const flags = parseArgs(['--profile', 'toby=./a', '--profile', 'dan=./b', '--cwd-root', './c'])
    expect(flags.profiles).toEqual([
      { name: 'toby', configDir: resolve('./a') },
      { name: 'dan', configDir: resolve('./b') },
    ])
    expect(flags.cwdRoots).toEqual([resolve('./c')])
  })

  it('rejects a profile without a directory', () => {
    expect(() => parseArgs(['--profile', 'toby'])).toThrow(ConfigError)
    expect(() => parseArgs(['--profile', 'toby='])).toThrow(ConfigError)
  })

  it('rejects unknown options rather than ignoring them', () => {
    expect(() => parseArgs(['--porrt', '9000'])).toThrow(/unknown option/)
  })

  it('rejects a port that is not a port', () => {
    expect(() => parseArgs(['--port', 'http'])).toThrow(ConfigError)
    expect(() => parseArgs(['--port', '99999'])).toThrow(ConfigError)
  })

  it('treats a missing value as an error, not as the next flag', () => {
    expect(() => parseArgs(['--auth-key', '--port', '9000'])).toThrow(/requires a value/)
  })
})

describe('resolveInstanceConfig', () => {
  it('defaults to loopback on 8787', () => {
    const config = resolveInstanceConfig(parseArgs([]), noConfig, {})
    expect(config.port).toBe(8787)
    expect(config.host).toBe('127.0.0.1')
    expect(config.authKey).toBeUndefined()
  })

  it('lets flags beat env', () => {
    const config = resolveInstanceConfig(parseArgs(['--port', '1234']), noConfig, {
      CLAUDE_WORKER_PORT: '9999',
      CLAUDE_WORKER_AUTH_KEY: 'from-env',
    })
    expect(config.port).toBe(1234)
    expect(config.authKey).toBe('from-env')
  })

  it('refuses to serve unauthenticated on a routable address', () => {
    expect(() => resolveInstanceConfig(parseArgs(['--host', '0.0.0.0']), noConfig, {})).toThrow(
      /refusing to serve without auth/,
    )
  })

  it('allows it with a key, with --insecure, or on loopback', () => {
    expect(() =>
      resolveInstanceConfig(parseArgs(['--host', '0.0.0.0', '--auth-key', 'k']), noConfig, {}),
    ).not.toThrow()
    expect(() =>
      resolveInstanceConfig(parseArgs(['--host', '0.0.0.0', '--insecure']), noConfig, {}),
    ).not.toThrow()
    expect(() => resolveInstanceConfig(parseArgs(['--host', '::1']), noConfig, {})).not.toThrow()
  })

  it('accepts a config file that authenticates for itself', () => {
    const loaded = { path: '/x/claude-worker.config.mjs', options: { authenticate: () => ({}) } }
    const config = resolveInstanceConfig(parseArgs(['--host', '0.0.0.0']), loaded, {})
    expect(config.hostAuthenticates).toBe(true)
  })

  it('enables durable parking by default and --no-parking-store turns it off', () => {
    expect(resolveInstanceConfig(parseArgs([]), noConfig, {}).stateDir).toBeTruthy()
    expect(resolveInstanceConfig(parseArgs(['--no-parking-store']), noConfig, {}).stateDir).toBeNull()
  })

  it('reads cwd roots from a colon-separated env var', () => {
    const config = resolveInstanceConfig(parseArgs([]), noConfig, {
      CLAUDE_WORKER_CWD_ROOTS: '/tmp/a:/tmp/b',
    })
    expect(config.options.allowedCwdRoots).toEqual([resolve('/tmp/a'), resolve('/tmp/b')])
  })

  it('puts state beside the config file when there is one', () => {
    expect(defaultStateDir('/srv/worker/claude-worker.config.mjs')).toBe('/srv/worker/.claude-worker')
  })
})

describe('loadConfigFile', () => {
  it('returns empty options when there is no config file', async () => {
    const dir = await tempConfigDir()
    const loaded = await loadConfigFile(undefined, dir)
    expect(loaded).toEqual({ path: null, options: {} })
  })

  it('loads a default-exported object', async () => {
    const dir = await tempConfigDir()
    await writeFile(
      join(dir, 'claude-worker.config.mjs'),
      'export default { basePath: "/api", allowUnauthenticated: true }\n',
    )
    const loaded = await loadConfigFile(undefined, dir)
    expect(loaded.options.basePath).toBe('/api')
  })

  it('loads a default-exported function, including an async one', async () => {
    const dir = await tempConfigDir()
    await writeFile(
      join(dir, 'claude-worker.config.mjs'),
      'export default async () => ({ basePath: "/late" })\n',
    )
    const loaded = await loadConfigFile(undefined, dir)
    expect(loaded.options.basePath).toBe('/late')
  })

  it('fails loudly on an explicit path that does not exist', async () => {
    await expect(loadConfigFile('/nope/claude-worker.config.mjs')).rejects.toThrow(/no config file/)
  })

  it('fails on a config file with no default export', async () => {
    const dir = await tempConfigDir()
    await writeFile(join(dir, 'claude-worker.config.mjs'), 'export const port = 1\n')
    await expect(loadConfigFile(undefined, dir)).rejects.toThrow(/no default export/)
  })
})

describe('isLoopback', () => {
  it('knows the loopback addresses', () => {
    expect(isLoopback('127.0.0.1')).toBe(true)
    expect(isLoopback('::1')).toBe(true)
    expect(isLoopback('localhost')).toBe(true)
    expect(isLoopback('0.0.0.0')).toBe(false)
    expect(isLoopback('192.168.1.4')).toBe(false)
  })
})
