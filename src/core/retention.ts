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
import { getProjectDir, getDB } from './db/index'
import { insertEvent, queryEvents } from './db/events'
import { eventBus } from './event-bus'
import { noteDbError } from './capture-health'
import { compressBody, resolveExisting, ioDir } from './io-store'
import { planArtifactRotation, type ArtifactBody } from './artifact-gc'
import { isPinned, pinScore, type ScopeVerdict } from './artifact-pin'

// v0.6.89 `_causes`: cast_pruned and screenshot_pruned should reference the
// upstream event so focus chain walks light up the "originally recorded here
// → later pruned by retention" arc. For casts we can look up the session_end
// event whose data.castPath matches the file we're deleting; for screenshots
// the .jpg filename is chosen at capture time, so we look up the screenshot
// event by its data.filename basename.
function lookupCauseEventId(subtype: 'cast_pruned' | 'screenshot_pruned', absPath: string): string | null {
  try {
    const db = getDB()
    const basename = path.basename(absPath)
    if (subtype === 'cast_pruned') {
      const row = db.prepare(`
        SELECT id FROM events
        WHERE agent_type = 'shell'
          AND json_extract(data,'$.subtype') = 'session_end'
          AND json_extract(data,'$.castPath') = ?
        ORDER BY created_at DESC LIMIT 1
      `).get(absPath) as { id: string } | undefined
      return row?.id ?? null
    }
    // screenshot_pruned: the screenshot event stores `filename` (basename only)
    // and `filePath` (absolute). Match on either — some old rows only have one.
    const row = db.prepare(`
      SELECT id FROM events
      WHERE agent_type = 'screenshot'
        AND (json_extract(data,'$.filePath') = ? OR json_extract(data,'$.filename') = ?)
      ORDER BY created_at DESC LIMIT 1
    `).get(absPath, basename) as { id: string } | undefined
    return row?.id ?? null
  } catch { return null }
}

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
    // v0.6.89: resolve the upstream event id BEFORE deletion so the audit
    // event points at the original recording/screenshot row for focus chain.
    const causeId = (auditSubtype === 'cast_pruned' || auditSubtype === 'screenshot_pruned')
      ? lookupCauseEventId(auditSubtype, full)
      : null
    try {
      fs.unlinkSync(full)
      pruned++
      try {
        const ev = insertEvent('system', {
          subtype: auditSubtype,
          path: full,
          bytes: stat.size,
          ageDays: Math.round((Date.now() - stat.mtimeMs) / DAY_MS),
          description: `pruned by retention policy (${keepDays}d)`,
          ...(causeId ? { _causes: [causeId] } : {})
        }, opts)
        if (ev) eventBus.publish(ev)
      } catch (e) { noteDbError('retention-sweep', e) }
    } catch { /* file gone / permission — skip */ }
  }
  return pruned
}

// Strongest scope verdict wins when a deduped body is referenced by events of
// differing scope — in_scope pins hardest, excluded weakest. Mirrors the pin
// tier order so a body cited by any in-scope event is kept longest.
const SCOPE_STRENGTH: Record<ScopeVerdict, number> = { in_scope: 3, unknown: 2, out_of_scope: 1, excluded: 0 }
function strongerScope(a: ScopeVerdict, b: ScopeVerdict): ScopeVerdict {
  return SCOPE_STRENGTH[b] > SCOPE_STRENGTH[a] ? b : a
}

/** io_ref sidecar lifecycle sweep (SPEC-SCOPE-AWARE-LIFECYCLE.md Part C).
 *  Unlike the file-mtime `sweepDir` used for casts/screenshots, io bodies are
 *  content-addressed and deduped, so pruning is a mark-and-sweep GC over
 *  event→sha refs: a body is age-prunable only when its NEWEST referencing event
 *  is past the window, and under size pressure UNPINNED (out-of-scope / unmarked)
 *  bodies are evicted before pinned ones. Warm bodies are compressed first.
 *
 *  `resolveScope` is optional: without it every body's scope is `unknown`, so
 *  pinning still honours marker/loot references and operator pins, but scope
 *  priority is inert until a pure classifier is supplied (Part B feeds it). */
export function sweepIoLifecycle(
  projectDir: string,
  cfg: { keepDays: number; warmDays: number; maxBytes: number },
  opts: { engagementId: string; operatorId: string; resolveScope?: (target: string) => ScopeVerdict }
): { compressed: number; pruned: number } {
  const dir = ioDir(projectDir)
  if (!opts.operatorId || !fs.existsSync(dir)) return { compressed: 0, pruned: 0 }
  // Nothing configured (keep-forever, no warm, no cap) → no work.
  if (cfg.keepDays <= 0 && cfg.warmDays <= 0 && cfg.maxBytes <= 0) return { compressed: 0, pruned: 0 }

  const now = Date.now()
  const events = queryEvents({ limit: 100000 })

  // sha → referencing-event facts (newest use, owning ids, targets).
  const refs = new Map<string, { newestTs: number; ownerIds: Set<string>; targets: Set<string> }>()
  // event ids cited by any marker/loot `_causes` — their referenced io bodies pin.
  const citedIds = new Set<string>()
  for (const e of events) {
    if (e.agentType === 'marker' || e.agentType === 'loot') {
      const causes = (e.data?._causes as unknown[] | undefined)
      if (Array.isArray(causes)) for (const c of causes) if (typeof c === 'string') citedIds.add(c)
    }
    const io = e.data?.io as { request?: { ref?: unknown }; response?: { ref?: unknown } } | undefined
    if (!io) continue
    for (const slot of ['request', 'response'] as const) {
      const ref = io[slot]?.ref
      if (typeof ref !== 'string') continue
      const cur = refs.get(ref) ?? { newestTs: 0, ownerIds: new Set<string>(), targets: new Set<string>() }
      cur.newestTs = Math.max(cur.newestTs, e.timestamp)
      cur.ownerIds.add(e.id)
      const tgt = (e.targetId ?? (e.data?.detectedTarget as string) ?? (e.data?.host as string)) || ''
      if (tgt) cur.targets.add(tgt)
      refs.set(ref, cur)
    }
  }

  // Build the on-disk body list with each body's resolved facts.
  const bodies: ArtifactBody[] = []
  let names: string[] = []
  try { names = fs.readdirSync(dir) } catch { return { compressed: 0, pruned: 0 } }
  for (const name of names) {
    const compressed = name.endsWith('.bin.gz')
    if (!name.endsWith('.bin') && !compressed) continue
    const sha = name.replace(/\.bin(\.gz)?$/, '')
    let size = 0, mtimeMs = now
    try { const st = fs.statSync(path.join(dir, name)); size = st.size; mtimeMs = st.mtimeMs } catch { continue }
    const r = refs.get(sha)
    // Refcount gate: age is the NEWEST referencing event's age; an orphan body
    // (no live reference) falls back to its file age.
    const newest = r?.newestTs ?? mtimeMs
    const ageDays = Math.max(0, (now - newest) / DAY_MS)
    let scope: ScopeVerdict = 'unknown'
    if (opts.resolveScope && r) for (const t of r.targets) scope = strongerScope(scope, opts.resolveScope(t))
    const referencedByMarkerOrLoot = !!r && [...r.ownerIds].some((id) => citedIds.has(id))
    const pin = { scope, referencedByMarkerOrLoot, operatorPinned: false }
    bodies.push({ sha, bytes: size, compressed, ageDays, pruneDays: cfg.keepDays, pinned: isPinned(pin), pinScore: pinScore(pin) })
  }

  const plan = planArtifactRotation(bodies, { warmDays: cfg.warmDays, maxBytes: cfg.maxBytes })

  // Warm first (pure win, no audit event — reversible + verify-transparent).
  let compressed = 0
  for (const sha of plan.toCompress) if (compressBody(projectDir, sha)) compressed++

  // Then prune — each deletion appends a chained system.io_pruned so a missing
  // body reads as pruned-by-policy, never tampered.
  let pruned = 0
  for (const sha of plan.toPrune) {
    const found = resolveExisting(projectDir, sha)
    if (!found) continue
    let size = 0
    try { size = fs.statSync(found.file).size } catch { /* raced */ }
    try {
      fs.unlinkSync(found.file)
      pruned++
      try {
        const ev = insertEvent('system', {
          subtype: 'io_pruned',
          path: found.file,
          bytes: size,
          sha256: sha,
          description: `pruned by io retention (${cfg.keepDays}d / ${cfg.maxBytes || '∞'}B)`
        }, opts)
        if (ev) eventBus.publish(ev)
      } catch (e) { noteDbError('io-lifecycle-sweep', e) }
    } catch { /* file gone / permission — skip */ }
  }
  return { compressed, pruned }
}

export function sweepRetention(config: {
  terminal?: { castKeepDays?: number }
  screenshots?: { keepDays?: number }
  agentTranscripts?: { keepDays?: number }
  io?: { keepDays?: number; warmDays?: number; maxBytes?: number }
}, opts: { engagementId: string; operatorId: string; resolveScope?: (target: string) => ScopeVerdict }): { cast: number; screenshots: number; agentTranscripts: number; io: number; ioCompressed: number } {
  const zero = { cast: 0, screenshots: 0, agentTranscripts: 0, io: 0, ioCompressed: 0 }
  if (!opts.operatorId) return zero
  let projectDir: string
  try { projectDir = getProjectDir() } catch { return zero }
  const castDays = config.terminal?.castKeepDays ?? 0
  const shotDays = config.screenshots?.keepDays ?? 0
  // v0.7.2 F: agent-transcripts sweep.
  // v0.7.4 F2: default changed from 30 to 0 (keep forever unless opted in),
  // matching cast + screenshot conventions. Code-review adversarial pass
  // caught that pruning a sidecar whose Claude Code source .jsonl still
  // exists caused every historical turn to be re-inserted as fresh chained
  // events on next project open — because the tailer used sidecar size as
  // its sole "how far have we processed" marker. That specific corruption
  // path is now closed by the F2 DB-side seed of `redlogIdByUuid` at
  // registerSession (which dedups even if the sidecar was reset), but
  // matching sibling conventions removes the surprise for operators who
  // expected evidence to be kept by default.
  const agentDays = config.agentTranscripts?.keepDays ?? 0
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
  const agentTranscripts = sweepDir(
    path.join(projectDir, 'agent-transcripts'),
    agentDays,
    (n) => n.endsWith('.jsonl'),
    'agent_transcript_pruned',
    opts
  )
  // io_ref sidecar bodies (SPEC-SCOPE-AWARE-LIFECYCLE.md Part C): a full
  // lifecycle GC, not a flat file-mtime sweep — refcount-gated, size-aware,
  // scope-pinned, with a warm (compress) stage before prune. The chain (digests
  // only) is untouched, so a pruned body verifies as *pruned*, not tampered.
  const ioResult = sweepIoLifecycle(
    projectDir,
    { keepDays: config.io?.keepDays ?? 0, warmDays: config.io?.warmDays ?? 0, maxBytes: config.io?.maxBytes ?? 0 },
    opts
  )
  return { cast, screenshots, agentTranscripts, io: ioResult.pruned, ioCompressed: ioResult.compressed }
}
