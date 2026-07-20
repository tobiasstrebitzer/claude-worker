import type { TranscriptState } from '@claude-worker/react'
import { WifiOff } from 'lucide-react'
import { Badge } from '../ui/Badge.tsx'
import { Spinner } from '../ui/Spinner.tsx'
import { cn } from '../../lib/utils.ts'
import { formatCost } from '../../lib/format.ts'
import { STATUS_META } from './status.ts'

export interface StatusBarProps {
  state: TranscriptState
  connected: boolean
  className?: string
}

export function StatusBar({ state, connected, className }: StatusBarProps) {
  const meta = STATUS_META[state.status]
  return (
    <div
      data-slot='status-bar'
      className={cn(
        'flex items-center gap-2 border-b border-border bg-surface px-3 py-2',
        className,
      )}>
      <Badge variant={meta.variant} dot={!meta.busy}>
        {meta.busy ? <Spinner className='size-3 text-current' /> : null}
        {meta.label}
      </Badge>
      {state.model ? (
        <span className='truncate font-mono text-label text-fg-3'>{state.model}</span>
      ) : null}
      <span className='flex-1' />
      {!connected ? (
        <span className='inline-flex items-center gap-1 text-label text-warning'>
          <WifiOff className='size-3' /> reconnecting…
        </span>
      ) : null}
      <span className='font-mono text-label text-fg-3'>{formatCost(state.totalCostUsd)}</span>
    </div>
  )
}
