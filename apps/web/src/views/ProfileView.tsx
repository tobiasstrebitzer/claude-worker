import { useEffect, useState, type ReactNode } from 'react'
import { Link, useParams } from '@tanstack/react-router'
import type { GetProfileResponse } from '@claude-worker/protocol'
import { Badge, Button, Card, CardContent, CardHeader, CardTitle, Spinner } from '@claude-worker/ui'
import { ArrowLeft, Code } from 'lucide-react'
import { client } from '@/lib/client.ts'
import { openInVsCode } from './ProfilesView.tsx'

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className='flex items-baseline justify-between gap-4 py-1.5'>
      <span className='shrink-0 text-label font-medium text-fg-3'>{label}</span>
      <span className='min-w-0 text-right text-body-sm text-fg-1'>{children}</span>
    </div>
  )
}

function Chips({ items, empty }: { items: string[]; empty: string }) {
  if (items.length === 0) return <span className='text-fg-4'>{empty}</span>
  return (
    <span className='flex flex-wrap justify-end gap-1'>
      {items.map((item) => (
        <Badge key={item} variant='neutral'>
          {item}
        </Badge>
      ))}
    </span>
  )
}

/** View-only detail of one profile: its worker-level defaults plus a curated
 * snapshot of the config directory (settings.json, memory, skills, agents,
 * commands). Nothing here mutates the profile — they're server startup config. */
export function ProfileView() {
  const { profileName } = useParams({ from: '/profiles/$profileName' })
  const [detail, setDetail] = useState<GetProfileResponse | undefined>()
  const [error, setError] = useState<string | undefined>()

  useEffect(() => {
    let alive = true
    client
      .getProfile(profileName)
      .then((d) => {
        if (alive) setDetail(d)
      })
      .catch((e: unknown) => {
        if (alive) setError(e instanceof Error ? e.message : 'Failed to load profile')
      })
    return () => {
      alive = false
    }
  }, [profileName])

  const profile = detail?.profile
  const config = detail?.config

  return (
    <div className='flex-1 overflow-y-auto'>
      <div className='mx-auto flex w-full max-w-3xl flex-col gap-5 px-6 py-6'>
        <header className='flex items-end justify-between gap-3'>
          <div className='min-w-0'>
            <Link
              to='/profiles'
              className='mb-1 inline-flex items-center gap-1 text-label text-fg-3 hover:text-fg-1'>
              <ArrowLeft className='size-3' />
              Profiles
            </Link>
            <h1 className='truncate text-display-sm font-semibold tracking-tight text-text'>
              {profileName}
            </h1>
            {profile?.description ? (
              <p className='mt-0.5 text-body-sm text-muted-foreground'>{profile.description}</p>
            ) : null}
          </div>
          {profile ? (
            <Button variant='outline' size='xs' onClick={() => openInVsCode(profile.configDir)}>
              <Code className='size-3' />
              Open in VSCode
            </Button>
          ) : null}
        </header>

        {error ? (
          <div className='rounded-md bg-danger-bg px-3 py-2 text-body-sm text-danger'>{error}</div>
        ) : null}
        {!detail && !error ? <Spinner className='mx-auto size-5 text-fg-4' /> : null}

        {profile && config ? (
          <>
            <Card>
              <CardHeader>
                <CardTitle>Worker defaults</CardTitle>
              </CardHeader>
              <CardContent className='flex flex-col divide-y divide-border'>
                <Row label='Config directory'>
                  <span className='font-mono text-label'>{profile.configDir}</span>
                </Row>
                <Row label='Default model'>
                  {profile.defaults?.model ?? <span className='text-fg-4'>request / CLI default</span>}
                </Row>
                <Row label='Default permission mode'>
                  {profile.defaults?.permissionMode ?? (
                    <span className='text-fg-4'>request / CLI default</span>
                  )}
                </Row>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>Claude Code configuration</CardTitle>
              </CardHeader>
              <CardContent className='flex flex-col divide-y divide-border'>
                {config.settings ? (
                  <>
                    <Row label='Model (settings.json)'>
                      {config.settings.model ?? <span className='text-fg-4'>not set</span>}
                    </Row>
                    <Row label='Default permission mode'>
                      {config.settings.defaultPermissionMode ?? (
                        <span className='text-fg-4'>not set</span>
                      )}
                    </Row>
                    <Row label='Permission rules'>
                      <span className='font-mono text-label'>
                        {config.settings.permissionRules
                          ? `${config.settings.permissionRules.allow} allow · ${config.settings.permissionRules.ask} ask · ${config.settings.permissionRules.deny} deny`
                          : '—'}
                      </span>
                    </Row>
                    <Row label='Env vars (names only)'>
                      <Chips items={config.settings.envKeys ?? []} empty='none' />
                    </Row>
                    <Row label='Hooks'>
                      <Chips items={config.settings.hooks ?? []} empty='none' />
                    </Row>
                  </>
                ) : (
                  <Row label='settings.json'>
                    <span className='text-fg-4'>not found</span>
                  </Row>
                )}
                <Row label='User memory (CLAUDE.md)'>
                  {config.hasUserMemory ? 'present' : <span className='text-fg-4'>none</span>}
                </Row>
                <Row label='Skills'>
                  <Chips items={config.skills} empty='none' />
                </Row>
                <Row label='Agents'>
                  <Chips items={config.agents} empty='none' />
                </Row>
                <Row label='Commands'>
                  <Chips items={config.commands} empty='none' />
                </Row>
              </CardContent>
            </Card>

            <p className='text-label text-fg-4'>
              View only — profiles and their config directories are managed on the server (edit
              the directory itself, e.g. via VSCode, or the server&apos;s{' '}
              <code className='font-mono'>profiles</code> option).
            </p>
          </>
        ) : null}
      </div>
    </div>
  )
}
