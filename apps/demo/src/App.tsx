import { useEffect, useMemo, useState } from 'react'
import { ClaudeWorkerClient } from '@claude-worker/client'
import type { PermissionMode, SessionInfo } from '@claude-worker/protocol'
import { SessionPanel } from '@claude-worker/react'

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
    refresh()
    const timer = setInterval(refresh, 5000)
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
    <div className="demo-layout">
      <aside className="demo-sidebar">
        <h1>claude-worker demo</h1>
        <div className="demo-form">
          <label>
            Project directory
            <input value={cwd} placeholder="/path/to/repo" onChange={(e) => setCwd(e.target.value)} />
          </label>
          <label>
            Initial prompt
            <input
              value={prompt}
              placeholder="e.g. /verify-content 42"
              onChange={(e) => setPrompt(e.target.value)}
            />
          </label>
          <label>
            Permission mode
            <select value={mode} onChange={(e) => setMode(e.target.value as PermissionMode)}>
              <option value="default">default (ask)</option>
              <option value="acceptEdits">acceptEdits</option>
              <option value="plan">plan</option>
              <option value="dontAsk">dontAsk</option>
            </select>
          </label>
          <button onClick={create} disabled={!cwd}>
            New session
          </button>
          {error && <p className="demo-error">{error}</p>}
        </div>
        <ul className="demo-sessions">
          {sessions.map((session) => (
            <li key={session.id}>
              <button
                data-active={session.id === activeId ? '' : undefined}
                onClick={() => setActiveId(session.id)}
              >
                <span className="demo-session-status" data-status={session.status} />
                {session.cwd.split('/').at(-1)} · {session.status}
              </button>
            </li>
          ))}
        </ul>
      </aside>
      <main className="demo-main">
        {activeId ? (
          <SessionPanel key={activeId} client={client} sessionId={activeId} />
        ) : (
          <div className="demo-empty">Create or select a session</div>
        )}
      </main>
    </div>
  )
}
