import type { ReactNode } from 'react'
import { CopyButton } from './CopyButton.tsx'
import { cn } from '../../lib/utils.ts'

export interface CodeBlockProps {
  code: string
  /** Header label, e.g. a language or "Parameters". */
  label?: ReactNode
  copyable?: boolean
  className?: string
}

/** Plain (unhighlighted) code panel for structured data like tool inputs. Markdown code
 * inside assistant responses is highlighted by <Response> instead. */
export function CodeBlock({ code, label, copyable = true, className }: CodeBlockProps) {
  return (
    <div
      data-slot='code-block'
      className={cn('overflow-hidden rounded-md border border-border bg-code-bg', className)}>
      {label !== undefined || copyable ? (
        <div className='flex h-8 items-center justify-between border-b border-border px-2.5'>
          <span className='font-mono text-label text-fg-3'>{label}</span>
          {copyable ? <CopyButton value={code} /> : null}
        </div>
      ) : null}
      <pre className='max-h-64 overflow-auto px-3 py-2 font-mono text-label whitespace-pre-wrap text-fg-2'>
        {code}
      </pre>
    </div>
  )
}
