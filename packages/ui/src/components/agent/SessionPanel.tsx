import { useMemo, type ReactNode } from 'react'
import type { ClaudeWorkerClient } from '@claude-worker/client'
import { useClaudeSession } from '@claude-worker/react'
import { cn } from '../../lib/utils.ts'
import { Composer } from './Composer.tsx'
import { ModelSelect } from './ModelSelect.tsx'
import { PermissionModeSelect } from './PermissionModeSelect.tsx'
import { PermissionPrompt } from './PermissionPrompt.tsx'
import { QuestionPrompt, parseUserQuestions } from './QuestionPrompt.tsx'
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
  const { state, connected, send, approve, deny, interrupt, setModel, setPermissionMode } =
    useClaudeSession(client, sessionId)
  const busy = state.status === 'running' || state.status === 'awaiting_approval'
  const ended = state.status === 'failed' || state.status === 'closed'

  // "/model" is handled panel-side (see handleSend) — surface it in the autocomplete
  // even though the CLI's command list doesn't include it.
  const commands = useMemo(() => {
    if (!state.commands) return undefined
    if (state.commands.some((c) => c.name === 'model')) return state.commands
    return [
      { name: 'model', description: 'Switch the model for this session', argumentHint: '<model>' },
      ...state.commands,
    ]
  }, [state.commands])

  // "/model <id>" switches the model directly instead of going to the CLI.
  const handleSend = (text: string) => {
    const modelCommand = /^\/model\s+(\S+)$/.exec(text)
    if (modelCommand) {
      setModel(modelCommand[1])
      return
    }
    send(text)
  }

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
            {state.pendingApprovals.map((request) =>
              request.toolName === 'AskUserQuestion' &&
              parseUserQuestions(request.input).length > 0 ? (
                <QuestionPrompt
                  key={request.id}
                  request={request}
                  onAnswer={approve}
                  onDismiss={deny}
                />
              ) : (
                <PermissionPrompt
                  key={request.id}
                  request={request}
                  onApprove={approve}
                  onDeny={deny}
                />
              ),
            )}
          </div>
        </div>
      ) : null}
      <Composer
        onSend={handleSend}
        onInterrupt={interrupt}
        busy={busy}
        disabled={ended || !sessionId}
        commands={commands}
        toolbar={
          <>
            {state.models?.length ? (
              <ModelSelect
                models={state.models}
                model={state.model}
                onModelChange={setModel}
                disabled={ended}
              />
            ) : null}
            {state.permissionMode ? (
              <PermissionModeSelect
                mode={state.permissionMode}
                onModeChange={setPermissionMode}
                disabled={ended}
              />
            ) : null}
          </>
        }
      />
    </div>
  )
}
