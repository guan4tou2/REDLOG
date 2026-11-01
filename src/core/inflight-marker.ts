import fs from 'fs'
import path from 'path'

// #291: while the proxy addon holds events it has admitted and not delivered,
// it keeps a marker on disk with an upper bound per project — when and how
// many, never content. A stop it is told about records the exact count and
// removes the marker; a kill cannot. What a killed proxy leaves is turned here
// into a capture_gap in the spool, where the drain already knows how to hand
// a record to its own project and to no other.

/** Where the addon writes its markers: next to the spool, under the same home. */
export function inflightMarkerDirectory(home: string): string {
  return path.join(home, '.redlog', 'inflight')
}

/** A live addon rewrites its marker every second. A marker this old whose pid
 *  is alive belongs to a process that reused the pid, not to the proxy. */
const STALE_MS = 10 * 60_000

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

interface MarkerEntry {
  identity?: { engagementId?: unknown; operatorId?: unknown }
  upper_bound?: unknown
  since?: unknown
  last?: unknown
}

/** Turn the marker of every proxy that is gone into one spool record per
 *  project it held events for, then remove the marker. A marker that cannot be
 *  read is set aside as `.bad`, like a spool file. Returns how many markers
 *  were reaped. */
export function reapInflightMarkers(
  directory: string,
  spoolDirectory: string,
  now = Date.now(),
  alive: (pid: number) => boolean = processAlive
): number {
  let names: string[]
  try { names = fs.readdirSync(directory) } catch { return 0 }
  let reaped = 0
  for (const name of names.filter((n) => n.endsWith('.json')).sort()) {
    const file = path.join(directory, name)
    try {
      const marker = JSON.parse(fs.readFileSync(file, 'utf8')) as {
        instance?: unknown; pid?: unknown; heartbeat_at?: unknown; identities?: unknown
      }
      const heartbeat = Number(marker.heartbeat_at)
      if (!Number.isInteger(marker.pid) || !Number.isFinite(heartbeat) || !Array.isArray(marker.identities)) {
        throw new Error('invalid in-flight marker')
      }
      if (alive(marker.pid as number) && now - heartbeat < STALE_MS) continue
      const instance = String(marker.instance ?? name.slice(0, -'.json'.length)).replace(/[^\w-]/g, '')
      ;(marker.identities as MarkerEntry[]).forEach((entry, index) => {
        const engagementId = entry.identity?.engagementId
        const operatorId = entry.identity?.operatorId
        const units = Number(entry.upper_bound)
        if (typeof engagementId !== 'string' || !engagementId || typeof operatorId !== 'string' || !operatorId) return
        if (!Number.isInteger(units) || units <= 0) return
        const since = Number(entry.since)
        const last = Number(entry.last)
        const record = {
          agent_type: 'scanner',
          _identity: { engagementId, operatorId },
          data: {
            subtype: 'capture_gap', source: 'mitmproxy',
            reason: 'delivery-interrupted', capture_delivery: 'unknown',
            // Admitted between these two times. The proxy was last known
            // alive at its heartbeat; the loss happened after that.
            gap_started_at: Number.isFinite(since) ? since : heartbeat,
            gap_ended_at: Math.max(Number.isFinite(last) ? last : heartbeat, heartbeat),
            skipped_units: units,
            reported_at: now,
            description: `The proxy stopped without recording what it still held. The count is an upper bound on what was lost; this record contains no URL, header or body.`
          }
        }
        fs.mkdirSync(spoolDirectory, { recursive: true })
        // Named like the addon's own spool files, so replay orders it by time.
        const target = path.join(spoolDirectory, `${now}000000-inflight-${instance}-${index}.json`)
        fs.writeFileSync(`${target}.tmp`, JSON.stringify(record))
        fs.renameSync(`${target}.tmp`, target)
      })
      fs.unlinkSync(file)
      reaped++
    } catch {
      try { fs.renameSync(file, `${file}.bad`) } catch { /* preserve best effort */ }
    }
  }
  return reaped
}
