import { useEffect, useRef, useState } from 'react'
import { Brain, ChevronDown } from 'lucide-react'
import { cn } from '../../lib/utils.ts'
import { Response } from './Response.tsx'

export interface ReasoningProps {
  children: string
  /** Auto-opens while true, auto-closes shortly after it flips false. */
  isStreaming?: boolean
  defaultOpen?: boolean
  className?: string
}

/** Collapsible extended-thinking block: open while the model is thinking, tucks itself
 * away once the thought is finished (unless the user toggled it manually). */
export function Reasoning({ children, isStreaming = false, defaultOpen, className }: ReasoningProps) {
  const [open, setOpen] = useState(defaultOpen ?? isStreaming)
  const userToggled = useRef(false)

  useEffect(() => {
    if (userToggled.current) return
    if (isStreaming) {
      setOpen(true)
    } else {
      const timer = setTimeout(() => setOpen(false), 600)
      return () => clearTimeout(timer)
    }
  }, [isStreaming])

  return (
    <div data-slot='reasoning' data-streaming={isStreaming || undefined} className={cn('w-full', className)}>
      <button
        type='button'
        onClick={() => {
          userToggled.current = true
          setOpen((v) => !v)
        }}
        className='flex items-center gap-1.5 text-label text-fg-3 transition-colors outline-none hover:text-fg-1'>
        <Brain className='size-3.5' />
        <span>{isStreaming ? 'Thinking…' : 'Thought process'}</span>
        <ChevronDown className={cn('size-3.5 transition-transform', open && 'rotate-180')} />
      </button>
      {open ? (
        <div className='mt-2 border-l-2 border-border pl-3 text-body-sm text-fg-3 [&_*]:text-fg-3'>
          <Response streaming={isStreaming}>{children}</Response>
        </div>
      ) : null}
    </div>
  )
}
