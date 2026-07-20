import { useState } from 'react'
import type { TranscriptItem } from '@claude-worker/react'
import { ChevronDown, Wrench } from 'lucide-react'
import { Badge } from '../ui/Badge.tsx'
import { CodeBlock } from '../ui/CodeBlock.tsx'
import { Spinner } from '../ui/Spinner.tsx'
import { cn } from '../../lib/utils.ts'
import { toolInputPreview } from '../../lib/format.ts'

export type ToolCallItem = Extract<TranscriptItem, { kind: 'tool_call' }>

const RESULT_PREVIEW_CHARS = 2000

export interface ToolCallCardProps {
  item: ToolCallItem
  className?: string
}

export function ToolCallCard({ item, className }: ToolCallCardProps) {
  const [open, setOpen] = useState(false)
  const [fullResult, setFullResult] = useState(false)
  const running = item.result === undefined
  const isError = item.result?.isError === true

  const resultText = item.result?.text ?? ''
  const truncated = !fullResult && resultText.length > RESULT_PREVIEW_CHARS
  const shownResult = truncated ? resultText.slice(0, RESULT_PREVIEW_CHARS) : resultText

  return (
    <div
      data-slot='tool-call'
      data-state={running ? 'running' : isError ? 'error' : 'done'}
      className={cn('w-full overflow-hidden rounded-lg border border-border bg-surface', className)}>
      <button
        type='button'
        onClick={() => setOpen((v) => !v)}
        className={cn(
          'flex w-full items-center gap-2 px-3 py-2 text-left transition-colors outline-none',
          'hover:bg-surface-hover focus-visible:bg-surface-hover',
        )}>
        <Wrench className='size-3.5 shrink-0 text-fg-3' />
        <span className='shrink-0 font-mono text-body-sm font-medium text-fg-1'>{item.name}</span>
        <span className='min-w-0 flex-1 truncate font-mono text-label text-fg-4'>
          {toolInputPreview(item.input)}
        </span>
        {running ? (
          <Badge variant='info' className='shrink-0 gap-1'>
            <Spinner className='size-3 text-current' />
            Running
          </Badge>
        ) : isError ? (
          <Badge variant='danger' dot className='shrink-0'>
            Error
          </Badge>
        ) : (
          <Badge variant='success' dot className='shrink-0'>
            Done
          </Badge>
        )}
        <ChevronDown
          className={cn('size-3.5 shrink-0 text-fg-4 transition-transform', open && 'rotate-180')}
        />
      </button>
      {open ? (
        <div className='flex flex-col gap-2 border-t border-border p-2.5'>
          <CodeBlock code={JSON.stringify(item.input, null, 2)} label='Parameters' />
          {item.result !== undefined ? (
            <div>
              <CodeBlock
                code={shownResult || '(empty result)'}
                label={isError ? 'Error' : 'Result'}
                className={cn(isError && 'border-danger/40 [&_pre]:text-danger')}
              />
              {truncated ? (
                <button
                  type='button'
                  className='mt-1 text-label text-fg-3 underline-offset-2 hover:underline'
                  onClick={() => setFullResult(true)}>
                  Show all {resultText.length.toLocaleString()} chars
                </button>
              ) : null}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}
