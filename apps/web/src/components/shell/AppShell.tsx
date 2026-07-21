import type { ReactNode } from 'react'
import { Link, Outlet, useRouterState } from '@tanstack/react-router'
import { ListChecks, Settings, SquareTerminal } from 'lucide-react'
import { cn } from '@claude-worker/ui'
import { ThemeToggle } from './ThemeToggle.tsx'

const NAV = [
  { id: 'sessions', label: 'Sessions', icon: SquareTerminal, path: '/sessions' },
  { id: 'jobs', label: 'Jobs', icon: ListChecks, path: '/jobs' },
  { id: 'settings', label: 'Settings', icon: Settings, path: '/settings' },
] as const

export function AppShell({ children }: { children?: ReactNode }) {
  const pathname = useRouterState({ select: (s) => s.location.pathname })
  return (
    <div className='flex h-dvh bg-sidebar'>
      <aside className='flex w-52 shrink-0 flex-col gap-1 p-3'>
        <div className='flex items-center gap-2 px-2 py-2'>
          <SquareTerminal className='size-4 text-fg-1' />
          <span className='text-body-sm font-semibold tracking-tight text-fg-1'>claude-worker</span>
        </div>
        <nav className='mt-1 flex flex-1 flex-col gap-0.5'>
          {NAV.map((item) => {
            const active = pathname.startsWith(item.path)
            return (
              <Link
                key={item.id}
                to={item.path}
                className={cn(
                  'flex items-center gap-2 rounded-md px-2 py-1.5 text-body-sm transition-colors outline-none',
                  active
                    ? 'bg-surface font-medium text-fg-1 shadow-(--shadow-xs)'
                    : 'text-fg-3 hover:bg-surface-hover hover:text-fg-1',
                )}>
                <item.icon className='size-4' />
                {item.label}
              </Link>
            )
          })}
        </nav>
        <div className='flex items-center justify-between px-1'>
          <span className='font-mono text-label text-fg-4'>v0.1</span>
          <ThemeToggle />
        </div>
      </aside>
      <main className='frame-shine m-2 ml-0 flex min-w-0 flex-1 flex-col overflow-hidden rounded-xl'>
        {children ?? <Outlet />}
      </main>
    </div>
  )
}
