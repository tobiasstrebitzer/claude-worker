export function formatCost(usd: number | undefined): string {
  if (usd === undefined || Number.isNaN(usd)) return '—'
  if (usd === 0) return '$0.00'
  if (usd < 0.01) return '<$0.01'
  return `$${usd.toFixed(2)}`
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`
  const s = ms / 1000
  if (s < 60) return `${s.toFixed(1)}s`
  const m = Math.floor(s / 60)
  return `${m}m ${Math.round(s % 60)}s`
}

export function formatRelativeTime(epochMs: number | undefined, now = Date.now()): string {
  if (!epochMs) return '—'
  const diff = Math.max(0, now - epochMs)
  const s = Math.floor(diff / 1000)
  if (s < 60) return 'just now'
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ago`
  const d = Math.floor(h / 24)
  return `${d}d ago`
}

/** Compact one-line preview of a tool input for card headers. */
export function toolInputPreview(input: unknown, max = 80): string {
  if (input === null || input === undefined) return ''
  if (typeof input === 'object') {
    const o = input as Record<string, unknown>
    const primary =
      o.command ?? o.file_path ?? o.path ?? o.url ?? o.pattern ?? o.query ?? o.description
    if (typeof primary === 'string') {
      return primary.length > max ? primary.slice(0, max - 1) + '…' : primary
    }
  }
  const text = JSON.stringify(input) ?? ''
  return text.length > max ? text.slice(0, max - 1) + '…' : text
}
