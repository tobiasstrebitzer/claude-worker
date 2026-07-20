import { useEffect, useMemo, useState } from 'react'
import { ClaudeWorkerClient } from '@claude-worker/client'
import type { PermissionMode, SessionInfo } from '@claude-worker/protocol'
import { Button, Input, SessionList, SessionPanel } from '@claude-worker/ui'

/**
 * Minimal-chrome consumer of @claude-worker/ui — proves the library is portable without
 * the full apps/web dashboard: one sidebar, one panel, no router.
 */
export function App() {
  const client = useMemo(
    () => new ClaudeWorkerClient({ baseUrl: `${location.origin}/v1` }),
    [],
  )
  const [sessions, setSessions] = useState<SessionInfo[]>([])
  const [activeId, setActiveId] = useState<string>()
  const [cwd, setCwd] = useState('')
  const [prompt, setPrompt] = useState('')
  const [mode, setMode] = useState<PermissionMode>('default')
  const [error, setError] = useState<string>()

  const refresh = () => client.listSessions().then(setSessions).catch((e) => setError(String(e)))
  useEffect(() => {
    void refresh()
    const timer = setInterval(() => void refresh(), 5000)
    return () => clearInterval(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const create = async () => {
    setError(undefined)
    try {
      const session = await client.createSession({
        cwd,
        prompt: prompt || undefined,
        permissionMode: mode,
        settingSources: ['user', 'project'],
      })
      setActiveId(session.id)
      await refresh()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  return (
    <div className='flex h-dvh bg-bg'>
      <aside className='flex w-72 shrink-0 flex-col gap-3 overflow-y-auto border-r border-border bg-sidebar p-3'>
        <h1 className='px-1 text-body-sm font-semibold text-fg-1'>claude-worker demo</h1>
        <div className='flex flex-col gap-2'>
          <Input
            value={cwd}
            placeholder='/path/to/repo'
            spellCheck={false}
            className='font-mono'
            onChange={(e) => setCwd(e.target.value)}
          />
          <Input
            value={prompt}
            placeholder='Initial prompt (optional)'
            onChange={(e) => setPrompt(e.target.value)}
          />
          <select
            value={mode}
            onChange={(e) => setMode(e.target.value as PermissionMode)}
            className='h-8 rounded-md border border-border bg-bg px-2 text-body-sm text-text outline-none'>
            <option value='default'>default (ask)</option>
            <option value='acceptEdits'>acceptEdits</option>
            <option value='plan'>plan</option>
            <option value='dontAsk'>dontAsk</option>
            <option value='auto'>auto</option>
          </select>
          <Button onClick={() => void create()} disabled={!cwd}>
            New session
          </Button>
          {error ? <p className='text-body-sm text-danger'>{error}</p> : null}
        </div>
        <SessionList sessions={sessions} activeId={activeId} onSelect={setActiveId} />
      </aside>
      <main className='flex min-w-0 flex-1 flex-col'>
        {activeId ? (
          <SessionPanel key={activeId} client={client} sessionId={activeId} />
        ) : (
          <div className='flex flex-1 items-center justify-center text-body-sm text-fg-4'>
            Create or select a session
          </div>
        )}
      </main>
    </div>
  )
}
