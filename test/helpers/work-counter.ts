// Counts the WORK a read does, never how long it takes (Spec 074 T010).
//
// test/export-main-thread-stall.test.ts shows what a wall-clock assertion costs
// on a shared CI runner. Everything here is a count: statements run, rows
// handed back to JS, application-defined SQL function calls, JSON.parse calls,
// lstat and open calls, and "scan-class" statements.
//
// "Scan-class" is a structural fact about a statement, not a measurement: its
// EXPLAIN QUERY PLAN reads a table by SCAN, or by a SEARCH whose only
// constraint is a range (rowid < ?), and the statement does not stop early
// (no LIMIT, or an aggregate that has to see every row first). Such a
// statement costs O(rows in the table) however few rows it returns, which is
// what a COUNT(*) over a rowid range, a GROUP BY and a MATERIALIZED CTE have
// in common and what `rows` cannot show. better-sqlite3 does not expose
// sqlite3_stmt_status, so this is the closest count of "rows scanned" that is
// the same on every machine. It is a heuristic for diffing: the recorded list
// of such statements is printed with a failing assertion.
import Database from 'better-sqlite3'
import fs from 'node:fs'

export interface WorkProfile {
  /** Statements executed (run/get/all/iterate), counted per execution. */
  statements: number
  /** Rows handed back to JavaScript by get/all/iterate. */
  rows: number
  /** Calls into application-defined SQL functions (db.function). */
  udfCalls: number
  jsonParse: number
  lstat: number
  open: number
  /** Executions of scan-class statements, see the header. */
  scans: number
}

const ZERO: WorkProfile = { statements: 0, rows: 0, udfCalls: 0, jsonParse: 0, lstat: 0, open: 0, scans: 0 }

let current: WorkProfile | null = null
let scanned: string[] = []
const planCache = new Map<string, boolean>()
const EXCLUDED_TARGET = /json_each|json_tree|sqlite_|body_|activity_/
const MUST_SEE_EVERY_ROW = /\bGROUP BY\b|\bCOUNT\s*\(|\bOVER\s*\(|\bDISTINCT\b|\bMATERIALIZED\b/i

type Original = {
  prepare: typeof Database.prototype.prepare
  fn: typeof Database.prototype.function
}
let original: Original | null = null
let restoreGlobals: (() => void) | null = null

function isScanClass(db: Database.Database, sql: string, args: unknown[]): boolean {
  const cached = planCache.get(sql)
  if (cached !== undefined) return cached
  let result = false
  try {
    const detail = (original!.prepare.call(db, `EXPLAIN QUERY PLAN ${sql}`).all(...args) as Array<{ detail: string }>).map((r) => r.detail)
    // A CTE or subquery that was already read from a table is a scan of that
    // work again, not of the table: name them and skip them.
    const derived = new Set(detail.flatMap((d) => /^(?:CO-ROUTINE|MATERIALIZE)\s+(\S+)/.exec(d)?.[1] ?? []))
    const reads = detail.filter((d) => {
      if (EXCLUDED_TARGET.test(d)) return false
      const target = /^(?:SCAN|SEARCH)\s+(\S+)/.exec(d)?.[1]
      if (target && (derived.has(target) || target.startsWith('('))) return false
      if (/^SCAN\b/.test(d)) return true
      const constraint = /^SEARCH\b.*\(([^)]*)\)/.exec(d)?.[1]
      return constraint !== undefined && !constraint.includes('=')
    })
    result = reads.length > 0 && (!/\bLIMIT\b/i.test(sql) || MUST_SEE_EVERY_ROW.test(sql))
  } catch {
    result = false
  }
  planCache.set(sql, result)
  return result
}

function instrument(stmt: Database.Statement, db: Database.Database): Database.Statement {
  const sql = stmt.source
  const begin = (args: unknown[]): void => {
    if (!current) return
    current.statements++
    if (isScanClass(db, sql, args)) { current.scans++; if (!scanned.includes(sql)) scanned.push(sql) }
  }
  const all = stmt.all, get = stmt.get, run = stmt.run, iterate = stmt.iterate
  stmt.all = function (this: unknown, ...a: unknown[]) {
    begin(a)
    const r = (all as (...x: unknown[]) => unknown[]).apply(stmt, a)
    if (current) current.rows += r.length
    return r
  } as typeof stmt.all
  stmt.get = function (this: unknown, ...a: unknown[]) {
    begin(a)
    const r = (get as (...x: unknown[]) => unknown).apply(stmt, a)
    if (current && r !== undefined) current.rows++
    return r
  } as typeof stmt.get
  stmt.run = function (this: unknown, ...a: unknown[]) {
    begin(a)
    return (run as (...x: unknown[]) => unknown).apply(stmt, a)
  } as typeof stmt.run
  stmt.iterate = function* (this: unknown, ...a: unknown[]) {
    begin(a)
    for (const row of (iterate as (...x: unknown[]) => Iterable<unknown>).apply(stmt, a)) {
      if (current) current.rows++
      yield row
    }
  } as typeof stmt.iterate
  return stmt
}

/** Idempotent. Call once at the top of a file, before any connection opens:
 *  a SQL function registered earlier is not counted. */
export function installWorkCounter(): void {
  if (original) return
  original = { prepare: Database.prototype.prepare, fn: Database.prototype.function }
  Database.prototype.prepare = function (this: Database.Database, sql: string) {
    return instrument(original!.prepare.call(this, sql), this)
  } as typeof Database.prototype.prepare
  Database.prototype.function = function (this: Database.Database, name: string, ...rest: unknown[]) {
    const impl = rest[rest.length - 1] as (...a: unknown[]) => unknown
    const counted = (...a: unknown[]): unknown => { if (current) current.udfCalls++; return impl(...a) }
    // better-sqlite3 takes a function's arity from its length.
    Object.defineProperty(counted, 'length', { value: impl.length })
    rest[rest.length - 1] = counted
    return (original!.fn as (...x: unknown[]) => unknown).call(this, name, ...rest)
  } as typeof Database.prototype.function
  // Plain wrappers, not vi.spyOn: a spy keeps every call's arguments, and
  // 100k parsed rows would be held in memory for the length of the file.
  const parse = JSON.parse, lstat = fs.lstatSync, open = fs.openSync
  JSON.parse = ((...a: Parameters<typeof JSON.parse>) => { if (current) current.jsonParse++; return parse(...a) }) as typeof JSON.parse
  fs.lstatSync = ((...a: unknown[]) => { if (current) current.lstat++; return (lstat as (...x: unknown[]) => unknown)(...a) }) as typeof fs.lstatSync
  fs.openSync = ((...a: unknown[]) => { if (current) current.open++; return (open as (...x: unknown[]) => unknown)(...a) }) as typeof fs.openSync
  restoreGlobals = () => { JSON.parse = parse; fs.lstatSync = lstat; fs.openSync = open }
}

export function uninstallWorkCounter(): void {
  if (!original) return
  Database.prototype.prepare = original.prepare
  Database.prototype.function = original.fn
  restoreGlobals?.()
  restoreGlobals = null
  original = null
  planCache.clear()
}

/** Runs `read` and returns what it did. The scan-class statements it ran are
 *  returned too, so a failing assertion can name them. Not reentrant. */
export function measureWork<T>(read: () => T): { result: T; work: WorkProfile; scanStatements: string[] } {
  if (!original) throw new Error('installWorkCounter() first')
  const work = { ...ZERO }
  current = work
  scanned = []
  try {
    const result = read()
    return { result, work, scanStatements: scanned }
  } finally {
    current = null
  }
}

export const workTuple = (w: WorkProfile): [number, number, number, number, number, number, number] =>
  [w.statements, w.rows, w.udfCalls, w.jsonParse, w.lstat, w.open, w.scans]
