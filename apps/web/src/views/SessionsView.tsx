import { useState } from 'react'
import { useNavigate } from '@tanstack/react-router'
import type { PermissionMode, SdkSessionSummary } from '@claude-worker/protocol'
import {
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectItemText,
  SelectTrigger,
  SelectValue,
  SessionList,
  Spinner,
  Textarea,
  formatRelativeTime,
  toast,
} from '@claude-worker/ui'
import { History, Plus, RefreshCw } from 'lucide-react'
import { client } from '@/lib/client.ts'
import { useSessions } from '@/lib/useSessions.ts'

const CWD_KEY = 'claude-worker.last-cwd'

const PERMISSION_MODES: Array<{ value: PermissionMode; label: string }> = [
  { value: 'default', label: 'default — ask for approval' },
  { value: 'acceptEdits', label: 'acceptEdits — auto-approve file edits' },
  { value: 'plan', label: 'plan — read-only planning' },
  { value: 'auto', label: 'auto — model decides when to ask' },
  { value: 'bypassPermissions', label: 'bypassPermissions — no prompts (danger)' },
]

/** Aliases the CLI resolves to current model ids; free-form ids are accepted too. */
const MODEL_SUGGESTIONS = ['sonnet', 'opus', 'haiku', 'fable']

function CreateSessionCard({ onCreated }: { onCreated: (id: string) => void }) {
  const [cwd, setCwd] = useState(() => localStorage.getItem(CWD_KEY) ?? '')
  const [prompt, setPrompt] = useState('')
  const [mode, setMode] = useState<PermissionMode>('default')
  const [model, setModel] = useState('')
  const [creating, setCreating] = useState(false)

  const [sdkSessions, setSdkSessions] = useState<SdkSessionSummary[] | undefined>()
  const [loadingSdk, setLoadingSdk] = useState(false)

  const create = async (resume?: SdkSessionSummary) => {
    const dir = resume?.cwd ?? cwd.trim()
    if (!dir) {
      toast.error('Working directory is required')
      return
    }
    setCreating(true)
    try {
      localStorage.setItem(CWD_KEY, cwd.trim() || dir)
      const session = await client.createSession({
        cwd: dir,
        prompt: resume ? undefined : prompt.trim() || undefined,
        permissionMode: mode,
        model: model.trim() || undefined,
        resume: resume?.sessionId,
        settingSources: ['user', 'project'],
      })
      onCreated(session.id)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to create session')
    } finally {
      setCreating(false)
    }
  }

  const loadSdkSessions = async () => {
    if (!cwd.trim()) {
      toast.error('Set a working directory first — resumable sessions are listed per project')
      return
    }
    setLoadingSdk(true)
    try {
      setSdkSessions(await client.listSdkSessions({ dir: cwd.trim(), limit: 20 }))
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to list resumable sessions')
    } finally {
      setLoadingSdk(false)
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>New session</CardTitle>
      </CardHeader>
      <CardContent className='flex flex-col gap-3'>
        <label className='flex flex-col gap-1'>
          <span className='text-label font-medium text-fg-3'>Working directory</span>
          <Input
            value={cwd}
            onChange={(e) => setCwd(e.target.value)}
            placeholder='/path/to/project'
            spellCheck={false}
            className='font-mono'
          />
        </label>
        <label className='flex flex-col gap-1'>
          <span className='text-label font-medium text-fg-3'>Initial prompt (optional)</span>
          <Textarea
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            rows={2}
            placeholder='e.g. /verify-content 42, or a task description'
          />
        </label>
        <div className='flex items-end justify-between gap-3'>
          <label className='flex min-w-0 flex-col gap-1'>
            <span className='text-label font-medium text-fg-3'>Permission mode</span>
            <Select
              items={PERMISSION_MODES.map((m) => ({ value: m.value, label: m.label }))}
              value={mode}
              onValueChange={(value) => setMode(value as PermissionMode)}>
              <SelectTrigger className='min-w-64'>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {PERMISSION_MODES.map((m) => (
                  <SelectItem key={m.value} value={m.value}>
                    <SelectItemText>{m.label}</SelectItemText>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </label>
          <label className='flex min-w-0 flex-col gap-1'>
            <span className='text-label font-medium text-fg-3'>Model (optional)</span>
            <Input
              value={model}
              onChange={(e) => setModel(e.target.value)}
              placeholder='default'
              spellCheck={false}
              list='model-suggestions'
              className='min-w-36 font-mono'
            />
            <datalist id='model-suggestions'>
              {MODEL_SUGGESTIONS.map((m) => (
                <option key={m} value={m} />
              ))}
            </datalist>
          </label>
          <Button onClick={() => void create()} disabled={creating}>
            {creating ? <Spinner className='size-3.5 text-current' /> : <Plus className='size-4' />}
            Create
          </Button>
        </div>

        <div className='mt-1 border-t border-border pt-3'>
          <div className='flex items-center justify-between'>
            <span className='text-label font-medium text-fg-3'>Resume a previous session</span>
            <Button variant='ghost' size='xs' onClick={() => void loadSdkSessions()} disabled={loadingSdk}>
              {loadingSdk ? <Spinner className='size-3 text-current' /> : <History className='size-3' />}
              {sdkSessions ? 'Reload' : 'Browse'}
            </Button>
          </div>
          {sdkSessions !== undefined ? (
            sdkSessions.length === 0 ? (
              <div className='py-3 text-center text-body-sm text-fg-4'>
                No stored sessions for this directory.
              </div>
            ) : (
              <ul className='mt-2 flex flex-col gap-1'>
                {sdkSessions.map((s) => (
                  <li
                    key={s.sessionId}
                    className='flex items-center gap-2 rounded-md px-2 py-1.5 hover:bg-surface-hover'>
                    <div className='min-w-0 flex-1'>
                      <div className='truncate text-body-sm text-fg-1'>
                        {s.customTitle ?? s.summary}
                      </div>
                      <div className='flex gap-2 font-mono text-label text-fg-4'>
                        {s.gitBranch ? <span className='truncate'>{s.gitBranch}</span> : null}
                        <span className='shrink-0'>{formatRelativeTime(s.lastModified)}</span>
                      </div>
                    </div>
                    <Button variant='outline' size='xs' onClick={() => void create(s)} disabled={creating}>
                      Resume
                    </Button>
                  </li>
                ))}
              </ul>
            )
          ) : null}
        </div>
      </CardContent>
    </Card>
  )
}

export function SessionsView() {
  const navigate = useNavigate()
  const { sessions, error, refresh } = useSessions()

  const open = (id: string) => void navigate({ to: '/sessions/$sessionId', params: { sessionId: id } })

  return (
    <div className='flex-1 overflow-y-auto'>
      <div className='mx-auto flex w-full max-w-3xl flex-col gap-5 px-6 py-6'>
        <header className='flex items-end justify-between'>
          <div>
            <h1 className='text-display-sm font-semibold tracking-tight text-text'>Sessions</h1>
            <p className='mt-0.5 text-body-sm text-muted-foreground'>
              Live Agent SDK sessions on this worker.
            </p>
          </div>
          <Button variant='ghost' size='icon-sm' aria-label='Refresh' onClick={() => void refresh()}>
            <RefreshCw className='size-4' />
          </Button>
        </header>

        {error ? (
          <div className='rounded-md bg-danger-bg px-3 py-2 text-body-sm text-danger'>
            Can’t reach the worker server: {error}. Start it with <code className='font-mono'>pnpm server</code>.
          </div>
        ) : null}

        <SessionList
          sessions={[...sessions].sort(
            (a, b) => (b.lastActivityAt ?? b.createdAt) - (a.lastActivityAt ?? a.createdAt),
          )}
          onSelect={open}
          onDelete={(id) => {
            void client
              .deleteSession(id)
              .then(() => refresh())
              .catch((e: unknown) => toast.error(e instanceof Error ? e.message : 'Delete failed'))
          }}
          emptyText='No live sessions. Create one below.'
        />

        <CreateSessionCard onCreated={open} />
      </div>
    </div>
  )
}
