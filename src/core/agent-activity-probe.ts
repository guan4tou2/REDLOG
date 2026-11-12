import fsp from 'node:fs/promises'
import path from 'node:path'
import type { Dirent, Stats } from 'node:fs'

// "An AI tool on this machine is writing sessions, and RedLog is not recording
// them." Answered from directory entries and their modification times, and
// nothing else: this module never opens a file. What a tool's transcripts SAY
// is the operator's conversation, and a source the operator has not turned on
// is one they have not agreed to have read. test/agent-activity-probe.test.ts
// scans this file for any read call.
//
// The walk is asynchronous so it runs on libuv's pool, not on the main thread
// that answers the health snapshot; the snapshot only reads the cached answer.

export interface ProbeFs {
  stat(p: string): Promise<Stats>
  lstat(p: string): Promise<Stats>
  readdir(p: string, opts: { withFileTypes: true }): Promise<Dirent[]>
}

/** How far one walk may go. Every `stat`, `lstat` and `readdir` is one call.
 *  Depth 4 reaches `YYYY/MM/DD/<file>` (Codex) and `<project>/<session>/…`
 *  (Claude Code) below the transcript root. */
export const PROBE_BOUND = { maxDepth: 4, maxCalls: 400, budgetMs: 1_000 }
/** One walk per root per minute at most, however often health is read. */
export const PROBE_RECHECK_MS = 60_000
/** A modification time this far ahead of the clock is not "now": a file
 *  copied with its timestamps, or a clock that moved back, would otherwise
 *  read as fresh until that future moment arrives. */
export const PROBE_FUTURE_TOLERANCE_MS = 60_000

export interface ProbeOptions {
  fs?: ProbeFs
  windowMs: number
  bound?: typeof PROBE_BOUND
  /** Paths not to descend into or count — the open project's directory, in
   *  case it sits under a transcript root. */
  exclude?: string[]
  clock?: () => number
}

const realFs: ProbeFs = {
  stat: (p) => fsp.stat(p),
  lstat: (p) => fsp.lstat(p),
  readdir: (p, o) => fsp.readdir(p, o)
}

/** The modification time of a regular file under `root` that falls in
 *  [now − windowMs, now + tolerance], or null. Stops at the first one: the
 *  question is whether, not which.
 *
 *  Directories are visited newest-first, so the subtree a tool created a file
 *  in most recently is read before older ones. Symbolic links below the root
 *  are never followed. When the bound runs out the answer is null — a missed
 *  notice, never an invented one. */
export async function findRecentActivity(root: string, now: number, opts: ProbeOptions): Promise<number | null> {
  const fs = opts.fs ?? realFs
  const bound = opts.bound ?? PROBE_BOUND
  const clock = opts.clock ?? Date.now
  const excluded = new Set((opts.exclude ?? []).map((p) => path.resolve(p)))
  const started = clock()
  let calls = 0
  const spent = (): boolean => calls >= bound.maxCalls || clock() - started > bound.budgetMs
  const fresh = (m: number): boolean => m >= now - opts.windowMs && m <= now + PROBE_FUTURE_TOLERANCE_MS

  let top: Stats
  try { calls++; top = await fs.stat(root) } catch { return null }
  if (!top.isDirectory()) return null

  const frontier: Array<{ dir: string; mtime: number; depth: number }> = [{ dir: path.resolve(root), mtime: top.mtimeMs, depth: 0 }]
  while (frontier.length > 0 && !spent()) {
    frontier.sort((a, b) => b.mtime - a.mtime)
    const { dir, depth } = frontier.shift()!
    let entries: Dirent[]
    try { calls++; entries = await fs.readdir(dir, { withFileTypes: true }) } catch { continue }
    // Names that sort by date (Codex's) put the newest first.
    entries.sort((a, b) => (a.name < b.name ? 1 : a.name > b.name ? -1 : 0))
    for (const e of entries) {
      if (spent()) break
      if (e.isSymbolicLink()) continue
      const full = path.join(dir, e.name)
      if (excluded.has(full)) continue
      const isDir = e.isDirectory()
      if (!e.isFile() && !(isDir && depth + 1 < bound.maxDepth)) continue
      let st: Stats
      try { calls++; st = await fs.lstat(full) } catch { continue }
      if (st.isSymbolicLink()) continue
      if (st.isFile()) { if (fresh(st.mtimeMs)) return st.mtimeMs; continue }
      if (st.isDirectory() && isDir) frontier.push({ dir: full, mtime: st.mtimeMs, depth: depth + 1 })
    }
  }
  return null
}

export interface ActivityProbe {
  /** The cached answer for `root`, never touching the filesystem itself. A
   *  stale or missing answer starts one walk in the background; its result is
   *  what the next read sees. */
  recentActivity(root: string, now: number, exclude?: string[]): number | null
  /** Resolves when every walk in flight has finished. */
  settle(): Promise<void>
}

/** One cached walk per root, at most one in flight, at most one per
 *  `recheckMs`. `onChange` fires when a finished walk changes the answer. */
export function createActivityProbe(opts: Omit<ProbeOptions, 'exclude'> & { recheckMs?: number; onChange?: () => void }): ActivityProbe {
  const recheckMs = opts.recheckMs ?? PROBE_RECHECK_MS
  const cache = new Map<string, { startedAt: number; doneAt: number | null; at: number | null; pending: Promise<void> | null }>()
  return {
    recentActivity(root, now, exclude = []) {
      const key = [root, ...exclude].join('\0')
      let c = cache.get(key)
      if (!c || (!c.pending && now - c.startedAt >= recheckMs)) {
        const entry = c ?? { startedAt: now, doneAt: null, at: null, pending: null }
        entry.startedAt = now
        entry.pending = findRecentActivity(root, now, { ...opts, exclude })
          .catch(() => null)
          .then((at) => {
            const changed = (at === null) !== (entry.at === null)
            entry.at = at; entry.doneAt = (opts.clock ?? Date.now)(); entry.pending = null
            if (changed) opts.onChange?.()
          })
        cache.set(key, entry)
        c = entry
      }
      // An answer outlives its walk by one window at most, so a probe whose
      // rechecks stopped cannot keep saying "in use".
      return c.at !== null && c.doneAt !== null && now - c.doneAt <= opts.windowMs ? c.at : null
    },
    async settle() {
      await Promise.all([...cache.values()].map((c) => c.pending))
    }
  }
}
