// Local artifacts as evidence (#221).
//
// A loot file, a tool report, a pcap an operator saved: the file watcher only
// notices writes under the folders it was told to watch, and it records a
// path, never the bytes. So an operator can add a file explicitly. RedLog
// copies it into the project (`artifacts/`), hashes the copy, and records a
// `file_transfer` / `artifact_added` event carrying the hash, the original
// path, size and mtime. The copy is what the bundle carries; the hash in the
// chained event is what proves it was not changed afterwards.
//
// RedLog never goes looking for files: nothing here scans a directory or
// fetches from a target. Only a path the operator picked is read.
//
// A shell command whose working directory holds the file and which was
// running when the file was last written is listed as a *possible*
// relationship — the same cwd/time overlap the file watcher uses. It is a
// hint for the reviewer, not proof that the command wrote the file.

import fs from 'fs'
import path from 'path'
import { createHash } from 'crypto'
import type { RedLogEvent } from './db/event-types'

export const ARTIFACTS_DIR = 'artifacts'
/** Default ceiling for one added file. A bundle is meant to be sent. */
export const DEFAULT_ARTIFACT_MAX_BYTES = 200 * 1024 * 1024
const RELATED_SLACK_MS = 2_000

export type AddArtifactError =
  | 'not-a-file'
  | 'unreadable'
  | 'too-large'
  | 'no-space'
  | 'copy-failed'

export type AddArtifactResult =
  | {
      ok: true
      /** bundle-relative path, e.g. `artifacts/1a2b3c4d5e6f-report.xml` */
      stored: string
      sha256: string
      bytes: number
      originalPath: string
      mtime: number
      /** the same bytes were already added; nothing new was copied */
      duplicate: boolean
    }
  | { ok: false; error: AddArtifactError; originalPath: string; bytes?: number; detail?: string }

/** What `artifacts:add` answers for each picked file. */
export type ArtifactAddOutcome =
  | (Extract<AddArtifactResult, { ok: true }> & { eventId: string | null; relatedCommands: number })
  | Extract<AddArtifactResult, { ok: false }>
export interface ArtifactAddResponse { canceled: boolean; results: ArtifactAddOutcome[] }

/** Names that survive every filesystem the bundle may land on. */
export function safeArtifactName(name: string): string {
  const cleaned = path.basename(name).replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^\.+/, '')
  return (cleaned || 'file').slice(0, 120)
}

function hashFile(p: string): string {
  const h = createHash('sha256')
  const fd = fs.openSync(p, 'r')
  try {
    const buf = Buffer.allocUnsafe(1024 * 1024)
    let n: number
    while ((n = fs.readSync(fd, buf, 0, buf.length, null)) > 0) h.update(buf.subarray(0, n))
  } finally {
    fs.closeSync(fd)
  }
  return h.digest('hex')
}

/** Copy one operator-picked file into the project and hash it. The hash is
 *  taken from the copy, so what is recorded is what the bundle will carry. */
export function addArtifact(
  projectDir: string,
  sourcePath: string,
  options: { maxBytes?: number } = {}
): AddArtifactResult {
  const originalPath = path.resolve(sourcePath)
  const maxBytes = options.maxBytes ?? DEFAULT_ARTIFACT_MAX_BYTES
  let stat: fs.Stats
  try { stat = fs.statSync(originalPath) } catch (e) {
    return { ok: false, error: 'unreadable', originalPath, detail: (e as Error).message }
  }
  if (!stat.isFile()) return { ok: false, error: 'not-a-file', originalPath }
  if (stat.size > maxBytes) return { ok: false, error: 'too-large', originalPath, bytes: stat.size }

  const dir = path.join(projectDir, ARTIFACTS_DIR)
  const tmp = path.join(dir, `.incoming-${process.pid}-${Date.now()}`)
  try {
    fs.mkdirSync(dir, { recursive: true })
    fs.copyFileSync(originalPath, tmp)
    const sha256 = hashFile(tmp)
    const name = `${sha256.slice(0, 12)}-${safeArtifactName(originalPath)}`
    const dest = path.join(dir, name)
    let duplicate = false
    if (fs.existsSync(dest) && hashFile(dest) === sha256) {
      duplicate = true
      fs.unlinkSync(tmp)
    } else {
      fs.renameSync(tmp, dest)
    }
    return {
      ok: true, stored: `${ARTIFACTS_DIR}/${name}`, sha256, bytes: fs.statSync(dest).size,
      originalPath, mtime: stat.mtimeMs, duplicate
    }
  } catch (e) {
    try { fs.unlinkSync(tmp) } catch { /* never written */ }
    const code = (e as NodeJS.ErrnoException).code
    if (code === 'ENOSPC' || code === 'EDQUOT') return { ok: false, error: 'no-space', originalPath, bytes: stat.size }
    if (code === 'EACCES' || code === 'EPERM' || code === 'ENOENT') {
      return { ok: false, error: 'unreadable', originalPath, detail: (e as Error).message }
    }
    return { ok: false, error: 'copy-failed', originalPath, detail: (e as Error).message }
  }
}

export interface ArtifactRelatedCommand {
  event_id: string
  method: 'cwd-and-time-overlap'
}

function isInside(dir: string, file: string): boolean {
  const rel = path.relative(path.resolve(dir), file)
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel)
}

/** Shell commands that ran in a folder holding the file while it was last
 *  written. Only `command_end` rows carry both the cwd and the duration. */
export function artifactRelatedCommands(
  originalPath: string,
  mtime: number,
  shellEvents: readonly RedLogEvent[]
): ArtifactRelatedCommand[] {
  const file = path.resolve(originalPath)
  const out: ArtifactRelatedCommand[] = []
  for (const e of shellEvents) {
    if (e.agentType !== 'shell' || e.data.subtype !== 'command_end') continue
    const cwd = e.data.cwd
    if (typeof cwd !== 'string' || !cwd.trim() || !isInside(cwd, file)) continue
    const durationSec = typeof e.data.duration_sec === 'number' ? e.data.duration_sec : 0
    const end = e.timestamp
    const start = end - durationSec * 1000
    if (mtime >= start - RELATED_SLACK_MS && mtime <= end + RELATED_SLACK_MS) {
      out.push({ event_id: e.id, method: 'cwd-and-time-overlap' })
    }
  }
  return out
}
