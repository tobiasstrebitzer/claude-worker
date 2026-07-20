import type { ReactNode } from 'react'
import type { ClaudeWorkerClient } from '@claude-worker/client'
import { useClaudeSession } from '@claude-worker/react'
import { cn } from '../../lib/utils.ts'
import { Composer } from './Composer.tsx'
import { PermissionPrompt } from './PermissionPrompt.tsx'
import { StatusBar } from './StatusBar.tsx'
import { Transcript } from './Transcript.tsx'

export interface SessionPanelProps {
  client: ClaudeWorkerClient
  sessionId: string | undefined
  /** Optional slot rendered at the top, above the status bar. */
  header?: ReactNode
  className?: string
}

/**
 * The all-in-one embeddable session surface: status bar, streaming transcript,
 * permission prompts, composer. Attaches via useClaudeSession; remount (key) to switch
 * sessions.
 */
export function SessionPanel({ client, sessionId, header, className }: SessionPanelProps) {
  const { state, connected, send, approve, deny, interrupt } = useClaudeSession(client, sessionId)
  const busy = state.status === 'running' || state.status === 'awaiting_approval'
  const ended = state.status === 'failed' || state.status === 'closed'

  return (
    <div
      data-slot='session-panel'
      className={cn('flex h-full min-h-0 flex-col overflow-hidden bg-bg', className)}>
      {header}
      <StatusBar state={state} connected={connected} />
      <Transcript state={state} />
      {state.pendingApprovals.length > 0 ? (
        <div className='px-3 pb-2'>
          <div className='mx-auto flex w-full max-w-3xl flex-col gap-2'>
            {state.pendingApprovals.map((request) => (
              <PermissionPrompt
                key={request.id}
                request={request}
                onApprove={approve}
                onDeny={deny}
              />
            ))}
          </div>
        </div>
      ) : null}
      <Composer onSend={send} onInterrupt={interrupt} busy={busy} disabled={ended || !sessionId} />
    </div>
  )
}
