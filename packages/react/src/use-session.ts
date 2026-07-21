import { useEffect, useMemo, useReducer, useRef, useState } from 'react'
import type { ClaudeWorkerClient, SessionHandle } from '@claude-worker/client'
import type { AttachedFrame, PermissionMode, SessionEvent } from '@claude-worker/protocol'
import {
  applyEvent,
  initialTranscriptState,
  seedFromSessionInfo,
  type TranscriptState,
} from './transcript.ts'

/** Session events drive the reducer; the attach snapshot seeds fields (permission
 * mode, model) that a promptless session's event stream doesn't carry yet. */
function reduce(state: TranscriptState, action: SessionEvent | AttachedFrame): TranscriptState {
  return action.type === 'attached'
    ? seedFromSessionInfo(state, action.session)
    : applyEvent(state, action)
}

export type UseClaudeSessionResult = {
  state: TranscriptState
  connected: boolean
  send: (text: string) => void
  approve: (requestId: string, updatedInput?: Record<string, unknown>) => void
  deny: (requestId: string, message?: string) => void
  interrupt: () => void
  setPermissionMode: (mode: PermissionMode) => void
  setModel: (model?: string) => void
  closeSession: () => void
}

/** Attach to a session and maintain live transcript state. Detaches on unmount. */
export function useClaudeSession(
  client: ClaudeWorkerClient,
  sessionId: string | undefined,
): UseClaudeSessionResult {
  const [state, dispatch] = useReducer(reduce, initialTranscriptState)
  const [connected, setConnected] = useState(false)
  const handleRef = useRef<SessionHandle | null>(null)

  useEffect(() => {
    if (!sessionId) return
    const handle = client.attach(sessionId)
    handleRef.current = handle
    const offEvent = handle.on('event', (event: SessionEvent) => dispatch(event))
    const offAttached = handle.on('attached', (frame: AttachedFrame) => dispatch(frame))
    const offConn = handle.on('connectionChange', setConnected)
    return () => {
      offEvent()
      offAttached()
      offConn()
      handle.detach()
      handleRef.current = null
    }
  }, [client, sessionId])

  return useMemo(
    () => ({
      state,
      connected,
      send: (text) => handleRef.current?.send(text),
      approve: (requestId, updatedInput) => handleRef.current?.approve(requestId, updatedInput),
      deny: (requestId, message) => handleRef.current?.deny(requestId, message),
      interrupt: () => handleRef.current?.interrupt(),
      setPermissionMode: (mode) => handleRef.current?.setPermissionMode(mode),
      setModel: (model) => handleRef.current?.setModel(model),
      closeSession: () => handleRef.current?.closeSession(),
    }),
    [state, connected],
  )
}
