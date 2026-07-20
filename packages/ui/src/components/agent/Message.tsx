import type { HTMLAttributes } from 'react'
import { cn } from '../../lib/utils.ts'

export interface MessageProps extends HTMLAttributes<HTMLDivElement> {
  from: 'user' | 'assistant'
}

/** One chat turn row. User messages sit right in a bubble; assistant content is flat,
 * full-width (the AI-chat convention — assistant output is the page, user input is quoted). */
export function Message({ from, className, ...props }: MessageProps) {
  return (
    <div
      data-slot='message'
      data-from={from}
      className={cn(
        'flex w-full flex-col gap-1',
        from === 'user' ? 'items-end' : 'items-start',
        className,
      )}
      {...props}
    />
  )
}

export function MessageContent({
  className,
  ...props
}: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      data-slot='message-content'
      className={cn(
        'min-w-0 text-body-sm leading-6 text-fg-1',
        // Bubble treatment only within a user message row.
        'in-data-[from=user]:max-w-[85%] in-data-[from=user]:rounded-lg in-data-[from=user]:rounded-br-sm',
        'in-data-[from=user]:bg-accent-bg in-data-[from=user]:px-3 in-data-[from=user]:py-2',
        'in-data-[from=user]:whitespace-pre-wrap',
        'in-data-[from=assistant]:w-full',
        className,
      )}
      {...props}
    />
  )
}
