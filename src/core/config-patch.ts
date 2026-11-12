// Patch-style config saves.
//
// Settings used to send the whole config on every autosave, so a page that had
// loaded it a minute earlier wrote back every field it had NOT touched as well
// — undoing a target added from the Targets view, the current-target switch,
// or a change another page or the API had made in between. It was mitigated by
// re-reading after outside saves; this removes it. A save is now a list of the
// fields the page changed, each with the value the page last saw there.
//
// Shape: `{ path, value, base }` per field. `path` is the key path as segments
// (an AI source's kind or a session id can contain characters a dotted string
// would have to escape). `base` is what the page's baseline held at that path.
//
// Arrays are values. A patch never indexes into one: it replaces the whole
// array at its path. That is safe because of `base`, not because each array has
// a single editor — `scope.targets` has two (the Scope page and Targets ▸ add
// to scope). If the array on disk is no longer the page's base, the write is a
// conflict and nothing is written, rather than one editor's list silently
// replacing the other's. Arrays with one editor (every other list in the
// config: network lists and VPN adapters on Network, loot rules, file-watcher
// and process lists on Capture sources, browser args, redaction lists, an AI
// source's work paths and excluded sessions on its own row) never meet that.
//
// Conflict rule: a field conflicts when the disk value is neither the page's
// base (someone else changed it since the page loaded) nor the value the page
// is writing (they changed it to the same thing — not a conflict). Fields the
// page did not send are never written. Per-field bases, not a whole-file etag:
// an etag would refuse every save after ANY other write, which is the
// false-positive half of the problem this replaces. The file's revision is
// still returned, so a caller can tell whether its baseline is current.
//
// Pure, no Node imports: the renderer computes patches with the same code.

export type ConfigPath = readonly string[]

export interface ConfigPatchOp {
  path: ConfigPath
  /** The new value. Absent with `unset`. */
  value?: unknown
  /** Remove the key (an optional field going back to its default). */
  unset?: true
  /** What the writer's baseline held here. Omitted = no conflict check (a
   *  writer that has just read the file, such as main itself). */
  base?: unknown
  /** True when `base` was `undefined` in the baseline. IPC drops an
   *  `undefined` property, so "was absent" needs saying. */
  baseAbsent?: true
}

export interface ConfigPatch {
  ops: ConfigPatchOp[]
  /** The project the page's config was loaded from. */
  expectProjectId?: string
}

export interface ConfigConflict { path: string[]; current: unknown }

export type ConfigSaveResult =
  | { ok: true; config: unknown; revision: string }
  | { ok: false; reason: 'conflict'; conflicts: ConfigConflict[]; config: unknown; revision: string }
  | { ok: false; reason: 'invalid'; error: string }
  | { ok: false; reason: 'wrong-project' | 'no-project' }

export const CONFIG_PATCH_LIMITS = { maxOps: 200, maxBytes: 1024 * 1024, maxDepth: 6, maxString: 4096, maxArray: 20_000 } as const

// ─── Schema ──────────────────────────────────────────────────────────────────
//
// What a patch may write, and what it may write there. Mirrors RedLogConfig.
// `fixed` paths have their own writer (engagement id is immutable; the current
// target has the audited targetContext:set).

type Node =
  | { t: 'string' }
  | { t: 'number' }
  | { t: 'boolean' }
  | { t: 'enum'; of: readonly string[] }
  | { t: 'nullable'; of: Node }
  | { t: 'array'; of: Node }
  | { t: 'object'; fields: Readonly<Record<string, Node>> }
  | { t: 'record'; of: Node }
  | { t: 'fixed'; why: string }

const str: Node = { t: 'string' }
const num: Node = { t: 'number' }
const bool: Node = { t: 'boolean' }
const strs: Node = { t: 'array', of: str }
const obj = (fields: Record<string, Node>): Node => ({ t: 'object', fields })
const keep = (keepDays = true, maxBytes = true): Node => obj({ ...(keepDays ? { keepDays: num } : {}), ...(maxBytes ? { maxBytes: num } : {}) })

export const CONFIG_SCHEMA: Node = obj({
  engagement: obj({
    id: { t: 'fixed', why: 'the project id cannot change' },
    activeTarget: { t: 'fixed', why: 'the current target is set through targetContext:set' }
  }),
  operator: obj({ id: str, name: str }),
  network: obj({
    whitelist: strs, blacklist: strs, checkInterval: num, providers: strs, confirmations: num,
    ipMode: { t: 'enum', of: ['dns', 'http', 'auto'] }, offline: bool, showWifiName: bool,
    vpnAdapters: { t: 'array', of: obj({ name: str, pattern: str, enabled: bool }) }
  }),
  scope: obj({ warnOnViolation: bool, targets: strs, excludeTargets: strs, personalDomains: strs, scopeFile: { t: 'nullable', of: str } }),
  screenshot: obj({ quality: num, intervalSec: num, diffThreshold: num, captureOnCommand: bool }),
  terminal: obj({ maxCastBytes: num }),
  browser: obj({ binary: str, proxy: str, cdpPort: num, isolateProfile: bool, ignoreCertErrors: bool, startUrl: str, extraArgs: strs }),
  httpCapture: obj({ port: num, listenHost: str, routeTerminals: bool }),
  redaction: obj({ allowlist: strs, denylist: strs, entropyThreshold: num, minLength: num }),
  fileWatcher: obj({ watchPaths: strs, ignorePatterns: strs }),
  processMonitor: obj({ pollMs: num, ignoreCommands: strs }),
  connectionMonitor: obj({ pollMs: num }),
  packs: obj({ hostMonitors: bool, windowsOutput: bool }),
  packMembers: obj({ processMonitor: bool, connectionMonitor: bool, fileWatcher: bool, powershellTranscript: bool }),
  agentTailer: obj({
    sources: {
      t: 'record',
      of: obj({
        sourceRoot: str, excludedSessions: strs, sessionStarts: { t: 'record', of: num }, enabled: bool,
        installationId: str, workPaths: strs, startedAt: num, scopeChangedAt: num
      })
    },
    emitThinking: bool
  }),
  loot: obj({ disabledRules: strs }),
  retention: obj({
    casts: keep(), screenshots: keep(), httpBodies: keep(), agentTranscripts: keep(true, false),
    loggedTier: obj({ keepDays: num, sweepIntervalHours: num }), bookmarks: keep(true, false)
  })
})

const HOSTILE = new Set(['__proto__', 'constructor', 'prototype'])
const RECORD_KEY = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,299}$/

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v) && (Object.getPrototypeOf(v) === Object.prototype || Object.getPrototypeOf(v) === null)

function checkValue(node: Node, v: unknown, where: string, depth: number): string | null {
  if (depth > CONFIG_PATCH_LIMITS.maxDepth + 4) return `${where}: too deep`
  switch (node.t) {
    case 'fixed': return `${where}: ${node.why}`
    case 'string': return typeof v === 'string' && v.length <= CONFIG_PATCH_LIMITS.maxString ? null : `${where}: expected a string`
    case 'number': return typeof v === 'number' && Number.isFinite(v) ? null : `${where}: expected a number`
    case 'boolean': return typeof v === 'boolean' ? null : `${where}: expected true or false`
    case 'enum': return typeof v === 'string' && node.of.includes(v) ? null : `${where}: expected one of ${node.of.join(', ')}`
    case 'nullable': return v === null ? null : checkValue(node.of, v, where, depth)
    case 'array': {
      if (!Array.isArray(v) || v.length > CONFIG_PATCH_LIMITS.maxArray) return `${where}: expected a list`
      for (let i = 0; i < v.length; i++) { const e = checkValue(node.of, v[i], `${where}[${i}]`, depth + 1); if (e) return e }
      return null
    }
    case 'object':
    case 'record': {
      if (!isPlainObject(v)) return `${where}: expected an object`
      for (const [k, child] of Object.entries(v)) {
        if (HOSTILE.has(k)) return `${where}: key ${k} is not allowed`
        if (child === undefined) continue
        const sub = node.t === 'object' ? node.fields[k] : (RECORD_KEY.test(k) ? node.of : undefined)
        if (!sub) return `${where}.${k}: not a config field`
        const e = checkValue(sub, child, `${where}.${k}`, depth + 1)
        if (e) return e
      }
      return null
    }
  }
}

function nodeAt(path: ConfigPath): { node: Node } | { error: string } {
  let node: Node = CONFIG_SCHEMA
  for (const seg of path) {
    if (typeof seg !== 'string' || seg === '' || HOSTILE.has(seg)) return { error: `path segment ${JSON.stringify(seg)} is not allowed` }
    if (node.t === 'object') {
      if (!Object.prototype.hasOwnProperty.call(node.fields, seg)) return { error: `${path.join('.')}: not a config field` }
      node = node.fields[seg]
    } else if (node.t === 'record') {
      if (!RECORD_KEY.test(seg)) return { error: `${path.join('.')}: not a valid key` }
      node = node.of
    } else if (node.t === 'fixed') {
      return { error: `${path.join('.')}: ${node.why}` }
    } else {
      return { error: `${path.join('.')}: cannot write inside a ${node.t}` }
    }
  }
  return { node }
}

/** Is this a well-formed, bounded patch whose every path is a config field and
 *  every value has that field's type? The renderer is not trusted to send one. */
export function validateConfigPatch(raw: unknown): { ok: true; patch: ConfigPatch } | { ok: false; error: string } {
  if (!isPlainObject(raw)) return { ok: false, error: 'patch must be an object' }
  let size: number
  try { size = JSON.stringify(raw).length } catch { return { ok: false, error: 'patch is not plain data' } }
  if (size > CONFIG_PATCH_LIMITS.maxBytes) return { ok: false, error: 'patch is too large' }
  const { ops, expectProjectId } = raw as { ops?: unknown; expectProjectId?: unknown }
  if (expectProjectId !== undefined && typeof expectProjectId !== 'string') return { ok: false, error: 'expectProjectId must be a string' }
  if (!Array.isArray(ops)) return { ok: false, error: 'ops must be a list' }
  if (ops.length > CONFIG_PATCH_LIMITS.maxOps) return { ok: false, error: 'too many fields in one save' }
  const out: ConfigPatchOp[] = []
  for (const op of ops) {
    if (!isPlainObject(op)) return { ok: false, error: 'each op must be an object' }
    const { path, value, unset, base, baseAbsent } = op as Record<string, unknown>
    if (!Array.isArray(path) || path.length === 0 || path.length > CONFIG_PATCH_LIMITS.maxDepth) return { ok: false, error: 'op path must be 1–6 segments' }
    const found = nodeAt(path as string[])
    if ('error' in found) return { ok: false, error: found.error }
    if (unset !== undefined && unset !== true) return { ok: false, error: 'unset must be true' }
    if (baseAbsent !== undefined && baseAbsent !== true) return { ok: false, error: 'baseAbsent must be true' }
    if (unset !== true) {
      const err = checkValue(found.node, value, (path as string[]).join('.'), path.length)
      if (err) return { ok: false, error: err }
    }
    out.push({
      path: [...(path as string[])],
      ...(unset === true ? { unset: true as const } : { value }),
      ...(baseAbsent === true ? { baseAbsent: true as const } : 'base' in op ? { base } : {})
    })
  }
  return { ok: true, patch: { ops: out, ...(expectProjectId !== undefined ? { expectProjectId } : {}) } }
}

// ─── Applying ────────────────────────────────────────────────────────────────

/** Deep equality for config values (plain data; key order does not matter). */
export function sameConfigValue(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((x, i) => sameConfigValue(x, b[i]))
  if (isPlainObject(a) && isPlainObject(b)) {
    const ka = Object.keys(a).filter((k) => a[k] !== undefined)
    const kb = Object.keys(b).filter((k) => b[k] !== undefined)
    return ka.length === kb.length && ka.every((k) => sameConfigValue(a[k], b[k]))
  }
  return false
}

export function valueAtPath(root: unknown, path: ConfigPath): unknown {
  let cur = root
  for (const seg of path) {
    if (!isPlainObject(cur) || !Object.prototype.hasOwnProperty.call(cur, seg)) return undefined
    cur = cur[seg]
  }
  return cur
}

function writeAt(root: Record<string, unknown>, op: ConfigPatchOp): void {
  let cur = root
  for (const seg of op.path.slice(0, -1)) {
    const next = Object.prototype.hasOwnProperty.call(cur, seg) ? cur[seg] : undefined
    if (!isPlainObject(next)) cur[seg] = {}
    cur = cur[seg] as Record<string, unknown>
  }
  const last = op.path[op.path.length - 1]
  if (op.unset) delete cur[last]
  else cur[last] = structuredClone(op.value)
}

const opBase = (op: ConfigPatchOp): { has: boolean; value: unknown } =>
  op.baseAbsent ? { has: true, value: undefined } : { has: 'base' in op, value: op.base }

/** Apply a validated patch to `current` (not modified). Every op is checked
 *  before any is written: one conflict and nothing changes. */
export function applyConfigPatch<T>(current: T, ops: readonly ConfigPatchOp[]): { config: T; conflicts: ConfigConflict[] } {
  const conflicts: ConfigConflict[] = []
  for (const op of ops) {
    const base = opBase(op)
    if (!base.has) continue
    const disk = valueAtPath(current, op.path)
    const writing = op.unset ? undefined : op.value
    if (!sameConfigValue(disk, base.value) && !sameConfigValue(disk, writing)) conflicts.push({ path: [...op.path], current: disk })
  }
  if (conflicts.length > 0) return { config: current, conflicts }
  const next = structuredClone(current) as unknown as Record<string, unknown>
  for (const op of ops) writeAt(next, op)
  return { config: next as unknown as T, conflicts }
}

// ─── Computing a patch (the renderer's side) ─────────────────────────────────

/** The ops that turn `base` into `draft`: one per changed leaf; arrays whole. */
export function diffConfig(base: unknown, draft: unknown, at: string[] = []): ConfigPatchOp[] {
  const walkable = (v: unknown): boolean => isPlainObject(v) || v === undefined
  if ((isPlainObject(base) || isPlainObject(draft)) && walkable(base) && walkable(draft) && at.length < CONFIG_PATCH_LIMITS.maxDepth) {
    // A section that appears or disappears whole is one op, not one per leaf.
    if (base === undefined || draft === undefined) return diffLeaf(base, draft, at)
    const ops: ConfigPatchOp[] = []
    for (const key of new Set([...Object.keys(base as object), ...Object.keys(draft as object)])) {
      ops.push(...diffConfig((base as Record<string, unknown>)[key], (draft as Record<string, unknown>)[key], [...at, key]))
    }
    return ops
  }
  return diffLeaf(base, draft, at)
}

function diffLeaf(base: unknown, draft: unknown, at: string[]): ConfigPatchOp[] {
  if (sameConfigValue(base, draft)) return []
  const baseField = base === undefined ? { baseAbsent: true as const } : { base }
  return [draft === undefined ? { path: at, unset: true, ...baseField } : { path: at, value: draft, ...baseField }]
}

/** Carry a page's unsaved edits onto a fresher config.
 *
 *  `fresh` is what main now has. The draft becomes `fresh` plus the page's own
 *  edits (draft vs its old baseline). The new baseline is `fresh` — except at
 *  the paths the page edited, which keep the OLD baseline value, so that if
 *  someone else changed one of them the next save still reports a conflict
 *  instead of quietly writing over it. */
export function rebaseDraft<T>(baseline: T, draft: T, fresh: T): { baseline: T; draft: T } {
  const edits = diffConfig(baseline, draft)
  if (edits.length === 0) return { baseline: fresh, draft: fresh }
  const nextDraft = applyConfigPatch(fresh, edits.map(({ base: _b, baseAbsent: _a, ...op }) => op)).config
  const keepBase = edits.map((e): ConfigPatchOp => e.baseAbsent ? { path: e.path, unset: true } : { path: e.path, value: e.base })
  const nextBaseline = applyConfigPatch(fresh, keepBase).config
  return { baseline: nextBaseline, draft: nextDraft }
}
