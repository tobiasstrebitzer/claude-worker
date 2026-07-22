import { useEffect, useState } from 'react'
import type { ProfileInfo } from '@claude-worker/protocol'
import { client } from './client.ts'

// Profiles are server startup config — fetch once per page load and share the
// result across every consumer (forms, the Profiles view).
let cache: ProfileInfo[] | undefined
let inflight: Promise<ProfileInfo[]> | undefined

/** The profiles this server declares (filtered server-side to what the caller may
 * use). [] until loaded, and for servers that declare none. */
export function useProfiles(): ProfileInfo[] {
  const [profiles, setProfiles] = useState<ProfileInfo[]>(cache ?? [])

  useEffect(() => {
    if (cache) return
    inflight ??= client.listProfiles().catch(() => [])
    let alive = true
    void inflight.then((loaded) => {
      cache = loaded
      if (alive) setProfiles(loaded)
    })
    return () => {
      alive = false
    }
  }, [])

  return profiles
}

const CHOICE_KEY = 'claude-worker.last-profile'

/** Profiles plus a persisted selection for the create forms. `profile` is always a
 * declared name (stored choice when still valid, else the first) — '' while none. */
export function useProfileChoice() {
  const profiles = useProfiles()
  const [choice, setChoice] = useState(() => localStorage.getItem(CHOICE_KEY) ?? '')
  const profile = profiles.some((p) => p.name === choice) ? choice : (profiles[0]?.name ?? '')
  const select = (name: string) => {
    setChoice(name)
    localStorage.setItem(CHOICE_KEY, name)
  }
  return { profiles, profile, select }
}
