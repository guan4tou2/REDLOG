import crypto from 'crypto'
import { insertEvent } from './db/events'
import { eventBus } from './event-bus'
import { noteDbError } from './capture-health'
import { DETECT_AS_LOOT, SECRET_SHAPES, compileShape } from './secret-patterns'

interface LootMatch {
  /** Stable rule identity, the key a rule is switched off by: the built-in's
   *  `type`, or `${pluginId}:${patternName}` for a plugin rule (Spec 032). */
  ruleId: string
  type: string
  value: string
  line: string
  confidence: 'high' | 'medium' | 'low'
  /** v0.9.0: identity of the plugin whose pattern matched. Undefined for
   *  built-in pattern hits. Surfaces on the emitted loot event. */
  pluginId?: string
  /** v0.9.0: name of the specific pattern within the plugin. Defaults to
   *  `${type}#${index}` when the plugin omits the `name` field. */
  patternName?: string
}

// Built-in loot shapes and their order live in `secret-patterns.ts`, beside
// transcript redaction's list. Order is load-bearing: it is the order of the
// chained loot event's `matches`.
const LOOT_PATTERNS: Array<{ type: string; pattern: RegExp; confidence: 'high' | 'medium' | 'low'; group: number; description: string }> =
  DETECT_AS_LOOT.map(({ shape, type, confidence, group }) => ({
    type, pattern: compileShape(shape), confidence, group, description: SECRET_SHAPES[shape].description
  }))

// Plugin-contributed loot patterns (🟢 declarative). Kept separate from the
// built-ins so we can list/replace them without touching the base set.
interface ExternalPattern {
  type: string
  pattern: RegExp
  confidence: 'high' | 'medium' | 'low'
  /** Which part of the match is the value: 0 = whole match, n = capture
   *  group n. Declared by the rule, never inferred (Spec 031). */
  group: number
  pluginId: string
  /** v0.9.0: per-pattern identifier — plugin-supplied `name` or the
   *  default `${type}#${index}` when omitted. */
  patternName: string
  /** v0.9.0: optional human description (not used at match time). */
  description?: string
}
const externalPatterns: ExternalPattern[] = []

/** Register loot patterns from a plugin. Invalid regexes are skipped, not thrown. */
export function registerLootPatterns(
  pluginId: string,
  patterns: Array<{
    type: string
    pattern: string
    confidence?: 'high' | 'medium' | 'low'
    flags?: string
    /** Capture group holding the value; omitted = the whole match. */
    group?: number
    name?: string
    description?: string
  }>
): number {
  let added = 0
  patterns.forEach((p, i) => {
    try {
      const flags = new Set(['g', ...(p.flags ?? '').split('')].filter(Boolean))
      const re = new RegExp(p.pattern, [...flags].join(''))
      const group = p.group ?? 0
      if (!Number.isInteger(group) || group < 0) return
      const patternName = p.name && p.name.trim() ? p.name.trim() : `${p.type}#${i}`
      externalPatterns.push({
        type: p.type,
        pattern: re,
        confidence: p.confidence ?? 'medium',
        group,
        pluginId,
        patternName,
        description: p.description
      })
      added++
    } catch { /* bad regex from plugin — skip */ }
  })
  return added
}

/** Drop all patterns a plugin registered (on disable/reload). */
export function unregisterLootPatterns(pluginId: string): void {
  for (let i = externalPatterns.length - 1; i >= 0; i--) {
    if (externalPatterns[i].pluginId === pluginId) externalPatterns.splice(i, 1)
  }
}

/** v0.9.0: introspect the currently-registered plugin patterns for
 *  Settings ▸ Plugins UI + audit bundle export. Returns a shallow snapshot
 *  — the RegExp is stringified so callers can render + copy the source. */
export function listExternalLootPatterns(): Array<{
  pluginId: string
  patternName: string
  type: string
  pattern: string
  flags: string
  confidence: 'high' | 'medium' | 'low'
  description?: string
}> {
  return externalPatterns.map((p) => ({
    pluginId: p.pluginId,
    patternName: p.patternName,
    type: p.type,
    pattern: p.pattern.source,
    flags: p.pattern.flags,
    confidence: p.confidence,
    description: p.description
  }))
}

/** Every rule the detector runs, built-in first, for the Settings list.
 *  `id` is what `disabledRules` holds. */
export function listLootRules(): Array<{
  id: string
  type: string
  confidence: 'high' | 'medium' | 'low'
  pluginId: string | null
  description?: string
}> {
  return [
    ...LOOT_PATTERNS.map((p) => ({ id: p.type, type: p.type, confidence: p.confidence, pluginId: null, description: p.description })),
    ...externalPatterns.map((p) => ({
      id: pluginRuleId(p.pluginId, p.patternName), type: p.type, confidence: p.confidence, pluginId: p.pluginId, description: p.description
    }))
  ]
}

function pluginRuleId(pluginId: string, patternName: string): string {
  return `${pluginId}:${patternName}`
}

export class LootDetector {
  private engagementId = 'default'
  private operatorId = ''
  private detectedHashes = new Set<string>()
  private disabledRules = new Set<string>()

  configure(opts: { engagementId?: string; operatorId?: string; disabledRules?: readonly string[] }): void {
    if (opts.engagementId && opts.engagementId !== this.engagementId) {
      this.engagementId = opts.engagementId
      this.detectedHashes.clear()
    }
    if (opts.operatorId) this.operatorId = opts.operatorId
    if (opts.disabledRules) this.disabledRules = new Set(opts.disabledRules)
  }

  /** Whether a match is reported as loot. A switched-off rule still matches —
   *  its values are still masked — it is only not recorded (Spec 032). */
  isReported(m: Pick<LootMatch, 'ruleId'>): boolean {
    return !this.disabledRules.has(m.ruleId)
  }

  /** Matches of the rules that are switched on, recorded as loot. */
  scan(text: string, targetId?: string, source?: string, causeEventId?: string): LootMatch[] {
    const matches = this.findMatches(text).filter((m) => this.isReported(m))
    if (matches.length > 0 && this.operatorId) this.emit(matches, { targetId, source, causeEventId })
    return matches
  }

  /**
   * Every match in `text`, including values already recorded as loot. Pure:
   * no dedup, no write. Callers feed the values to redaction, which has to
   * mask a secret every time it appears — the dedup that stops a second loot
   * row must not stop a second mask (Spec 031). `emit()` decides what is new.
   */
  findMatches(text: string): LootMatch[] {
    const matches: LootMatch[] = []
    // Built-in patterns carry no plugin attribution; only external ones do.
    for (const { type, pattern, confidence, group } of LOOT_PATTERNS) {
      for (const { value, index } of execAll(pattern, text, group)) {
        matches.push({ ruleId: type, type, value: value.slice(0, 500), line: extractLine(text, index), confidence })
      }
    }
    for (const { type, pattern, confidence, group, pluginId, patternName } of externalPatterns) {
      for (const { value, index } of execAll(pattern, text, group)) {
        matches.push({
          ruleId: pluginRuleId(pluginId, patternName), type, value: value.slice(0, 500),
          line: extractLine(text, index), confidence, pluginId, patternName
        })
      }
    }
    return matches
  }

  /**
   * Record the matches not yet recorded for this target as one loot event.
   * A value is new per (type, target, full value): the same secret on a second
   * host is a second fact; two secrets sharing a prefix are two values.
   *
   * Returns false when the write did not land — paused, or failed. A failure
   * is reported to capture health, and nothing is marked seen, so the next
   * sighting records it instead of the loot being silently lost.
   */
  emit(matches: LootMatch[], opts: { targetId?: string; source?: string; causeEventId?: string }): boolean {
    if (!this.operatorId) return false
    const fresh: LootMatch[] = []
    const keys: string[] = []
    for (const m of matches) {
      if (!this.isReported(m)) continue
      const key = lootKey(m, opts.targetId)
      if (this.detectedHashes.has(key) || keys.includes(key)) continue
      keys.push(key)
      fresh.push(m)
    }
    if (fresh.length === 0) return true
    try {
      const evt = insertEvent('loot', {
        subtype: 'credential_detected',
        matches: fresh.map((m) => ({
          type: m.type,
          confidence: m.confidence,
          preview: m.line,
          // v0.9.0: pattern provenance for audit-trail attribution.
          // Only stamped for plugin-contributed patterns — built-in
          // matches emit the same shape as before (chain-hash stable).
          ...(m.pluginId ? { plugin_id: m.pluginId, pattern_name: m.patternName } : {})
        })),
        count: fresh.length,
        // Optional provenance the caller can attach: the tool/command/host the
        // text came from. Trimmed + capped so a rogue caller can't bloat it.
        ...(opts.source && opts.source.trim() ? { source: opts.source.trim().slice(0, 200) } : {}),
        // v0.6.89 `_causes` wiring: point at the event whose text produced
        // this loot match. Focus chain mode uses this to walk
        // "shell → loot → screenshot" attack narratives.
        ...(opts.causeEventId ? { _causes: [opts.causeEventId] } : {})
      }, {
        engagementId: this.engagementId,
        operatorId: this.operatorId,
        targetId: opts.targetId
      })
      if (!evt) return false
      for (const k of keys) this.detectedHashes.add(k)
      eventBus.publish(evt)
      return true
    } catch (e) {
      noteDbError('loot', e)
      return false
    }
  }

  /** How many distinct values this detector has already seen, i.e. the size of
   *  its dedup set.
   *
   *  NOT the project's loot count, and the old name — `getLootCount()` — said
   *  it was. The Dashboard bound its "Loot" tile to this: an in-memory Set on a
   *  module-scope instance, never read back from the DB, so the tile showed 0
   *  after every restart while the Loot page listed the real rows, and carried
   *  the previous engagement's number across a project switch. The count that
   *  answers "how much loot does this project have" is `getLootCount()` in
   *  `core/db/event-queries.ts`, which asks the database. */
  dedupeCacheSize(): number {
    return this.detectedHashes.size
  }
}

/** Dedup identity: type, target and a digest of the FULL value. */
function lootKey(m: LootMatch, targetId: string | undefined): string {
  const digest = crypto.createHash('sha256').update(m.value).digest('hex')
  return `${m.type}\0${targetId ?? ''}\0${digest}`
}

/** Every non-empty value `pattern` finds in `text`. A zero-length match
 *  advances by one character instead of re-matching the same position
 *  forever — a declared rule such as `a*` would otherwise hang the caller. */
function execAll(pattern: RegExp, text: string, group: number): Array<{ value: string; index: number }> {
  const re = new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : pattern.flags + 'g')
  const out: Array<{ value: string; index: number }> = []
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null) {
    if (m[0].length === 0) { re.lastIndex++; continue }
    const value = m[group]
    if (value) out.push({ value, index: m.index })
  }
  return out
}

function extractLine(text: string, matchIndex: number): string {
  const lineStart = text.lastIndexOf('\n', matchIndex) + 1
  const lineEnd = text.indexOf('\n', matchIndex)
  return text.slice(lineStart, lineEnd === -1 ? undefined : lineEnd).trim().slice(0, 200)
}
