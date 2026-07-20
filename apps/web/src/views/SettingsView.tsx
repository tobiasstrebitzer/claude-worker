import { Card, CardContent, CardHeader, CardTitle } from '@claude-worker/ui'
import { ThemeToggle } from '@/components/shell/ThemeToggle.tsx'

export function SettingsView() {
  return (
    <div className='flex-1 overflow-y-auto'>
      <div className='mx-auto flex w-full max-w-3xl flex-col gap-4 px-6 py-6'>
        <header>
          <h1 className='text-display-sm font-semibold tracking-tight text-text'>Settings</h1>
          <p className='mt-0.5 text-body-sm text-muted-foreground'>
            Client-side preferences. Server policy (auth, cwd roots, API-key requirements) is
            configured where the worker runs.
          </p>
        </header>

        <Card>
          <CardHeader>
            <CardTitle>Appearance</CardTitle>
          </CardHeader>
          <CardContent className='flex items-center justify-between'>
            <span className='text-body-sm text-fg-2'>Theme</span>
            <ThemeToggle />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Worker server</CardTitle>
          </CardHeader>
          <CardContent className='flex flex-col gap-1 text-body-sm text-fg-2'>
            <div>
              Endpoint: <code className='font-mono text-code'>{location.origin}/v1</code> (dev
              proxy → <code className='font-mono text-code'>WORKER_URL</code>, default{' '}
              <code className='font-mono text-code'>http://127.0.0.1:8787</code>)
            </div>
            <div className='text-label text-fg-4'>
              Anthropic credentials are resolved by the SDK from the server operator’s
              environment — this app never handles them.
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  )
}
