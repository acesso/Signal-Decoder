// Thin reactive wrapper around $decoder-lib/rtty/sessions' pure reducer
// (sessionsReducer/makeSession, shared verbatim with the original Next.js
// app — see vite.config.ts's $decoder-lib alias). Solid has no useReducer
// equivalent either; this holds the reducer's output in a signal and
// re-runs it on dispatch.

import { createSignal } from 'solid-js'
import {
  sessionsReducer,
  makeSession,
  type SessionsState,
  type SessionsAction,
} from '$decoder-lib/rtty/sessions'
import type { RTTYConfig } from '$decoder-lib/rtty/decoder'

export function createSessionsStore(initialConfig: RTTYConfig) {
  const initialSession = makeSession(initialConfig)
  const [state, setState] = createSignal<SessionsState>({
    sessions: [initialSession],
    activeSessionId: initialSession.id,
  })

  function dispatch(action: SessionsAction) {
    setState((prev) => sessionsReducer(prev, action))
  }

  return { state, dispatch, initialSession }
}

export type SessionsStore = ReturnType<typeof createSessionsStore>
