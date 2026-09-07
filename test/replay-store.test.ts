import { describe, it, expect, beforeEach } from 'vitest'
import { replayStore } from '../src/renderer/src/lib/replayStore'

// The app-level replay store behind the status-bar drawer (§14). The xterm
// playback needs a real DOM and can't run here; this pins the store contract
// the drawer relies on: open replaces the session, each open gets a fresh
// monotonic id (so the drawer remounts a clean terminal), close clears it.
// Subscriber notification is exercised by useReplaySession in the app.

const frames: Array<[number, 'o', string]> = [[0, 'o', 'a'], [1, 'o', 'b']]

describe('replayStore', () => {
  beforeEach(() => replayStore.close())

  it('opens a session and exposes it', () => {
    replayStore.open({ events: frames, truncated: false })
    const s = replayStore.get()
    expect(s?.events).toBe(frames)
    expect(s?.truncated).toBe(false)
  })

  it('stamps a fresh monotonic id on every open (drawer remount key)', () => {
    replayStore.open({ events: frames, truncated: false })
    const first = replayStore.get()!.id!
    replayStore.open({ events: frames, truncated: true })
    const second = replayStore.get()!.id!
    expect(second).toBeGreaterThan(first)
  })

  it('close clears the session', () => {
    replayStore.open({ events: frames, truncated: false })
    replayStore.close()
    expect(replayStore.get()).toBeNull()
  })
})
