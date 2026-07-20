import { useState, type KeyboardEvent, type ReactNode } from 'react'
import { ArrowUp, Square } from 'lucide-react'
import { Button } from '../ui/Button.tsx'
import { cn } from '../../lib/utils.ts'

export interface ComposerProps {
  onSend: (text: string) => void
  onInterrupt: () => void
  busy: boolean
  /** Disable input entirely (session failed/closed). */
  disabled?: boolean
  placeholder?: string
  /** Left side of the toolbar row (mode selects, attachments, …). */
  toolbar?: ReactNode
  className?: string
}

/** Framed prompt input: auto-growing textarea over a toolbar row whose submit button
 * flips to stop while a turn is running (messages still queue while busy). */
export function Composer({
  onSend,
  onInterrupt,
  busy,
  disabled,
  placeholder = 'Message Claude…',
  toolbar,
  className,
}: ComposerProps) {
  const [text, setText] = useState('')

  const submit = () => {
    const trimmed = text.trim()
    if (!trimmed || disabled) return
    onSend(trimmed)
    setText('')
  }

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault()
      submit()
    }
  }

  const canSend = !disabled && text.trim().length > 0

  return (
    <div data-slot='composer' className={cn('px-3 pb-3', className)}>
      <div
        className={cn(
          'mx-auto w-full max-w-3xl overflow-hidden rounded-lg border border-border bg-bg shadow-(--shadow-xs)',
          'transition-colors focus-within:border-ring focus-within:ring-2 focus-within:ring-ring/30',
          disabled && 'opacity-60',
        )}>
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKeyDown}
          rows={1}
          disabled={disabled}
          placeholder={disabled ? 'Session ended' : placeholder}
          className={cn(
            'field-sizing-content max-h-48 min-h-11 w-full resize-none bg-transparent px-3 pt-2.5 pb-1 text-body-sm text-text',
            'placeholder:text-fg-4 outline-none disabled:pointer-events-none',
          )}
        />
        <div className='flex items-center justify-between gap-2 px-2 pb-2'>
          <div className='flex min-w-0 items-center gap-1'>{toolbar}</div>
          {busy ? (
            <Button
              variant='outline'
              size='icon-sm'
              aria-label='Interrupt'
              className='rounded-full'
              onClick={onInterrupt}>
              <Square className='size-3' />
            </Button>
          ) : (
            <Button
              size='icon-sm'
              aria-label='Send'
              className='rounded-full'
              disabled={!canSend}
              onClick={submit}>
              <ArrowUp className='size-4' />
            </Button>
          )}
        </div>
      </div>
      <div className='mx-auto mt-1 w-full max-w-3xl text-center text-label text-fg-4'>
        Enter to send · Shift+Enter for a new line
      </div>
    </div>
  )
}
