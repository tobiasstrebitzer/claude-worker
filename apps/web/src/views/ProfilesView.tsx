import { useNavigate } from '@tanstack/react-router'
import { Badge, Button } from '@claude-worker/ui'
import { Code, Eye, FolderCog, UserRound } from 'lucide-react'
import { useProfiles } from '@/lib/useProfiles.ts'

/** Opens the profile's config dir in VSCode via the vscode:// URL scheme. */
export function openInVsCode(path: string): void {
  window.location.href = `vscode://file${path}`
}

/** Read-only: profiles are declared in server options at startup (or auto-created
 * from the operator's own ~/.claude); the dashboard lists and picks, never edits. */
export function ProfilesView() {
  const profiles = useProfiles()
  const navigate = useNavigate()

  return (
    <div className='flex-1 overflow-y-auto'>
      <div className='mx-auto flex w-full max-w-3xl flex-col gap-5 px-6 py-6'>
        <header>
          <h1 className='text-display-sm font-semibold tracking-tight text-text'>Profiles</h1>
          <p className='mt-0.5 text-body-sm text-muted-foreground'>
            Named Claude Code config directories sessions run under — each carries its own
            settings, memory, skills, and credentials.
          </p>
        </header>

        {profiles.length === 0 ? (
          <div className='flex flex-col items-center gap-2 rounded-md border border-border bg-surface px-4 py-8 text-center'>
            <FolderCog className='size-6 text-fg-4' />
            <p className='text-body-sm text-fg-2'>The server declares no profiles.</p>
            <p className='text-label text-fg-4'>
              Pass <code className='font-mono'>profiles: [{'{ name, configDir, … }'}]</code> to{' '}
              <code className='font-mono'>createWorkerServer</code> — without the option, a{' '}
              <code className='font-mono'>default</code> profile is auto-created from{' '}
              <code className='font-mono'>~/.claude</code> when it exists.
            </p>
          </div>
        ) : (
          <ul className='divide-y divide-border rounded-md border border-border bg-surface'>
            {profiles.map((p) => (
              <li key={p.name} className='flex items-center gap-3 px-3 py-2.5'>
                <UserRound className='size-4 shrink-0 text-fg-3' />
                <div className='min-w-0 flex-1'>
                  <div className='flex items-center gap-2'>
                    <span className='truncate text-body-sm font-medium text-fg-1'>{p.name}</span>
                    {p.description ? (
                      <span className='truncate text-body-sm text-fg-3'>{p.description}</span>
                    ) : null}
                  </div>
                  <div className='mt-0.5 truncate font-mono text-label text-fg-4'>{p.configDir}</div>
                </div>
                <div className='flex shrink-0 items-center gap-1.5'>
                  {p.defaults?.model ? <Badge variant='neutral'>{p.defaults.model}</Badge> : null}
                  {p.defaults?.permissionMode ? (
                    <Badge variant='neutral'>{p.defaults.permissionMode}</Badge>
                  ) : null}
                  <Button
                    variant='ghost'
                    size='icon-sm'
                    aria-label={`Open ${p.name} in VSCode`}
                    title='Open config dir in VSCode'
                    onClick={() => openInVsCode(p.configDir)}>
                    <Code className='size-4' />
                  </Button>
                  <Button
                    variant='ghost'
                    size='icon-sm'
                    aria-label={`View ${p.name}`}
                    title='View profile'
                    onClick={() =>
                      void navigate({ to: '/profiles/$profileName', params: { profileName: p.name } })
                    }>
                    <Eye className='size-4' />
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        )}

        <p className='text-label text-fg-4'>
          Profiles are declared in server configuration and read-only here. Session and job
          creates run under the selected profile; when the server declares more than one,
          picking a profile is required.
        </p>
      </div>
    </div>
  )
}
