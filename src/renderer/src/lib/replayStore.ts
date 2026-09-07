import { useSyncExternalStore } from 'react'

// A session replay that should play above the status bar, not inside the
// Timeline Inspector — so it survives a view switch (§14: "切畫面不中斷播放").
// A tiny external store instead of prop-drilling through the ~4700-line
// Timeline: the Inspector's replay button opens one, the app-level drawer
// renders it, and nothing between them has to know it exists.
export interface ReplaySession {
  events: Array<[number, 'o', string]>
  truncated: boolean
  /** Short label for the drawer header (e.g. the session's first command). */
  label?: string
  /** Monotonic open id — the drawer keys the player on it so each open is a
   *  fresh terminal, not the previous session's frames left on screen. */
  id?: number
}

let current: ReplaySession | null = null
let seq = 0
const listeners = new Set<() => void>()

export const replayStore = {
  open(session: ReplaySession): void { current = { ...session, id: ++seq }; listeners.forEach((l) => l()) },
  close(): void { if (current) { current = null; listeners.forEach((l) => l()) } },
  get(): ReplaySession | null { return current }
}

export function useReplaySession(): ReplaySession | null {
  return useSyncExternalStore(
    (cb) => { listeners.add(cb); return () => { listeners.delete(cb) } },
    () => current,
    () => current
  )
}
