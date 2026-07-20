import { type FunctionComponent, type ReactNode } from 'react'
import { Tooltip as TooltipPrimitive } from '@base-ui/react/tooltip'
import { cn } from '../../lib/utils.ts'

export const TooltipProvider = TooltipPrimitive.Provider

export const TooltipContent: FunctionComponent<
  TooltipPrimitive.Popup.Props & Pick<TooltipPrimitive.Positioner.Props, 'side' | 'sideOffset'>
> = ({ className, side = 'top', sideOffset = 6, ...props }) => (
  <TooltipPrimitive.Portal>
    <TooltipPrimitive.Positioner side={side} sideOffset={sideOffset} className='isolate z-60'>
      <TooltipPrimitive.Popup
        data-slot='tooltip-content'
        className={cn(
          'rounded-md border border-border bg-surface px-2 py-1 text-label text-fg-2 shadow-(--shadow-md) outline-none',
          className,
        )}
        {...props}
      />
    </TooltipPrimitive.Positioner>
  </TooltipPrimitive.Portal>
)

/** Convenience wrapper: <Tip content="..."><Button/></Tip> */
export function Tip({ content, children }: { content: ReactNode; children: ReactNode }) {
  return (
    <TooltipPrimitive.Root>
      <TooltipPrimitive.Trigger render={<span className='inline-flex' />}>
        {children}
      </TooltipPrimitive.Trigger>
      <TooltipContent>{content}</TooltipContent>
    </TooltipPrimitive.Root>
  )
}
