import type { IpcMain } from 'electron'
import path from 'path'
import type { IpcContext } from './types'
import { getProjectDir as getProjectPath } from '../../core/project-manager'
import { queryEventById } from '../../core/db/events'
import {
  spawnTerminal, writeTerminal, resizeTerminal, killTerminal, listTerminals
} from '../terminal-manager'
import { isInsideDir } from '../../core/paths'

export function registerTerminalIpc(ipcMain: IpcMain, ctx: IpcContext): void {
  ipcMain.handle('terminal:spawn', (_e, id: string, cols: number, rows: number) => spawnTerminal(id, cols, rows))
  ipcMain.on('terminal:write', (_e, id: string, data: string) => writeTerminal(id, data))
  ipcMain.on('terminal:resize', (_e, id: string, cols: number, rows: number) => resizeTerminal(id, cols, rows))
  ipcMain.on('terminal:kill', (_e, id: string) => killTerminal(id))
  ipcMain.handle('terminal:list', () => listTerminals())

  // Replay a command_end event by slicing its session's .cast file — see
  // api-server /api/terminal/replay for the logic; this IPC surface just
  // forwards to the same function so the UI doesn't need a token round-trip.
  ipcMain.handle('terminal:replay', async (_e, eventId: string) => {
    try {
      const { queryEvents } = await import('../../core/db/events')
      const { readCastSlice } = await import('../../core/cast-slice')
      const target = queryEventById(eventId)
      if (!target) return { ok: false, error: 'event not found' }
      const td = target.data as Record<string, unknown>
      const tid = td.terminalId as string | undefined
      if (target.agentType !== 'shell' || td.subtype !== 'command_end' || td.source !== 'builtin-terminal' || !tid) {
        return { ok: false, error: 'not a builtin-terminal command_end event' }
      }
      const sess = queryEvents({ agentType: 'shell', limit: 5000 })
        .filter((ev) => ev.data?.subtype === 'session_start' && ev.data.terminalId === tid && ev.timestamp <= target.timestamp)[0]
      const castPath = sess?.data?.castPath as string | undefined
      if (!castPath) return { ok: false, error: 'no cast file for this session' }
      const duration = Number(td.duration_sec ?? 0) * 1000
      const startMs = target.timestamp - Math.max(duration, 100)
      const slice = await readCastSlice(castPath, startMs, target.timestamp)
      if (!slice) return { ok: false, error: 'failed to read cast file' }
      return { ok: true, command: td.command, exitCode: td.exit_code, durationSec: td.duration_sec, text: slice.text, bytes: slice.bytes }
    } catch (e) {
      return { ok: false, error: (e as Error).message }
    }
  })

  // Session-level replay: given a session_start or session_end event, walk
  // the ENTIRE .cast file for that terminal. Used when the operator ssh'd
  // into a remote host and needs to see everything that scrolled by after
  // that — command_end alone only exposes the local `ssh` line.
  ipcMain.handle('terminal:replaySession', async (_e, eventId: string) => {
    try {
      const { queryEvents } = await import('../../core/db/events')
      const { readCastSlice } = await import('../../core/cast-slice')
      const target = queryEventById(eventId)
      if (!target) return { ok: false, error: 'event not found' }
      const td = target.data as Record<string, unknown>
      const tid = td.terminalId as string | undefined
      const subtype = td.subtype
      if (target.agentType !== 'shell' || (subtype !== 'session_start' && subtype !== 'session_end') || td.source !== 'builtin-terminal' || !tid) {
        return { ok: false, error: 'not a builtin-terminal session event' }
      }
      // For session_end the castPath is on that event itself; for
      // session_start we look up the matching session_end (or use the
      // session_start's own castPath if set).
      let castPath = td.castPath as string | undefined
      if (!castPath) {
        const other = queryEvents({ agentType: 'shell', limit: 5000 })
          .find((ev) => ev.data?.terminalId === tid && (ev.data?.subtype === 'session_start' || ev.data?.subtype === 'session_end') && ev.data?.castPath)
        castPath = other?.data?.castPath as string | undefined
      }
      if (!castPath) return { ok: false, error: 'no cast file for this session' }
      // Slice from 0 to a far future — readCastSlice bounds against the file
      // itself. text captures the whole session, ANSI-stripped.
      const slice = await readCastSlice(castPath, 0, Number.MAX_SAFE_INTEGER)
      if (!slice) return { ok: false, error: 'failed to read cast file' }
      // events carries the raw asciinema frames ([relSec, 'o', bytes]) so the
      // renderer can drive a proper scrubber/player. text is kept for the
      // fallback pre-tag view and copy-to-clipboard flows.
      return { ok: true, castPath, text: slice.text, bytes: slice.bytes, truncated: slice.truncated, events: slice.events }
    } catch (e) {
      return { ok: false, error: (e as Error).message }
    }
  })

  // Replay by wall-clock timestamp: find the terminal session that was active
  // at the given moment and return its full cast + the relative seek offset.
  // Used by Marker → replay jump (the marker knows WHEN, not WHICH session).
  ipcMain.handle('terminal:replayAtTime', async (_e, atMs: number) => {
    try {
      const { queryEvents } = await import('../../core/db/events')
      const { readCastSlice } = await import('../../core/cast-slice')
      const sessions = queryEvents({ agentType: 'shell', limit: 10000 })
        .filter((ev) => ev.data?.source === 'builtin-terminal' && (ev.data?.subtype === 'session_start' || ev.data?.subtype === 'session_end'))
      // Find the session whose start <= atMs and (end >= atMs or no end yet).
      const starts = sessions
        .filter((ev) => ev.data?.subtype === 'session_start')
        .sort((a, b) => b.timestamp - a.timestamp)
      let castPath: string | undefined
      let castStartMs = 0
      for (const s of starts) {
        if (s.timestamp > atMs) continue
        const tid = s.data?.terminalId as string | undefined
        if (!tid) continue
        const end = sessions.find((ev) => ev.data?.subtype === 'session_end' && ev.data?.terminalId === tid && ev.timestamp >= s.timestamp)
        if (end && end.timestamp < atMs) continue
        castPath = (s.data?.castPath ?? end?.data?.castPath) as string | undefined
        if (castPath) break
      }
      if (!castPath) return { ok: false, error: 'no active session at this time' }
      const slice = await readCastSlice(castPath, 0, Number.MAX_SAFE_INTEGER)
      if (!slice) return { ok: false, error: 'failed to read cast file' }
      const seekMs = Math.max(0, atMs - slice.castStartMs)
      return { ok: true, events: slice.events, truncated: slice.truncated, seekMs }
    } catch (e) {
      return { ok: false, error: (e as Error).message }
    }
  })

  // --- Cast search / index ---
  // Full-text search over terminal recordings (docs/DESIGN-core-and-capture.md
  // §2.4). Separate from events:search because the two answer different
  // questions and have different completeness: an event either exists or does
  // not, whereas a recording may be on disk and not yet indexed. `casts:status`
  // exists so the UI can say which of those it is, rather than returning zero
  // hits and letting the operator conclude the bytes are missing.
  ipcMain.handle('casts:search', async (_e, query: string, limit?: number) => {
    if (!ctx.getActiveProject()) return []
    const { searchCasts } = await import('../../core/cast-index')
    return searchCasts(query, limit)
  })
  ipcMain.handle('casts:status', async () => {
    if (!ctx.getActiveProject()) return { total: 0, indexed: 0, pending: 0 }
    const { castIndexStatus } = await import('../../core/cast-index')
    return castIndexStatus()
  })
  ipcMain.handle('casts:readRange', async (_e, castRel: string, off: number, len: number) => {
    const project = ctx.getActiveProject()
    if (!project) return null
    // castRel comes from a search hit, but the hit came from a DB the renderer
    // can reach — so re-derive the path from the project root and refuse
    // anything that escapes it, the same guard the api-server applies to
    // castPath out of event data.
    const castsDir = path.join(getProjectPath(project), 'casts')
    const full = path.resolve(castsDir, castRel)
    if (!isInsideDir(castsDir, full)) return null
    const { readCastRange } = await import('../../core/cast-slice')
    return readCastRange(full, off, len)
  })
}
