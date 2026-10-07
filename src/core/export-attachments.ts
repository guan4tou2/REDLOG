// The files an evidence bundle would carry, one row each (#222).
//
// The export preview used to give counts only — N attachments, M unattributed —
// so an operator could not see which cast or screenshot was about to leave,
// or drop the one that held a different client's session. A terminal
// recording spans every command typed in it, across whatever targets the
// operator moved between, and RedLog does not trim it: event filters and scope
// masking do not make a cast scope-clean. So each attachment is listed with
// the targets it is tied to, and the operator can leave any of them out.
//
// The bundle-relative path is the attachment's id. Excluding one is part of
// the export request, so the plan fingerprint covers it and the executed
// bundle matches the approved preview.

import fs from 'fs'
import path from 'path'
import type { RedLogEvent } from './db/event-types'
import { isOutOfScope, type ScopeForSanitize } from './scope-sanitize'
import { BODY_REF_FIELDS } from './http-body-store'

export type ExportAttachmentKind = 'screenshot' | 'cast' | 'httpBody' | 'artifact'

export type ExportAttachmentStatus =
  /** will be copied into the bundle */
  | 'included'
  /** the operator left it out */
  | 'excluded-by-operator'
  /** scope masking drops it (a screenshot of an out-of-scope target) */
  | 'excluded-out-of-scope'
  /** an event refers to it and the file is gone */
  | 'missing'

export type ExportAttachmentAttribution =
  /** tied to exactly one target */
  | 'target'
  /** tied to more than one — a cast that moved between hosts */
  | 'cross-target'
  /** no event ties it to any target */
  | 'unattributed'

export interface ExportAttachment {
  /** bundle-relative path, e.g. `casts/term-1.cast`; also the attachment's id */
  id: string
  kind: ExportAttachmentKind
  bytes: number | null
  targets: string[]
  attribution: ExportAttachmentAttribution
  status: ExportAttachmentStatus
  /** terminal or session the file came from, when an event says so */
  source?: string
}

const ID_RE = /^(screenshots|casts|http-bodies|artifacts)\/[^/\\]+$/

/** Whether `id` names an attachment path a request may exclude. */
export function isAttachmentId(id: unknown): id is string {
  return typeof id === 'string' && ID_RE.test(id) && !id.includes('..')
}

/** The bundle path of the file an operator-added artifact event (#221)
 *  copied into the project, or null for any other event. */
export function storedArtifactOf(event: RedLogEvent): string | null {
  if (event.agentType !== 'file_transfer' || event.data.subtype !== 'artifact_added') return null
  const stored = event.data.stored
  return isAttachmentId(stored) && stored.startsWith('artifacts/') ? stored : null
}

function attribution(targets: Set<string>): ExportAttachmentAttribution {
  return targets.size === 0 ? 'unattributed' : targets.size === 1 ? 'target' : 'cross-target'
}

function sizeOf(p: string): number | null {
  try { const s = fs.statSync(p); return s.isFile() ? s.size : null } catch { return null }
}

/** Every file the bundle would carry for these (already approved) events. */
export function listExportAttachments(
  projectDir: string,
  events: readonly RedLogEvent[],
  options: { scope?: ScopeForSanitize; maskOutOfScope?: boolean; exclude?: ReadonlySet<string> } = {}
): ExportAttachment[] {
  const exclude = options.exclude ?? new Set<string>()
  const out: ExportAttachment[] = []
  const status = (id: string, base: ExportAttachmentStatus): ExportAttachmentStatus =>
    base === 'included' && exclude.has(id) ? 'excluded-by-operator' : base

  // Screenshots: the event that took each one names its target.
  const shotTargets = new Map<string, Set<string>>()
  for (const e of events) {
    if (e.agentType !== 'screenshot' || typeof e.data.filename !== 'string') continue
    const set = shotTargets.get(e.data.filename) ?? new Set<string>()
    if (e.targetId) set.add(e.targetId)
    shotTargets.set(e.data.filename, set)
  }
  const shotsDir = path.join(projectDir, 'screenshots')
  const shotFiles = new Set(fs.existsSync(shotsDir) ? fs.readdirSync(shotsDir) : [])
  for (const name of new Set([...shotFiles, ...shotTargets.keys()])) {
    const id = `screenshots/${name}`
    const targets = shotTargets.get(name) ?? new Set<string>()
    const bytes = sizeOf(path.join(shotsDir, name))
    if (bytes === null && !shotTargets.has(name)) continue
    const outOfScope = options.maskOutOfScope !== false && options.scope && targets.size > 0
      && [...targets].every((t) => isOutOfScope(t, options.scope as ScopeForSanitize))
    out.push({
      id, kind: 'screenshot', bytes, targets: [...targets].sort(), attribution: attribution(targets),
      status: bytes === null ? 'missing' : status(id, outOfScope ? 'excluded-out-of-scope' : 'included')
    })
  }

  // Casts: a command run in the built-in terminal carries `io.ref`, the cast
  // it was recorded into, and its target. A session event may name the cast
  // for its terminal; the terminal's commands then count for it too.
  const castTargets = new Map<string, Set<string>>()
  const castSource = new Map<string, string>()
  const castOfTerminal = new Map<string, string>()
  for (const e of events) {
    const castPath = typeof e.data.castPath === 'string' ? e.data.castPath : null
    const term = typeof e.data.terminalId === 'string' ? e.data.terminalId : null
    if (castPath && term) {
      castOfTerminal.set(term, path.basename(castPath))
      castSource.set(path.basename(castPath), term)
    }
  }
  for (const e of events) {
    const io = e.data.io as { ref?: unknown } | undefined
    const term = typeof e.data.terminalId === 'string' ? e.data.terminalId : null
    const name = typeof io?.ref === 'string' ? path.basename(io.ref) : term ? castOfTerminal.get(term) : undefined
    if (!name) continue
    const set = castTargets.get(name) ?? new Set<string>()
    if (e.targetId) set.add(e.targetId)
    castTargets.set(name, set)
    if (term && !castSource.has(name)) castSource.set(name, term)
  }
  const castsDir = path.join(projectDir, 'casts')
  if (fs.existsSync(castsDir)) {
    for (const name of fs.readdirSync(castsDir)) {
      const bytes = sizeOf(path.join(castsDir, name))
      if (bytes === null) continue
      const id = `casts/${name}`
      const targets = castTargets.get(name) ?? new Set<string>()
      const source = castSource.get(name)
      out.push({
        id, kind: 'cast', bytes, targets: [...targets].sort(), attribution: attribution(targets),
        // Never excluded by scope: RedLog does not trim a recording, so an
        // out-of-scope command inside it stays unless the operator drops it.
        status: status(id, 'included'),
        ...(source ? { source } : {})
      })
    }
  }

  // HTTP bodies stored beside the events that reference them.
  const bodyTargets = new Map<string, Set<string>>()
  for (const e of events) {
    for (const key of BODY_REF_FIELDS) {
      const ref = e.data[key] as { sha256?: unknown } | undefined
      if (!ref || typeof ref.sha256 !== 'string') continue
      const set = bodyTargets.get(ref.sha256) ?? new Set<string>()
      if (e.targetId) set.add(e.targetId)
      bodyTargets.set(ref.sha256, set)
    }
  }
  const bodiesDir = path.join(projectDir, 'http-bodies')
  for (const [hash, targets] of bodyTargets) {
    const id = `http-bodies/${hash}.body`
    const bytes = sizeOf(path.join(bodiesDir, `${hash}.body`))
    out.push({
      id, kind: 'httpBody', bytes, targets: [...targets].sort(), attribution: attribution(targets),
      status: bytes === null ? 'missing' : status(id, 'included')
    })
  }

  // Operator-added artifacts (#221): the event that added each names it and
  // its target; one not tied to an exported event does not travel.
  const artifactTargets = new Map<string, Set<string>>()
  for (const e of events) {
    const stored = storedArtifactOf(e)
    if (!stored) continue
    const set = artifactTargets.get(stored) ?? new Set<string>()
    if (e.targetId) set.add(e.targetId)
    artifactTargets.set(stored, set)
  }
  for (const [id, targets] of artifactTargets) {
    const bytes = sizeOf(path.join(projectDir, id))
    const outOfScope = options.maskOutOfScope !== false && options.scope && targets.size > 0
      && [...targets].every((t) => isOutOfScope(t, options.scope as ScopeForSanitize))
    out.push({
      id, kind: 'artifact', bytes, targets: [...targets].sort(), attribution: attribution(targets),
      status: bytes === null ? 'missing' : status(id, outOfScope ? 'excluded-out-of-scope' : 'included')
    })
  }

  return out.sort((a, b) => a.id.localeCompare(b.id))
}
