// Retention sweeps for large per-project artifacts (.cast recordings +
// screenshot .jpg files). Runs once on project open. The DB event row
// stays regardless — only the on-disk file is deleted, and a
// `system.cast_pruned` / `system.screenshot_pruned` audit event is
// appended per deletion so the chain records that raw evidence was
// removed by policy (as opposed to silently disappearing).
//
// v0.6.87 B1 + B2.

import fs from 'fs'
import path from 'path'
import { getProjectDir } from './db/index'
import { insertEvent } from './db/events'
import { eventBus } from './event-bus'
import { noteDbError } from './capture-health'

const DAY_MS = 24 * 60 * 60 * 1000

function sweepDir(
  dir: string,
  keepDays: number,
  matcher: (name: string) => boolean,
  auditSubtype: string,
  opts: { engagementId: string; operatorId: string }
): number {
  if (keepDays <= 0) return 0
  if (!fs.existsSync(dir)) return 0
  const cutoff = Date.now() - keepDays * DAY_MS
  let pruned = 0
  let entries: string[] = []
  try { entries = fs.readdirSync(dir) } catch { return 0 }
  for (const name of entries) {
    if (!matcher(name)) continue
    const full = path.join(dir, name)
    let stat: fs.Stats
    try { stat = fs.statSync(full) } catch { continue }
    if (stat.mtimeMs > cutoff) continue
    try {
      fs.unlinkSync(full)
      pruned++
      try {
        const ev = insertEvent('system', {
          subtype: auditSubtype,
          path: full,
          bytes: stat.size,
          ageDays: Math.round((Date.now() - stat.mtimeMs) / DAY_MS),
          description: `pruned by retention policy (${keepDays}d)`
        }, opts)
        if (ev) eventBus.publish(ev)
      } catch (e) { noteDbError('retention-sweep', e) }
    } catch { /* file gone / permission — skip */ }
  }
  return pruned
}

export function sweepRetention(config: {
  terminal?: { castKeepDays?: number }
  screenshots?: { keepDays?: number }
}, opts: { engagementId: string; operatorId: string }): { cast: number; screenshots: number } {
  if (!opts.operatorId) return { cast: 0, screenshots: 0 }
  let projectDir: string
  try { projectDir = getProjectDir() } catch { return { cast: 0, screenshots: 0 } }
  const castDays = config.terminal?.castKeepDays ?? 0
  const shotDays = config.screenshots?.keepDays ?? 0
  const cast = sweepDir(
    path.join(projectDir, 'casts'),
    castDays,
    (n) => n.endsWith('.cast'),
    'cast_pruned',
    opts
  )
  const screenshots = sweepDir(
    path.join(projectDir, 'screenshots'),
    shotDays,
    (n) => /\.(jpg|jpeg|png)$/i.test(n),
    'screenshot_pruned',
    opts
  )
  return { cast, screenshots }
}
