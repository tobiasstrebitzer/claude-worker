import { ClaudeWorkerClient } from '@claude-worker/client'

/** Single client against the dev proxy (`/v1` → the worker server). */
export const client = new ClaudeWorkerClient({ baseUrl: `${location.origin}/v1` })
