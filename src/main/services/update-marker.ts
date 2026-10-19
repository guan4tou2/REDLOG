import fs from 'node:fs'
import path from 'node:path'

// What the next launch needs to know about an update this one started
// (Spec 061 FR-006, FR-009). Written just before the restart, read once the
// updated build opens the project it was in, then removed. It lives with the
// app's own data, not in a project: an update is something that happens to the
// app, and a project may not even be the one opened next.

export interface UpdateMarker {
  fromVersion: string
  toVersion: string
  at: number
  /** The project that was open when the restart began; null when none was. */
  projectDir: string | null
}

export type UpdateOutcome =
  | { kind: 'completed'; fromVersion: string; toVersion: string; actualVersion: string }
  | { kind: 'not-applied'; fromVersion: string; toVersion: string; actualVersion: string }

const FILE = 'update-pending.json'

export function writeUpdateMarker(dir: string, marker: UpdateMarker): void {
  fs.mkdirSync(dir, { recursive: true })
  // Rename into place so a launch that happens mid-write never reads half a file.
  const tmp = path.join(dir, `${FILE}.tmp`)
  fs.writeFileSync(tmp, JSON.stringify(marker))
  fs.renameSync(tmp, path.join(dir, FILE))
}

export function readUpdateMarker(dir: string): UpdateMarker | null {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(dir, FILE), 'utf8')) as Partial<UpdateMarker>
    if (typeof raw.fromVersion !== 'string' || typeof raw.toVersion !== 'string' || typeof raw.at !== 'number') return null
    return { fromVersion: raw.fromVersion, toVersion: raw.toVersion, at: raw.at, projectDir: typeof raw.projectDir === 'string' ? raw.projectDir : null }
  } catch {
    return null
  }
}

export function clearUpdateMarker(dir: string): void {
  try { fs.rmSync(path.join(dir, FILE), { force: true }) } catch { /* nothing to clear */ }
}

/** Whether the update happened is decided by the version that is running now,
 *  never by the fact that a restart was requested. */
export function judgeUpdateOutcome(marker: UpdateMarker, actualVersion: string): UpdateOutcome {
  const base = { fromVersion: marker.fromVersion, toVersion: marker.toVersion, actualVersion }
  return actualVersion === marker.toVersion ? { kind: 'completed', ...base } : { kind: 'not-applied', ...base }
}
