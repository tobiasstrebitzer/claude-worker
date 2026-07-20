import type { SessionStatus } from '@claude-worker/protocol'
import type { BadgeProps } from '../ui/Badge.tsx'

export const STATUS_META: Record<
  SessionStatus,
  { label: string; variant: NonNullable<BadgeProps['variant']>; busy: boolean }
> = {
  starting: { label: 'Starting', variant: 'info', busy: true },
  running: { label: 'Running', variant: 'info', busy: true },
  awaiting_approval: { label: 'Needs approval', variant: 'warning', busy: true },
  idle: { label: 'Idle', variant: 'success', busy: false },
  failed: { label: 'Failed', variant: 'danger', busy: false },
  closed: { label: 'Closed', variant: 'neutral', busy: false },
}
