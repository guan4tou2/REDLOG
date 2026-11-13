// Spec 072 T004 — what every kind-keyed table answers TODAY, so a fold can be
// shown to answer the same (plan D7).
//
// plan.md "表的清點" lists 33 tables; #11 (`TOOL_ACTIONS`, keyed on tool_name)
// and #28 (capture-health probes, Spec 075's) are not kind tables and are not
// here, which leaves the 31 below. Each has one of two shapes, because not
// every table is a function a test can call:
//
//   evaluated — a function (or exported constant) that today's code exports is
//               called on every example row (examples.ts) and its answer stored;
//   extracted — the table is a private constant, an inline condition or a
//               branch inside a component. Nothing can call it, so what is
//               stored is the set of kind words (agent_type and subtype
//               strings) that its source names, read with the TypeScript
//               parser from a named declaration or the innermost statement
//               around an anchor. Weaker than an evaluation — a table that
//               changes meaning without changing a word is not seen — and
//               said so in each golden's `mode`.
//
// The three SQL tables (#18, #19, #30) also store their SQL text, whitespace
// collapsed; golden-sql.test.ts runs it against in-memory SQLite.
//
// Normalised so the files are byte-stable on every OS: example rows carry no
// time or path; `time` of a card is dropped (it formats in the local zone);
// the open-ended pause band's right edge (it reads the clock) is dropped; SQL
// and source text are whitespace-collapsed; paths are repo-relative with `/`.
import fs from 'node:fs'
import path from 'node:path'
import ts from 'typescript'
import { classifyTier } from '../../src/core/db/events'
import { PAUSE_EXEMPT_AGENT_TYPES } from '../../src/core/db/event-write'
import { isExternalEventAllowed } from '../../src/core/external-event-policy'
import { SCOPE_ELIGIBLE, scopeSignalFor } from '../../src/core/alert/scope-signal'
import { activityClassification, activityKey } from '../../src/core/activity-projection'
import { BAND_OF, LANE_LABEL_KEYS, agentTypeLabel, computeBadges, dotShape, ioMark, toLane } from '../../src/renderer/src/lib/timelineDomain'
import { englishTitle, eventTitle } from '../../src/renderer/src/lib/eventTitle'
import { collapseCommandPairs, eventReader, hasContentReader } from '../../src/renderer/src/lib/timelineEvents'
import { isEvidence } from '../../src/renderer/src/lib/housekeeping'
import { mergeKnownTargets } from '../../src/renderer/src/lib/knownLists'
import { buildCard } from '../../src/renderer/src/lib/timelineCard'
import { buildSessionBands } from '../../src/renderer/src/lib/timelineSessionBands'
import { sessionBoundaries } from '../../src/renderer/src/lib/timelineIncremental'
import { captureGapsFold, foldEvents, interruptedFold, partialHttpFlowsFold, pauseWindowsFold, truncatedOutputsFold } from '../../src/core/export-plan'
import { storedArtifactOf } from '../../src/core/export-attachments'
import { commandOutputState, BODY_SOURCE_PREDICATE } from '../../src/core/content-contract'
import { EVIDENCE_SQL, HOUSEKEEPING_SQL } from '../../src/core/db/event-queries'
import { EXAMPLES, type Example } from './examples'
import type { RedLogEvent } from '../../src/core/db/event-types'

export const ROOT = path.join(__dirname, '..', '..')
export const GOLDEN_DIR = path.join(__dirname, 'golden')

// ── extraction ──────────────────────────────────────────────────────────────

export interface Selector {
  file: string
  /** A declaration by name: const, function, method or class. */
  name?: string
  /** The innermost statement that contains the first live line matching this. */
  anchor?: RegExp
  /** The function-like node that contains the first live line matching this. */
  fn?: RegExp
}

const KIND_WORD = /^[a-z][a-z0-9_]*$/
const KIND_SIDE = /agentType|agent_type|subtype|\.type\b|sub\b/

function sourceOf(file: string): ts.SourceFile {
  const text = fs.readFileSync(path.join(ROOT, file), 'utf8')
  return ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, file.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS)
}

function isLive(line: string): boolean {
  const t = line.trim()
  return !(t.startsWith('//') || t.startsWith('*') || t.startsWith('/*'))
}

function findNode(sf: ts.SourceFile, sel: Selector): ts.Node {
  if (sel.name) {
    let found: ts.Node | undefined
    const visit = (n: ts.Node): void => {
      if (found) return
      if ((ts.isVariableDeclaration(n) || ts.isFunctionDeclaration(n) || ts.isMethodDeclaration(n) || ts.isClassDeclaration(n))
        && n.name && ts.isIdentifier(n.name) && n.name.text === sel.name) { found = ts.isVariableDeclaration(n) ? n : n; return }
      ts.forEachChild(n, visit)
    }
    visit(sf)
    if (!found) throw new Error(`${sel.file}: no declaration named ${sel.name}`)
    return found
  }
  const re = sel.fn ?? sel.anchor!
  const lines = sf.text.split(/\r?\n/)
  const at = lines.findIndex((l) => isLive(l) && re.test(l))
  if (at < 0) throw new Error(`${sel.file}: no live line matches ${re}`)
  const lineStart = sf.getPositionOfLineAndCharacter(at, 0)
  const pos = lineStart + (lines[at].search(re) < 0 ? 0 : lines[at].search(re))
  let best: ts.Node | undefined
  const visit = (n: ts.Node): void => {
    if (n.getStart(sf) <= pos && pos < n.getEnd()) {
      const fnLike = ts.isFunctionDeclaration(n) || ts.isFunctionExpression(n) || ts.isArrowFunction(n) || ts.isMethodDeclaration(n)
      if (sel.fn ? fnLike : ts.isStatement(n) || ts.isVariableDeclaration(n)) best = n
      ts.forEachChild(n, visit)
    }
  }
  visit(sf)
  if (!best) throw new Error(`${sel.file}: no enclosing node for ${re}`)
  return best
}

/** The kind words a node names: operands compared with agent_type/subtype, case labels, and string arrays/sets. */
export function kindWords(sel: Selector): string[] {
  const sf = sourceOf(sel.file)
  const node = findNode(sf, sel)
  const out = new Set<string>()
  const add = (s: string): void => { if (KIND_WORD.test(s)) out.add(s) }
  const lit = (e: ts.Node): string | null => (ts.isStringLiteralLike(e) ? e.text : null)
  const visit = (n: ts.Node): void => {
    if (ts.isBinaryExpression(n)) {
      const op = n.operatorToken.kind
      if (op === ts.SyntaxKind.EqualsEqualsEqualsToken || op === ts.SyntaxKind.ExclamationEqualsEqualsToken
        || op === ts.SyntaxKind.EqualsEqualsToken || op === ts.SyntaxKind.ExclamationEqualsToken) {
        const l = lit(n.left), r = lit(n.right)
        if (l && KIND_SIDE.test(n.right.getText(sf))) add(l)
        if (r && KIND_SIDE.test(n.left.getText(sf))) add(r)
      }
    }
    if (ts.isCaseClause(n)) { const l = lit(n.expression); if (l) add(l) }
    // A string array or Set with at least two literals (a mixed one, like
    // `[SCOPE_VIOLATION_SUBTYPE, 'scope_cleared', …]`, contributes its literals).
    if (ts.isArrayLiteralExpression(n) && n.elements.filter((e) => !!lit(e)).length >= 2) {
      for (const e of n.elements) { const l = lit(e); if (l) add(l) }
    }
    if (ts.isPropertyAssignment(n) && n.name && (ts.isIdentifier(n.name) || ts.isStringLiteral(n.name))
      && /^(agentType|agent_type|subtype)$/.test(n.name.text)) {
      const l = lit(n.initializer); if (l) add(l)
    }
    ts.forEachChild(n, visit)
  }
  visit(node)
  // A name that selects a `new Set([...])` or array declaration is covered by the array rule; a Record's keys are not.
  if (ts.isVariableDeclaration(node) && node.initializer && ts.isObjectLiteralExpression(node.initializer)) {
    for (const p of node.initializer.properties) if (ts.isPropertyAssignment(p) && p.name && (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name))) add(p.name.text)
  }
  return [...out].sort()
}

// ── evaluation helpers ──────────────────────────────────────────────────────

const key = (e: Example): string => e.id
const dataOf = (e: Example): Record<string, unknown> => e.row.data
const sub = (e: Example): string | undefined => dataOf(e).subtype as string | undefined
const passthrough = (k: string): string => k
export const collapse = (s: string): string => s.replace(/\s+/g, ' ').trim()

export interface Golden {
  table: string
  n: number
  /** Where the table lives today (plan.md). */
  location: string
  mode: 'evaluated' | 'extracted' | 'evaluated+extracted'
  /** example id -> today's answer. */
  answers?: Record<string, unknown>
  /** label -> kind words the source names. */
  words?: Record<string, string[]>
  /** label -> whitespace-collapsed SQL text. */
  sql?: Record<string, string>
  /** Plain values that are themselves the table. */
  values?: Record<string, unknown>
}

interface TableSpec {
  n: number
  name: string
  location: string
  evaluate?: (e: Example) => unknown
  extract?: Record<string, Selector>
  sql?: Record<string, string>
  values?: () => Record<string, unknown>
}

const stubLabels = { termLabel: (p: string) => `term:${p}`, pausedLabel: 'paused' }
const cardCtx = { t: passthrough, titleOf: () => '', pluginTypes: [] as never[] }

export const TABLES: TableSpec[] = [
  { n: 1, name: 'LOGGED_TIER', location: 'src/core/db/event-write.ts', evaluate: (e) => classifyTier(e.row.agentType, dataOf(e)) },
  { n: 2, name: 'PAUSE_EXEMPT_AGENT_TYPES', location: 'src/core/db/event-write.ts', evaluate: (e) => PAUSE_EXEMPT_AGENT_TYPES.has(e.row.agentType) },
  { n: 3, name: 'delayedCapture', location: 'src/core/ingest.ts', extract: { delayedCapture: { file: 'src/core/ingest.ts', anchor: /const delayedCapture = / } } },
  { n: 4, name: 'ACTIVE_TARGET_FALLBACK_TYPES', location: 'src/core/ingest.ts', extract: { ACTIVE_TARGET_FALLBACK_TYPES: { file: 'src/core/ingest.ts', name: 'ACTIVE_TARGET_FALLBACK_TYPES' } } },
  { n: 5, name: 'EXTERNAL_ALLOWED_AGENT_TYPES', location: 'src/core/external-event-policy.ts', evaluate: (e) => isExternalEventAllowed(e.row.agentType, dataOf(e)),
    extract: { EXTERNAL_ALLOWED_AGENT_TYPES: { file: 'src/core/external-event-policy.ts', name: 'EXTERNAL_ALLOWED_AGENT_TYPES' } } },
  { n: 6, name: 'causes-resolver kind judgements', location: 'src/core/causes-resolver.ts', extract: {
    noteStartEvent: { file: 'src/core/causes-resolver.ts', name: 'noteStartEvent' },
    resolveIncomingCauses: { file: 'src/core/causes-resolver.ts', name: 'resolveIncomingCauses' } } },
  { n: 7, name: 'socket-attribution kinds', location: 'src/core/socket-attribution.ts', extract: { socketCausesFor: { file: 'src/core/socket-attribution.ts', name: 'socketCausesFor' } } },
  { n: 8, name: 'scope-signal kinds', location: 'src/core/alert/scope-signal.ts',
    evaluate: (e) => scopeSignalFor(e.row.agentType, dataOf(e))?.source ?? null,
    values: () => ({ SCOPE_ELIGIBLE: [...SCOPE_ELIGIBLE].map((x) => `${x.agentType}:${x.subtype}`).sort() }) },
  { n: 9, name: 'activity group', location: 'src/core/activity-projection.ts', evaluate: (e) => (JSON.parse(activityKey(e.row)) as unknown[])[1] },
  { n: 10, name: 'activityClassification', location: 'src/core/activity-projection.ts', evaluate: (e) => activityClassification(e.row).action },
  { n: 12, name: 'LANES / BANDS / toLane', location: 'src/renderer/src/lib/timelineDomain.ts', evaluate: (e) => { const lane = toLane(e.row.agentType, sub(e)); return { lane, band: BAND_OF[lane] } } },
  { n: 13, name: 'LANE_LABEL_KEYS / agentTypeLabel', location: 'src/renderer/src/lib/timelineDomain.ts', evaluate: (e) => ({ laneLabel: LANE_LABEL_KEYS[toLane(e.row.agentType, sub(e))], agentTypeLabel: agentTypeLabel(e.row.agentType, passthrough) }) },
  // What a plugin's `eventTypes` can do today: name a built-in lane for its agent_type (event-registry.ts; read by toLane).
  // Asked as: a plugin declares THIS row's agent_type with lane 'loot' — does the lane follow?
  { n: 14, name: 'plugin eventTypes', location: 'src/core/event-registry.ts',
    evaluate: (e) => toLane(e.row.agentType, sub(e), [{ agentType: e.row.agentType, label: 'plugin', lane: 'loot', pluginId: 'probe' }]),
    extract: { toLane: { file: 'src/renderer/src/lib/timelineDomain.ts', name: 'toLane' } } },
  { n: 15, name: 'eventTitle', location: 'src/renderer/src/lib/eventTitle.ts', evaluate: (e) => eventTitle(e.row, englishTitle) },
  { n: 16, name: 'SearchPanel result title', location: 'src/renderer/src/components/SearchPanel.tsx', extract: { eventSummary: { file: 'src/renderer/src/components/SearchPanel.tsx', name: 'eventSummary' } } },
  { n: 17, name: 'reader dispatch', location: 'src/renderer/src/lib/timelineEvents.ts', evaluate: (e) => ({ reader: eventReader(e.row), hasContentReader: hasContentReader(e.row) }),
    extract: { eventReader: { file: 'src/renderer/src/lib/timelineEvents.ts', name: 'eventReader' }, HTTP_SUBTYPES: { file: 'src/renderer/src/lib/timelineEvents.ts', name: 'HTTP_SUBTYPES' },
      inspector: { file: 'src/renderer/src/components/timeline/TimelineEventInspector.tsx', fn: /const kindReader = eventReader\(event\)/ } } },
  { n: 18, name: 'HOUSEKEEPING_SQL', location: 'src/core/db/event-queries.ts', sql: { HOUSEKEEPING_SQL: HOUSEKEEPING_SQL } },
  { n: 19, name: 'EVIDENCE_SQL / isEvidence', location: 'src/core/db/event-queries.ts', evaluate: (e) => isEvidence(e.row), sql: { EVIDENCE_SQL: EVIDENCE_SQL } },
  { n: 20, name: 'computeBadges / ioMark / dotShape', location: 'src/renderer/src/lib/timelineDomain.ts',
    evaluate: (e) => ({ badges: computeBadges(e.row).map((b) => b.key), ioMark: ioMark(e.row), dotShape: dotShape(e.row), commandOutputState: e.kind === 'shell:command_end' ? commandOutputState(dataOf(e)) : null }) },
  { n: 21, name: 'isBoundary', location: 'src/renderer/src/lib/timelineIncremental.ts', evaluate: (e) => sessionBoundaries.build([e.row] as RedLogEvent[]).length === 1,
    extract: { isBoundary: { file: 'src/renderer/src/lib/timelineIncremental.ts', name: 'isBoundary' } } },
  { n: 22, name: 'timelineCard', location: 'src/renderer/src/lib/timelineCard.ts', evaluate: (e) => { const c = buildCard(e.row, cardCtx); return { lane: c.lane, typeTag: c.typeTag, meta: c.meta, detail: c.detail ?? null } },
    extract: { metaOf: { file: 'src/renderer/src/lib/timelineCard.ts', name: 'metaOf' }, detailOf: { file: 'src/renderer/src/lib/timelineCard.ts', name: 'detailOf' }, typeTagOf: { file: 'src/renderer/src/lib/timelineCard.ts', name: 'typeTagOf' } } },
  { n: 23, name: 'Transcript inclusion', location: 'src/renderer/src/components/TranscriptView.tsx', extract: {
    TRANSCRIPT_BUCKETS: { file: 'src/renderer/src/components/TranscriptView.tsx', name: 'TRANSCRIPT_BUCKETS' },
    entries: { file: 'src/renderer/src/components/TranscriptView.tsx', fn: /const sub = String\(d\.subtype \?\? ''\)/ } } },
  { n: 24, name: 'export summary counts', location: 'src/core/export-plan.ts', evaluate: (e) => ({
    truncated: foldEvents(truncatedOutputsFold(), [e.row]), interrupted: foldEvents(interruptedFold(), [e.row]), pauses: foldEvents(pauseWindowsFold(), [e.row]),
    gaps: foldEvents(captureGapsFold(), [e.row]), partialHttp: foldEvents(partialHttpFlowsFold(), [e.row]) }) },
  { n: 25, name: 'export attachments', location: 'src/core/export-attachments.ts', evaluate: (e) => storedArtifactOf(e.row),
    extract: { listExportAttachments: { file: 'src/core/export-attachments.ts', name: 'listExportAttachments' } } },
  { n: 26, name: 'HTTP export companions', location: 'src/core/export-selection.ts', extract: { iterateExportSelection: { file: 'src/core/export-selection.ts', name: 'iterateExportSelection' } } },
  { n: 27, name: 'do-not-export chain', location: 'src/core/db/do-not-export.ts', extract: { getDoNotExportIds: { file: 'src/core/db/do-not-export.ts', name: 'getDoNotExportIds' } } },
  { n: 29, name: 'knownLists housekeeping', location: 'src/renderer/src/lib/knownLists.ts',
    // isHousekeeping is private: ask it through the one function that uses it. A row that comes back is not housekeeping.
    evaluate: (e) => mergeKnownTargets([], [{ ...e.row, targetId: 'probe-target' }]).length === 1,
    extract: { isHousekeeping: { file: 'src/renderer/src/lib/knownLists.ts', name: 'isHousekeeping' }, HOOK_SCRIPTS: { file: 'src/renderer/src/lib/knownLists.ts', name: 'HOOK_SCRIPTS' } } },
  { n: 30, name: 'content kinds (BODY_SOURCE_PREDICATE)', location: 'src/core/content-contract.ts', sql: { BODY_SOURCE_PREDICATE: BODY_SOURCE_PREDICATE } },
  { n: 31, name: 'terminal bands', location: 'src/renderer/src/lib/timelineSessionBands.ts',
    evaluate: (e) => buildSessionBands([e.row], (x) => x, stubLabels, e.row.timestamp + 1).map((b) => ({ kind: b.kind, label: b.label })),
    extract: { buildSessionBands: { file: 'src/renderer/src/lib/timelineSessionBands.ts', name: 'buildSessionBands' } } },
  // Asked as: this command_start, with a command_end of the same command_id and command after it — is the start still drawn?
  { n: 32, name: 'start hidden once paired', location: 'src/renderer/src/components/Timeline.tsx',
    evaluate: (e) => {
      if (e.kind !== 'shell:command_start') return null
      const end = { ...e.row, id: `${e.row.id}-end`, data: { ...e.row.data, subtype: 'command_end', exit_code: 0 } }
      return collapseCommandPairs([e.row, end]).some((r) => r.id === e.row.id)
    },
    extract: { collapseCommandPairs: { file: 'src/renderer/src/lib/timelineEvents.ts', name: 'collapseCommandPairs' } } },
  { n: 33, name: 'scope/config changed sets', location: 'ScopeStatus.tsx, TargetView.tsx, HttpHistoryPanel.tsx, timeline/TimelineDetailBar.tsx', extract: {
    ScopeStatus: { file: 'src/renderer/src/components/ScopeStatus.tsx', name: 'SCOPE_SUBTYPES' },
    TargetView: { file: 'src/renderer/src/components/TargetView.tsx', anchor: /evt\.data\?\.subtype === 'config_changed'/ },
    HttpHistoryPanel: { file: 'src/renderer/src/components/HttpHistoryPanel.tsx', anchor: /event\.data\.subtype === 'config_changed'/ },
    TimelineDetailBar: { file: 'src/renderer/src/components/timeline/TimelineDetailBar.tsx', anchor: /e\.data\?\.subtype === 'config_changed'/ } } }
]

export const TABLE_NUMBERS: readonly number[] = TABLES.map((t) => t.n)

export function goldenFile(t: TableSpec): string {
  return path.join(GOLDEN_DIR, `${String(t.n).padStart(2, '0')}-${t.name.replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '')}.json`)
}

export function computeGolden(t: TableSpec): Golden {
  const g: Golden = { table: t.name, n: t.n, location: t.location, mode: t.evaluate ? (t.extract ? 'evaluated+extracted' : 'evaluated') : 'extracted' }
  if (t.evaluate) {
    g.answers = {}
    for (const e of EXAMPLES) g.answers[key(e)] = t.evaluate(e) ?? null
  }
  if (t.extract) {
    g.words = {}
    for (const [label, sel] of Object.entries(t.extract)) g.words[label] = kindWords(sel)
  }
  if (t.sql) {
    g.sql = {}
    for (const [label, text] of Object.entries(t.sql)) g.sql[label] = collapse(text)
    if (!t.evaluate && !t.extract) g.mode = 'extracted'
  }
  if (t.values) g.values = t.values()
  return g
}

/** JSON with sorted keys at every level, so a regenerated file differs only where an answer does. */
export function stable(value: unknown): string {
  const sort = (v: unknown): unknown => Array.isArray(v) ? v.map(sort)
    : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([k, x]) => [k, sort(x)]))
      : v
  return `${JSON.stringify(sort(value), null, 1)}\n`
}

// ── SQL (in-memory SQLite) ──────────────────────────────────────────────────

export interface SqlDb { exec(sql: string): void; prepare(sql: string): { run(...a: unknown[]): unknown; get(...a: unknown[]): unknown } }

/** 1 when the predicate holds for the example row, 0 when it does not. */
export function sqlAnswers(db: SqlDb, predicate: string, only?: (e: Example) => boolean): Record<string, number> {
  db.exec('CREATE TABLE IF NOT EXISTS ev (agent_type TEXT, subtype TEXT, data TEXT)')
  const out: Record<string, number> = {}
  for (const e of EXAMPLES) {
    if (only && !only(e)) continue
    db.exec('DELETE FROM ev')
    db.prepare('INSERT INTO ev (agent_type, subtype, data) VALUES (?, ?, ?)').run(e.row.agentType, typeof e.row.data.subtype === 'string' ? e.row.data.subtype : null, JSON.stringify(e.row.data))
    const hit = db.prepare(`SELECT COUNT(*) AS c FROM ev WHERE ${predicate}`).get() as { c: number }
    out[e.id] = hit.c
  }
  return out
}
