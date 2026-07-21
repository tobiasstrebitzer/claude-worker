import { useCallback, useEffect, useRef, useState } from 'react'
import type { JobInfo, QueueStats } from '@claude-worker/protocol'
import { client } from './client.ts'

/** Poll the server's job queue. `enabled: false` means the server has no queue configured. */
export function useJobs(intervalMs = 3000) {
  const [jobs, setJobs] = useState<JobInfo[]>([])
  const [stats, setStats] = useState<QueueStats | undefined>()
  const [enabled, setEnabled] = useState(true)
  const [error, setError] = useState<string | undefined>()
  const timer = useRef<ReturnType<typeof setInterval> | undefined>(undefined)

  const refresh = useCallback(async () => {
    try {
      const [jobList, queueStats] = await Promise.all([client.listJobs(), client.queueStats()])
      setJobs(jobList)
      setStats(queueStats)
      setEnabled(true)
      setError(undefined)
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      if (/not configured/i.test(message)) {
        setEnabled(false)
        setError(undefined)
      } else {
        setError(message)
      }
    }
  }, [])

  useEffect(() => {
    void refresh()
    timer.current = setInterval(() => void refresh(), intervalMs)
    return () => clearInterval(timer.current)
  }, [refresh, intervalMs])

  return { jobs, stats, enabled, error, refresh }
}
