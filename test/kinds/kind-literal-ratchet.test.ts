// Spec 072 T005 (plan D3) — two ratchets that only go down, and a third for
// the tables themselves.
//
// The registry exists because the same question — "what is this kind?" — is
// answered by comparing strings in dozens of places. Each comparison is a place
// a new kind has to be remembered. This counts them with the TypeScript parser
// (not a grep: a word in a comment or a template is not a comparison) over
// src/**/*.{ts,tsx}, excluding src/core/kinds/** where the registry will live.
//
//   AGENT   — a comparison of an `agentType` / `agent_type` access with a string
//             literal (===, !==, ==, !=, either side), a `case 'x':` of a
//             `switch` on one, and `agent_type = 'x'` / `!=` / `IN (` inside an
//             SQL string.
//   SUBTYPE — the same for `subtype` (`data.subtype === 'x'`, a `case` of
//             `switch (d.subtype)`, `subtype = 'x'` / `IN (` in SQL).
//
// TABLES — the 31 kind-keyed tables of plan.md 「表的清點」, each recognised by
// the declaration that IS the table, so a rename or a fold is noticed. Folding
// one (Phases 3-6) means deleting its declaration, adding its id to FOLDED, and
// lowering TABLE_BASELINE by one in the same change.
//
// Lowering AGENT_BASELINE / SUBTYPE_BASELINE: delete a comparison (ask the
// registry instead), run this file once with the baseline at 0 to read the new
// total, set it. Raising one needs a reason in the PR. A comparison that is
// right to keep goes in kind-literal-allowlist.json with a reason instead; an
// entry that matches nothing fails.
//
// Blind spots, as in test/mutation-guard.test.ts: a literal held in a variable
// (`const k = 'shell'; agentType === k`), a lookup through an object
// (`LABEL[agentType]`), `.includes(agentType)` on an array, and any comparison
// written in a non-TypeScript file are not seen. The count is of the
// comparisons the parser can name, not of everything that depends on a kind.
import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import ts from 'typescript'
import glob from 'fast-glob'
import { repoRelative } from '../helpers/repo-path'

const ROOT = path.join(__dirname, '..', '..')

// Counted 2026-11-13 on origin/main c27ed558: 276 agent_type comparisons in 68 files, 303 subtype
// comparisons in 68 files. The spec's figure (about 274 in
// 62 files) was counted by a looser pattern on 2026-11-12; this is the parser's.
const AGENT_BASELINE = 276
const SUBTYPE_BASELINE = 303
const TABLE_BASELINE = 31

type Counter = 'agent' | 'subtype'
interface Hit { counter: Counter; file: string; line: number; text: string }

const OPS = new Set([
  ts.SyntaxKind.EqualsEqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsEqualsToken,
  ts.SyntaxKind.EqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsToken
])
const AGENT_SIDE = /(^|\.)(agentType|agent_type)$/
const SUBTYPE_SIDE = /(^|\.)subtype$/
const SQL_AGENT = /\bagent_type\s*(=|!=|<>|IN)\s*(\(|')/gi
const SQL_SUBTYPE = /\bsubtype\s*(=|!=|<>|IN)\s*(\(|')/gi

function sideCounter(text: string): Counter | null {
  const t = text.replace(/\?\./g, '.').replace(/\s+/g, '')
  if (AGENT_SIDE.test(t)) return 'agent'
  if (SUBTYPE_SIDE.test(t)) return 'subtype'
  return null
}

function measure(): Hit[] {
  const hits: Hit[] = []
  const files = glob.sync('src/**/*.{ts,tsx}', { cwd: ROOT, absolute: true, ignore: ['**/*.d.ts', 'src/core/kinds/**'] })
  for (const abs of files.sort()) {
    const file = repoRelative(ROOT, abs)
    const sf = ts.createSourceFile(abs, fs.readFileSync(abs, 'utf8'), ts.ScriptTarget.Latest, true, abs.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS)
    const at = (n: ts.Node): number => sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1
    const add = (counter: Counter, n: ts.Node): void => { hits.push({ counter, file, line: at(n), text: n.getText(sf).split('\n')[0].slice(0, 100) }) }
    const visit = (n: ts.Node): void => {
      if (ts.isBinaryExpression(n) && OPS.has(n.operatorToken.kind)) {
        const lit = (e: ts.Expression): boolean => ts.isStringLiteralLike(e)
        if (lit(n.right)) { const c = sideCounter(n.left.getText(sf)); if (c) add(c, n) }
        else if (lit(n.left)) { const c = sideCounter(n.right.getText(sf)); if (c) add(c, n) }
      }
      if (ts.isSwitchStatement(n)) {
        const c = sideCounter(n.expression.getText(sf))
        if (c) for (const clause of n.caseBlock.clauses) if (ts.isCaseClause(clause) && ts.isStringLiteralLike(clause.expression)) add(c, clause)
      }
      const text = ts.isStringLiteralLike(n) ? n.text : ts.isTemplateExpression(n) ? n.head.text + n.templateSpans.map((s) => s.literal.text).join('') : null
      if (text !== null) {
        for (const _ of text.matchAll(SQL_AGENT)) add('agent', n)
        for (const _ of text.matchAll(SQL_SUBTYPE)) add('subtype', n)
      }
      ts.forEachChild(n, visit)
    }
    visit(sf)
  }
  return hits
}

interface AllowEntry { file: string; counter: Counter; reason: string }
const ALLOW = (JSON.parse(fs.readFileSync(path.join(__dirname, 'kind-literal-allowlist.json'), 'utf8')) as { entries: AllowEntry[] }).entries

function counted(): { agent: Hit[]; subtype: Hit[]; stale: string[] } {
  const all = measure()
  const stale = ALLOW.filter((a) => !all.some((h) => h.file === a.file && h.counter === a.counter)).map((a) => `${a.file} (${a.counter})`)
  const kept = all.filter((h) => !ALLOW.some((a) => a.file === h.file && a.counter === h.counter))
  return { agent: kept.filter((h) => h.counter === 'agent'), subtype: kept.filter((h) => h.counter === 'subtype'), stale }
}

const byFile = (hits: Hit[]): string => {
  const m = new Map<string, number>()
  for (const h of hits) m.set(h.file, (m.get(h.file) ?? 0) + 1)
  return [...m].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).map(([f, n]) => `${String(n).padStart(4)}  ${f}`).join('\n')
}

describe('literal kind comparisons (Spec 072 T005)', () => {
  const c = counted()

  it('agent_type comparisons do not grow past the baseline', () => {
    expect(c.agent.length, `${c.agent.length} agent_type comparisons in ${new Set(c.agent.map((h) => h.file)).size} files (baseline ${AGENT_BASELINE}):\n${byFile(c.agent)}`)
      .toBeLessThanOrEqual(AGENT_BASELINE)
  })

  it('subtype comparisons do not grow past the baseline', () => {
    expect(c.subtype.length, `${c.subtype.length} subtype comparisons in ${new Set(c.subtype.map((h) => h.file)).size} files (baseline ${SUBTYPE_BASELINE}):\n${byFile(c.subtype)}`)
      .toBeLessThanOrEqual(SUBTYPE_BASELINE)
  })

  it('the baselines are not stale: lower them when comparisons are removed', () => {
    expect([c.agent.length, c.subtype.length]).toEqual([AGENT_BASELINE, SUBTYPE_BASELINE])
  })

  it('no allowlist entry outlives the comparison it excuses', () => {
    expect(c.stale).toEqual([])
    for (const a of ALLOW) expect(a.reason.trim().length, `${a.file} needs a reason`).toBeGreaterThan(10)
  })
})

// ── the tables ──────────────────────────────────────────────────────────────

/** The declaration that IS each table. Not a line number: lines moved the day after the plan was written. */
const TABLES: Array<{ id: number; file: string; anchor: RegExp; what: string }> = [
  { id: 1, file: 'src/core/db/event-write.ts', anchor: /const LOGGED_TIER\b/, what: 'LOGGED_TIER' },
  { id: 2, file: 'src/core/db/event-write.ts', anchor: /const PAUSE_EXEMPT_AGENT_TYPES\b/, what: 'PAUSE_EXEMPT_AGENT_TYPES' },
  { id: 3, file: 'src/core/ingest.ts', anchor: /const delayedCapture = /, what: 'delayedCapture' },
  { id: 4, file: 'src/core/ingest.ts', anchor: /const ACTIVE_TARGET_FALLBACK_TYPES\b/, what: 'ACTIVE_TARGET_FALLBACK_TYPES' },
  { id: 5, file: 'src/core/external-event-policy.ts', anchor: /const EXTERNAL_ALLOWED_AGENT_TYPES\b/, what: 'EXTERNAL_ALLOWED_AGENT_TYPES' },
  { id: 6, file: 'src/core/causes-resolver.ts', anchor: /export function resolveIncomingCauses\(/, what: 'start/end kind judgement' },
  { id: 7, file: 'src/core/socket-attribution.ts', anchor: /export function socketCausesFor\(/, what: 'socket-attributed kinds' },
  { id: 8, file: 'src/core/alert/scope-signal.ts', anchor: /export const SCOPE_ELIGIBLE\b/, what: 'scope-signal kinds' },
  { id: 9, file: 'src/core/activity-projection.ts', anchor: /const HTTP = new Set\(/, what: 'Activity group sets' },
  { id: 10, file: 'src/core/activity-projection.ts', anchor: /export function activityClassification\(/, what: 'activityClassification' },
  { id: 12, file: 'src/renderer/src/lib/timelineDomain.ts', anchor: /export const LANES = /, what: 'LANES / BANDS / toLane' },
  { id: 13, file: 'src/renderer/src/lib/timelineDomain.ts', anchor: /export const LANE_LABEL_KEYS\b/, what: 'LANE_LABEL_KEYS / agentTypeLabel' },
  { id: 14, file: 'src/core/event-registry.ts', anchor: /export function registerEventTypes\(/, what: 'plugin eventTypes' },
  { id: 15, file: 'src/renderer/src/lib/eventTitle.ts', anchor: /function rawEventTitle\(/, what: 'eventTitle' },
  { id: 16, file: 'src/renderer/src/components/SearchPanel.tsx', anchor: /function eventSummary\(/, what: 'search result title' },
  { id: 17, file: 'src/renderer/src/lib/timelineEvents.ts', anchor: /export function eventReader\(/, what: 'reader dispatch' },
  { id: 18, file: 'src/core/db/event-queries.ts', anchor: /export const HOUSEKEEPING_SQL\b/, what: 'HOUSEKEEPING_SQL' },
  { id: 19, file: 'src/core/db/event-queries.ts', anchor: /export const EVIDENCE_SQL\b/, what: 'EVIDENCE_SQL / isEvidence' },
  { id: 20, file: 'src/renderer/src/lib/timelineDomain.ts', anchor: /export function ioMark\(/, what: 'computeBadges / ioMark / dotShape' },
  { id: 21, file: 'src/renderer/src/lib/timelineIncremental.ts', anchor: /function isBoundary\(/, what: 'isBoundary' },
  { id: 22, file: 'src/renderer/src/lib/timelineCard.ts', anchor: /function metaOf\(/, what: 'timelineCard' },
  { id: 23, file: 'src/renderer/src/components/TranscriptView.tsx', anchor: /const TRANSCRIPT_BUCKETS\b/, what: 'Transcript inclusion' },
  { id: 24, file: 'src/core/export-plan.ts', anchor: /export function pauseWindowsFold\(/, what: 'export summary counts' },
  { id: 25, file: 'src/core/export-attachments.ts', anchor: /export function storedArtifactOf\(/, what: 'export attachments' },
  { id: 26, file: 'src/core/export-selection.ts', anchor: /\['http_response_chunk', 'ws_message', 'websocket_end'\]\.includes\(/, what: 'HTTP export companions' },
  { id: 27, file: 'src/core/db/do-not-export.ts', anchor: /export function getDoNotExportIds\(/, what: 'do-not-export chain' },
  { id: 29, file: 'src/renderer/src/lib/knownLists.ts', anchor: /function isHousekeeping\(/, what: 'housekeeping, third copy' },
  { id: 30, file: 'src/core/content-contract.ts', anchor: /export const BODY_SOURCE_PREDICATE\b/, what: 'content kinds' },
  { id: 31, file: 'src/renderer/src/lib/timelineSessionBands.ts', anchor: /export function buildSessionBands\(/, what: 'terminal bands' },
  { id: 32, file: 'src/renderer/src/lib/timelineEvents.ts', anchor: /export function collapseCommandPairs\(/, what: 'command_start hidden once paired' },
  { id: 33, file: 'src/renderer/src/components/ScopeStatus.tsx', anchor: /const SCOPE_SUBTYPES = new Set\(/, what: 'scope/config changed sets' }
]

/** Table ids folded into the registry. Add the id here and lower TABLE_BASELINE when a fold lands. */
const FOLDED: number[] = []

describe('kind-keyed tables (Spec 072 T005)', () => {
  const live = TABLES.filter((t) => fs.existsSync(path.join(ROOT, t.file)) && t.anchor.test(fs.readFileSync(path.join(ROOT, t.file), 'utf8')))

  it('names the plan\'s tables, without #11 and #28 which are not kind tables', () => {
    expect(TABLES.map((t) => t.id)).toEqual(Array.from({ length: 33 }, (_, i) => i + 1).filter((n) => n !== 11 && n !== 28))
  })

  it('finds each table that has not been folded', () => {
    const missing = TABLES.filter((t) => !FOLDED.includes(t.id) && !live.includes(t))
    expect(missing.map((t) => `#${t.id} ${t.what}: ${t.file} no longer matches ${t.anchor}`)).toEqual([])
  })

  it('does not find a table that was declared folded', () => {
    expect(live.filter((t) => FOLDED.includes(t.id)).map((t) => `#${t.id} ${t.what}`)).toEqual([])
  })

  it('has as many tables as the baseline says, which only goes down', () => {
    expect(live.length, `${live.length} tables remain:\n${live.map((t) => `#${t.id} ${t.what}`).join('\n')}`).toBe(TABLE_BASELINE - FOLDED.length)
  })
})
