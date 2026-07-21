import { ModelSelect } from '@claude-worker/ui'
import { MODEL_OPTIONS } from '@/lib/settings.ts'

/** Form-styled model dropdown over the static alias list. '' = the CLI's default model. */
export function ModelPicker({
  value,
  onChange,
  className,
}: {
  value: string
  onChange: (value: string) => void
  className?: string
}) {
  return (
    <ModelSelect
      variant='form'
      models={MODEL_OPTIONS}
      model={value || undefined}
      onModelChange={(model) => onChange(model ?? '')}
      className={className}
    />
  )
}
