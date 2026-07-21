import type { PermissionMode } from '@claude-worker/protocol'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectItemText,
  SelectTrigger,
  SelectValue,
} from '../ui/Select.tsx'
import { cn } from '../../lib/utils.ts'

export type PermissionModeMeta = {
  value: PermissionMode
  label: string
  description: string
  dangerous?: boolean
}

/** The modes surfaced across UI surfaces (session creation, in-session switcher). */
export const PERMISSION_MODES: PermissionModeMeta[] = [
  { value: 'default', label: 'default', description: 'ask for approval' },
  { value: 'acceptEdits', label: 'acceptEdits', description: 'auto-approve file edits' },
  { value: 'plan', label: 'plan', description: 'read-only planning' },
  { value: 'auto', label: 'auto', description: 'model decides when to ask' },
  {
    value: 'bypassPermissions',
    label: 'bypassPermissions',
    description: 'no prompts (danger)',
    dangerous: true,
  },
]

export interface PermissionModeSelectProps {
  /** The session's current mode (TranscriptState.permissionMode). */
  mode?: PermissionMode
  onModeChange: (mode: PermissionMode) => void
  disabled?: boolean
  className?: string
}

/** Compact permission-mode switcher for the composer toolbar, next to ModelSelect. */
export function PermissionModeSelect({
  mode,
  onModeChange,
  disabled,
  className,
}: PermissionModeSelectProps) {
  const dangerous = mode === 'bypassPermissions'
  return (
    <Select
      value={mode ?? null}
      onValueChange={(value) => {
        if (typeof value === 'string' && value !== mode) onModeChange(value as PermissionMode)
      }}
      disabled={disabled}>
      <SelectTrigger
        aria-label='Permission mode'
        className={cn(
          'h-6 max-w-44 border-transparent bg-transparent hover:bg-surface-hover',
          dangerous ? 'text-danger' : 'text-fg-3',
          className,
        )}>
        <span className='truncate font-mono text-label'>
          <SelectValue placeholder='permissions' />
        </span>
      </SelectTrigger>
      <SelectContent className='min-w-56'>
        {PERMISSION_MODES.map((m) => (
          <SelectItem key={m.value} value={m.value}>
            <SelectItemText>
              <span className={cn('font-medium', m.dangerous && 'text-danger')}>{m.label}</span>
            </SelectItemText>
            <span className={cn('text-label', m.dangerous ? 'text-danger/80' : 'text-fg-4')}>
              {m.description}
            </span>
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}
