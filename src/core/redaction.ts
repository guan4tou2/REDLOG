import { runBoundedRules, PLUGIN_RULES_BUDGET_MS } from './bounded-regex'

export interface RedactionRules {
  allowlist: string[]
  denylist: string[]
  entropyThreshold: number
  minLength: number
}

export const DEFAULT_RULES: RedactionRules = {
  allowlist: [],
  denylist: [],
  entropyThreshold: 4.5,
  minLength: 20
}

let activeRules: RedactionRules = { ...DEFAULT_RULES }

// Additive plugin layer (🟢 declarative): denylist entries contributed by
// plugins, kept per-plugin so they survive config reloads and can be removed
// on disable. Merged into the effective rules at read time.
//
// There is no plugin allowlist (#499). The allowlist is checked before the
// denylist and before the values loot detection found, so an entry from a
// plugin could stop either from masking anything at ingest; the spans fixed
// there are what an export is masked by, so nothing later would put it back.
// Letting a value through is the operator's setting (`redaction.allowlist`).
const pluginRules = new Map<string, string[]>()
export interface RedactionRuleRejection { list: 'denylist'; entry: string; reason: string }

/** Register a plugin's redaction entries. An entry written `/…/` is a regex;
 *  one that does not compile used to be dropped when the rules were first read,
 *  with nothing said, while the plugin stayed ACTIVE. It is kept out here and
 *  named in `rejected` so the caller can report it. Plain entries (substring
 *  matches) always compile. */
export function registerRedactionRules(pluginId: string, rules: { denylist?: string[] }): { accepted: number; rejected: RedactionRuleRejection[] } {
  const rejected: RedactionRuleRejection[] = []
  const denylist: string[] = []
  for (const entry of rules.denylist ?? []) {
    if (typeof entry !== 'string' || entry === '') { rejected.push({ list: 'denylist', entry: String(entry), reason: 'empty entry' }); continue }
    if (entry.startsWith('/') && entry.endsWith('/') && entry.length > 2) {
      try { new RegExp(entry.slice(1, -1)) }
      catch (e) { rejected.push({ list: 'denylist', entry, reason: (e as Error).message }); continue }
    }
    denylist.push(entry)
  }
  pluginRules.set(pluginId, denylist)
  stoppedPluginRegexes.clear()
  invalidateCache()
  return { accepted: denylist.length, rejected }
}

export function unregisterRedactionRules(pluginId: string): void {
  pluginRules.delete(pluginId)
  stoppedPluginRegexes.clear()
  invalidateCache()
}

// v0.12.1: cache the merged rules + precompiled patterns. Before this,
// `effectiveRules` allocated two arrays + two Sets on every getRules() call
// and matchesAny recompiled every /regex/ pattern per token — at 20 denylist
// regex × 100 tokens per shell command_end stdout that's 2000 new RegExp()
// calls per event. Cache invalidates on configureRedaction /
// (un)registerRedactionRules.
interface CompiledPattern {
  raw: string
  re: RegExp | null    // non-null when raw is /.../ shaped
  literal: string | null  // non-null when raw is a plain includes() substring
  /** A regex a plugin contributed. It runs in the bounded worker, never inline:
   *  a catastrophically backtracking pattern would freeze ingest (#499). */
  bounded?: boolean
}
interface CachedRules {
  rules: RedactionRules
  denyCompiled: CompiledPattern[]
  allowCompiled: CompiledPattern[]
}
let cachedRules: CachedRules | null = null

function compilePattern(p: string, bounded: boolean): CompiledPattern | null {
  if (!p) return null
  if (p.startsWith('/') && p.endsWith('/') && p.length > 2) {
    try { return { raw: p, re: new RegExp(p.slice(1, -1)), literal: null, ...(bounded ? { bounded: true } : {}) } }
    catch { return null }
  }
  return { raw: p, re: null, literal: p }
}

/** The regex entries only plugins vouch for: one the operator also wrote in
 *  `redaction.denylist` is theirs and runs as before. */
function pluginRegexEntries(): Set<string> {
  const out = new Set<string>()
  for (const entries of pluginRules.values()) {
    for (const e of entries) if (e.startsWith('/') && e.endsWith('/') && e.length > 2 && !activeRules.denylist.includes(e)) out.add(e)
  }
  return out
}

function compileList(patterns: string[], boundedEntries?: ReadonlySet<string>): CompiledPattern[] {
  const out: CompiledPattern[] = []
  for (const p of patterns) {
    const c = compilePattern(p, boundedEntries?.has(p) ?? false)
    if (c) out.push(c)
  }
  return out
}

/** Plugin regexes that overran their time budget. They are skipped from then
 *  on: a rule that cannot finish masks nothing either, and re-running it would
 *  stall every event for the budget again. Cleared when a plugin's rules change
 *  so a corrected rule gets a fresh start. */
const stoppedPluginRegexes = new Set<string>()

/** Indexes of the tokens a plugin denylist regex matches. Every such regex runs
 *  in one bounded worker trip over all the tokens (each tested alone, as the
 *  inline path did); one that overruns is stopped and the rest run again. */
function pluginDenyHits(compiled: CompiledPattern[], tokens: string[]): Set<number> {
  const hits = new Set<number>()
  if (tokens.length === 0) return hits
  const live = compiled
    .filter((c) => c.bounded && c.re && !stoppedPluginRegexes.has(c.raw))
    .map((c) => ({ c, stopped: undefined as 'time_limit' | undefined }))
  if (live.length === 0) return hits
  const results = runBoundedRules(
    live,
    ({ c }) => ({ source: c.re!.source, flags: c.re!.flags, group: 0, each: true }),
    tokens.join('\n'),
    ({ c }) => {
      stoppedPluginRegexes.add(c.raw)
      console.warn(`[redaction] plugin denylist ${c.raw} exceeded ${PLUGIN_RULES_BUDGET_MS} ms and was stopped`)
    }
  )
  for (const [, found] of results) for (const m of found) hits.add(m.index)
  return hits
}

function ensureCache(): CachedRules {
  if (cachedRules) return cachedRules
  const rules = pluginRules.size === 0
    ? activeRules
    : (() => {
        const denylist = [...activeRules.denylist]
        for (const entries of pluginRules.values()) denylist.push(...entries)
        return { ...activeRules, denylist: [...new Set(denylist)] }
      })()
  cachedRules = {
    rules,
    denyCompiled: compileList(rules.denylist, pluginRegexEntries()),
    allowCompiled: compileList(rules.allowlist)
  }
  return cachedRules
}

function invalidateCache(): void { cachedRules = null }

function effectiveRules(): RedactionRules {
  return ensureCache().rules
}

export function configureRedaction(rules: Partial<RedactionRules>): void {
  activeRules = { ...activeRules, ...rules }
  invalidateCache()
}

export function getRules(): RedactionRules {
  return effectiveRules()
}

export function shannonEntropy(s: string): number {
  if (!s) return 0
  const freq = new Map<string, number>()
  for (const ch of s) freq.set(ch, (freq.get(ch) ?? 0) + 1)
  let h = 0
  for (const count of freq.values()) {
    const p = count / s.length
    h -= p * Math.log2(p)
  }
  return h
}

const TOKEN_RE = /[A-Za-z0-9_\-\.\/+=]{16,}/g

function matchesCompiled(compiled: CompiledPattern[], token: string): boolean {
  for (const c of compiled) {
    if (c.bounded) continue // plugin regexes run in the worker: pluginDenyHits
    if (c.re) { if (c.re.test(token)) return true }
    else if (c.literal !== null && token.includes(c.literal)) return true
  }
  return false
}

export interface RedactionResult {
  /** The ORIGINAL text, unchanged. The hash chain closes over this — the four-
   *  layer design (see docs/redaction-design.md) treats capture as immutable and
   *  only sanitizes bytes at export time. Callers that want the masked view
   *  compose it via maskText() from the raw text + spans. */
  text: string
  redacted: Array<{ pattern: 'entropy' | 'denylist'; hint: string; start: number; end: number }>
}

export function redact(text: string, rules: RedactionRules = effectiveRules()): RedactionResult {
  if (!text) return { text, redacted: [] }
  const redacted: RedactionResult['redacted'] = []
  let m: RegExpExecArray | null
  // Clone the regex per call so shared `TOKEN_RE.lastIndex` state can't leak
  // between concurrent redact() calls (the module-level regex has /g).
  const re = new RegExp(TOKEN_RE.source, TOKEN_RE.flags)
  // v0.12.1: pick the precompiled lists when the caller passed the cached
  // rules object (the common path — main + tailer + insertEvent). When
  // callers pass a NEW rules object (api-server merges lootValues into the
  // denylist per event), compile once here rather than per token.
  const cache = ensureCache()
  const useCached = rules === cache.rules
  const denyCompiled = useCached ? cache.denyCompiled : compileList(rules.denylist, pluginRegexEntries())
  const allowCompiled = useCached ? cache.allowCompiled : compileList(rules.allowlist)
  const found: Array<{ token: string; offset: number }> = []
  while ((m = re.exec(text)) !== null) found.push({ token: m[0], offset: m.index })
  const pluginHits = pluginDenyHits(denyCompiled, found.map((f) => f.token))
  for (let i = 0; i < found.length; i++) {
    const { token, offset } = found[i]
    if (matchesCompiled(allowCompiled, token)) continue
    if (matchesCompiled(denyCompiled, token) || pluginHits.has(i)) {
      redacted.push({ pattern: 'denylist', hint: `${token.length} chars`, start: offset, end: offset + token.length })
      continue
    }
    if (token.length >= rules.minLength) {
      const entropy = shannonEntropy(token)
      if (entropy >= rules.entropyThreshold) {
        redacted.push({
          pattern: 'entropy',
          hint: `${token.length} chars, ${entropy.toFixed(2)} bits/char`,
          start: offset,
          end: offset + token.length
        })
      }
    }
  }
  return { text, redacted }
}

/** Compose the masked view — replace each span with `char` repeated span-length
 *  times. Used by the UI (mask-by-default) and by `redlog-cli sanitize`
 *  when writing an export bundle. The source text is never mutated in place —
 *  callers get a new string. */
export function maskText(text: string, spans: RedactionResult['redacted'], char = '•'): string {
  if (!spans.length) return text
  // Assume spans don't overlap (redact() emits non-overlapping matches). Sort
  // by start ascending so a single-pass rebuild is straightforward.
  const sorted = [...spans].sort((a, b) => a.start - b.start)
  const parts: string[] = []
  let cursor = 0
  for (const s of sorted) {
    if (s.start < cursor) continue // defensive: skip overlap with previous
    parts.push(text.slice(cursor, s.start))
    parts.push(char.repeat(Math.max(1, s.end - s.start)))
    cursor = s.end
  }
  parts.push(text.slice(cursor))
  return parts.join('')
}

/** Detect secrets across several string fields of one event payload and record
 *  the spans on `data.redactions`, tagged with the field they came from.
 *
 *  This is the shape layer 4 requires: `sanitize()` skips any event whose
 *  `data.redactions` is empty and any field with no span (src/core/sanitize.ts),
 *  so a producer that never attaches spans writes text that can never be masked
 *  at export — the operator watches the sanitize run report success while the
 *  secret ships in the bundle. Detecting is therefore part of writing, not an
 *  optional extra a producer can skip.
 *
 *  Mutates and returns `data` so a producer can wrap its payload inline. The raw
 *  bytes stay in place on purpose: the hash chain closes over the true text and
 *  only the export is rewritten (docs/redaction-design.md). */
export function redactFields(
  data: Record<string, unknown>,
  fields: readonly string[],
  rules?: RedactionRules
): Record<string, unknown> {
  rules ??= effectiveRules()
  for (const field of fields) {
    const value = data[field]
    if (typeof value !== 'string' || !value) continue
    const { redacted } = redact(value, rules)
    if (redacted.length === 0) continue
    const spans = (data.redactions as unknown[] | undefined) ?? []
    data.redactions = [...spans, ...redacted.map((r) => ({ ...r, field }))]
  }
  return data
}
