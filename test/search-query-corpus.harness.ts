// Spec 018 T001-T002 support. The corpus is a golden record of what Search
// selects TODAY, captured before Spec 017's query language exists. Seeding and
// replay live here so the capture and the regression test drive the current
// implementation through exactly the same path — a corpus whose expectations
// were produced by a different code path than the one that checks them proves
// nothing.
import fs from 'fs'
import path from 'path'
import { parseQuery, type ParsedQuery } from '../src/core/query/contract'

/** One seeded row. Array order is insert order, and insert order is rowid
 *  order — the canonical sort's tiebreak — so the captured result ORDER is
 *  reproducible, not just the set. */
export interface CorpusRow {
  tier: 'chained' | 'logged'
  id: string
  ts: number
  agentType: string
  subtype: string | null
  targetId: string
  sessionId: string
  /** `events` only; `events_logged` has no such column. */
  transcriptUuid?: string | null
  data: Record<string, unknown>
}

/** The shared filter as the renderer hands it over: `toEventFilter(sharedFilter)`
 *  plus the scope rules main attaches for `inScopeOnly`. */
export interface CorpusFilter {
  targetId?: string
  agentType?: string
  since?: number
  before?: number
  inScopeOnly?: boolean
  scope?: { targets: string[]; excludeTargets: string[] }
}

export interface CorpusEntry {
  /** Stable handle used in the test name, so a diff names the entry. */
  id: string
  /** COVERAGE bullets from the Spec 018 task this entry is the witness for. */
  covers: string[]
  /** Why this entry is in the corpus, in one line. */
  note: string
  query: string
  filter: CorpusFilter
  limit: number
  /** Event IDs in the order the current implementation returned them. */
  expected: string[]
}

export interface Corpus {
  capturedAt: string
  capturedFrom: string
  dataset: CorpusRow[]
  entries: CorpusEntry[]
}

/** Every COVERAGE bullet the corpus is required to witness. Named here rather
 *  than only in the task text so a future entry deletion fails a test instead
 *  of quietly shrinking what the corpus proves. */
export const REQUIRED_COVERAGE = [
  'single-term',
  'multiple-terms',
  'colon-term',
  'no-match',
  'filter-target',
  'filter-type',
  'filter-time',
  'filter-in-scope',
  'filter-combined',
  'both-tiers',
  'excluded-by-filter',
  'field-event',
  'field-session',
  'field-tool',
  'field-transcript'
] as const

export const CORPUS_PATH = path.join(__dirname, 'search-query-corpus.json')

export function loadCorpus(): Corpus {
  return JSON.parse(fs.readFileSync(CORPUS_PATH, 'utf8')) as Corpus
}

/** Minimal structural type for the better-sqlite3 handle, so this file does
 *  not need the driver's types to compile when the driver is unavailable. */
interface SeedDB {
  prepare(sql: string): { run(...params: unknown[]): unknown }
}

export function seedCorpus(db: SeedDB, dataset: CorpusRow[]): void {
  const chained = db.prepare(`
    INSERT INTO events (id, timestamp, engagement_id, session_id, operator_id,
      agent_type, subtype, hostname, source_ip, target_id, data, created_at,
      hash, prev_hash, signature, transcript_uuid)
    VALUES (?, ?, 'corpus-eng', ?, 'corpus-op', ?, ?, '', '', ?, ?, ?, 'h', 'p', 's', ?)
  `)
  const logged = db.prepare(`
    INSERT INTO events_logged (id, timestamp, engagement_id, session_id, operator_id,
      agent_type, subtype, hostname, source_ip, target_id, data, created_at)
    VALUES (?, ?, 'corpus-eng', ?, 'corpus-op', ?, ?, '', '', ?, ?, ?)
  `)
  for (const row of dataset) {
    const data = JSON.stringify(row.data)
    if (row.tier === 'chained') {
      chained.run(row.id, row.ts, row.sessionId, row.agentType, row.subtype,
        row.targetId, data, row.ts, row.transcriptUuid ?? null)
    } else {
      logged.run(row.id, row.ts, row.sessionId, row.agentType, row.subtype,
        row.targetId, data, row.ts)
    }
  }
}

type ContractPage = (opts: { parsed: ParsedQuery; filter?: CorpusFilter; limit?: number; cursor?: string | null })
  => { items: Array<{ id: string }>; hasMore: boolean; nextCursor: string | null }

/** Replay one entry through the same call SearchPanel makes
 *  (`window.redlog.events.searchPage` -> `searchEventsPage`). */
export function replayEntry(executeEventQuery: ContractPage, entry: CorpusEntry): string[] {
  const outcome = parseQuery(entry.query)
  if (!outcome.ok) return []
  const page = executeEventQuery({ parsed: outcome.parsed, filter: entry.filter, limit: entry.limit })
  return page.items.map((event) => event.id)
}
