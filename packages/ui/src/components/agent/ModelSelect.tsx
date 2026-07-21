import type { ModelOption } from '@claude-worker/protocol'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectItemText,
  SelectTrigger,
  SelectValue,
} from '../ui/Select.tsx'
import { cn } from '../../lib/utils.ts'

export interface ModelSelectProps {
  /** Models the session can switch to (TranscriptState.models). */
  models: ModelOption[]
  /** The session's current model id (TranscriptState.model), possibly decorated
   * (e.g. "claude-fable-5[1m]") — matched leniently against the options. */
  model?: string
  onModelChange: (model: string) => void
  disabled?: boolean
  className?: string
}

/** Find the option matching a (possibly decorated/aliased) session model id. */
function matchModel(models: ModelOption[], model?: string): ModelOption | undefined {
  if (!model) return undefined
  const normalized = model.replace(/\[.*\]$/, '')
  return (
    models.find((m) => m.value === normalized) ??
    models.find((m) => normalized.includes(m.value) || m.value.includes(normalized))
  )
}

/** Compact model switcher for the composer toolbar; fed by the `capabilities` event. */
export function ModelSelect({
  models,
  model,
  onModelChange,
  disabled,
  className,
}: ModelSelectProps) {
  const selected = matchModel(models, model)
  return (
    <Select
      value={selected?.value ?? null}
      onValueChange={(value) => {
        if (typeof value === 'string' && value !== selected?.value) onModelChange(value)
      }}
      disabled={disabled}>
      <SelectTrigger
        aria-label='Model'
        className={cn('h-6 max-w-56 border-transparent bg-transparent text-fg-3 hover:bg-surface-hover', className)}>
        <span className='truncate font-mono text-label'>
          <SelectValue placeholder={model ?? 'model'} />
        </span>
      </SelectTrigger>
      <SelectContent className='min-w-64'>
        {models.map((m) => (
          <SelectItem key={m.value} value={m.value}>
            <SelectItemText>{m.displayName}</SelectItemText>
            {m.description ? <span className='text-label text-fg-4'>{m.description}</span> : null}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}
