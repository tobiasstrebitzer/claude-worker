import { Volume } from 'memfs'

/**
 * Per-call in-memory scratch filesystem. Seeded from the task's documents,
 * discarded after the call — never backed by host paths. The guest only ever
 * touches it through the by-value host bridge (vfs_read/vfs_write/vfs_list).
 */
export type SandboxVfs = {
  read(path: string): string | undefined
  write(path: string, content: string): void
  /** File paths under `dir` (recursive), sorted. */
  list(dir?: string): string[]
  /** Full path → content map (e.g. to collect results after a run). */
  snapshot(): Record<string, string>
}

/** Collapse '.', '..' and empty segments into a rooted absolute path — the VFS
 * has no host backing to escape into, this is pure path hygiene. */
export function normalizeVfsPath(path: string): string {
  const out: string[] = []
  for (const part of path.split('/')) {
    if (part === '' || part === '.') continue
    if (part === '..') {
      out.pop()
      continue
    }
    out.push(part)
  }
  return '/' + out.join('/')
}

export function createVfs(seed?: Record<string, string>): SandboxVfs {
  const volume = new Volume()
  const write = (path: string, content: string): void => {
    const normalized = normalizeVfsPath(path)
    const dir = normalized.slice(0, normalized.lastIndexOf('/')) || '/'
    volume.mkdirSync(dir, { recursive: true })
    volume.writeFileSync(normalized, content)
  }
  for (const [path, content] of Object.entries(seed ?? {})) write(path, content)
  return {
    read(path) {
      try {
        return volume.readFileSync(normalizeVfsPath(path), 'utf8') as string
      } catch {
        return undefined
      }
    },
    write,
    list(dir = '/') {
      const prefix = normalizeVfsPath(dir)
      const files = Object.keys(volume.toJSON()).filter(
        (file) => prefix === '/' || file === prefix || file.startsWith(prefix + '/'),
      )
      return files.sort()
    },
    snapshot() {
      const json = volume.toJSON()
      const out: Record<string, string> = {}
      for (const [path, content] of Object.entries(json)) {
        if (typeof content === 'string') out[path] = content
      }
      return out
    },
  }
}
