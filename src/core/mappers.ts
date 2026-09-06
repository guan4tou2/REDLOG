// Mappers — turn a producer's raw payload into an envelope's normalised
// fields (docs/DESIGN-plugin-kernel.md §2, §3).
//
// A mapper is DECLARATIVE: a JSON spec naming the agent_type it yields and,
// per output field, where in the raw JSON the value comes from. No code runs.
// The engine here is the only code, and it is deliberately small: dotted
// paths with array indexes, literals, and a `first-of` list. Anything a
// mapper cannot express is left in `extra`, and the raw bytes are always kept
// by the raw store — so an inexpressive mapper costs searchability, never
// evidence.
//
// Mappers are versioned. The envelope records which (id, version) produced
// its fields, so a mapper bug is fixed by re-running the new version over the
// raw and APPENDING a corrected row, never by editing the old one.

export interface MapperSpec {
  /** kebab id, unique per plugin. */
  id: string
  /** semver-ish string; recorded on every envelope this mapper produced. */
  version: string
  /** The agent_type every event from this mapper carries, or a path into the
   *  raw JSON that yields it (prefixed `$.`). */
  agentType: string
  /** Output field → source. A source is one of:
   *   `$.a.b[0]`   a path into the raw JSON
   *   `=literal`   a constant string
   *   `["$.x","$.y","=fallback"]`  first source that yields a defined value
   */
  fields: Record<string, string | string[]>
  /** Path to the producer's own timestamp, if it carries one. Milliseconds or
   *  ISO-8601; anything else is dropped rather than guessed. */
  tsSource?: string
  /** When true (default), top-level raw keys not consumed by `fields` are
   *  kept under `data.extra` so search can still reach them. */
  keepExtra?: boolean
}

export interface Mapped {
  agentType: string
  data: Record<string, unknown>
  tsSource: number | null
}

const PATH_RE = /^\$\.(.*)$/

/** Resolve `$.a.b[2].c` against `root`. Undefined when any hop is missing. */
export function resolvePath(root: unknown, expr: string): unknown {
  const m = PATH_RE.exec(expr)
  if (!m) return undefined
  if (m[1] === '') return root
  let cur: unknown = root
  for (const seg of m[1].split('.')) {
    if (cur === null || cur === undefined) return undefined
    const idx = /^([^[]+)((?:\[\d+\])+)$/.exec(seg)
    const key = idx ? idx[1] : seg
    cur = (cur as Record<string, unknown>)[key]
    if (idx) {
      for (const n of idx[2].matchAll(/\[(\d+)\]/g)) {
        if (!Array.isArray(cur)) return undefined
        cur = cur[Number(n[1])]
      }
    }
  }
  return cur
}

function resolveSource(root: unknown, src: string | string[]): unknown {
  const list = Array.isArray(src) ? src : [src]
  for (const s of list) {
    if (s.startsWith('=')) return s.slice(1)
    const v = resolvePath(root, s)
    if (v !== undefined) return v
  }
  return undefined
}

function topLevelKeyOf(src: string | string[]): string | null {
  const first = Array.isArray(src) ? src.find((s) => s.startsWith('$.')) : src
  if (!first || !first.startsWith('$.')) return null
  const seg = first.slice(2).split('.')[0]
  return seg.replace(/\[\d+\]$/, '') || null
}

function toEpochMs(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) {
    // Seconds vs milliseconds: anything before 2001 in ms is almost
    // certainly seconds. Producers that send seconds are common (Python).
    return v < 1e11 ? Math.round(v * 1000) : Math.round(v)
  }
  if (typeof v === 'string') {
    const n = Date.parse(v)
    return Number.isFinite(n) ? n : null
  }
  return null
}

/**
 * Apply a spec to a parsed raw payload. Pure. Throws only when the spec
 * cannot name an agent_type — every other failure degrades to a missing
 * field, because the raw is kept regardless.
 */
export function applyMapper(spec: MapperSpec, raw: unknown): Mapped {
  const agentType = spec.agentType.startsWith('$.')
    ? String(resolvePath(raw, spec.agentType) ?? '')
    : spec.agentType
  if (!agentType) throw new Error(`mapper ${spec.id}@${spec.version}: agentType path yielded nothing`)

  const data: Record<string, unknown> = {}
  const consumed = new Set<string>()
  for (const [field, src] of Object.entries(spec.fields)) {
    const v = resolveSource(raw, src)
    if (v !== undefined) data[field] = v
    const k = topLevelKeyOf(src)
    if (k) consumed.add(k)
  }
  if (spec.tsSource) {
    const k = topLevelKeyOf(spec.tsSource)
    if (k) consumed.add(k)
  }
  if (spec.keepExtra !== false && raw && typeof raw === 'object' && !Array.isArray(raw)) {
    const extra: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
      if (!consumed.has(k)) extra[k] = v
    }
    if (Object.keys(extra).length > 0) data.extra = extra
  }
  const tsSource = spec.tsSource ? toEpochMs(resolvePath(raw, spec.tsSource)) : null
  return { agentType, data, tsSource }
}

// ── Registry ────────────────────────────────────────────────────────────────
//
// Built-in mappers are few and boring by design. `identity` is what
// `POST /api/events` has always meant: the body IS the envelope's
// agent_type + data, so nothing moves. Plugins register the interesting ones.

export const IDENTITY_MAPPER: MapperSpec = {
  id: 'identity',
  version: '1',
  agentType: ['$.agent_type', '$.agentType'].join('|'), // resolved specially below
  fields: {},
  keepExtra: false
}

interface Registered { spec: MapperSpec; pluginId: string | null }
const registry = new Map<string, Registered>()

export function registerMappers(pluginId: string | null, specs: MapperSpec[]): void {
  for (const s of specs) registry.set(s.id, { spec: s, pluginId })
}

export function unregisterMappers(pluginId: string): void {
  for (const [id, r] of registry) if (r.pluginId === pluginId) registry.delete(id)
}

export function getMapper(id: string): MapperSpec | null {
  if (id === 'identity') return IDENTITY_MAPPER
  return registry.get(id)?.spec ?? null
}

export function listMappers(): Array<{ id: string; version: string; pluginId: string | null }> {
  return [...registry.values()].map((r) => ({ id: r.spec.id, version: r.spec.version, pluginId: r.pluginId }))
}

/** Test helper. */
export function _resetMappers(): void { registry.clear() }

/**
 * Map a raw payload with the named mapper. The identity mapper is handled
 * here because its "spec" is really a shape check: `{agent_type|agentType,
 * data}` in, the same out, `data` defaulting to `{}`.
 */
export function mapRaw(mapperId: string, raw: unknown): Mapped & { mapper: { id: string; version: string } } {
  if (mapperId === 'identity') {
    const r = (raw ?? {}) as Record<string, unknown>
    const agentType = String(r.agent_type ?? r.agentType ?? 'external')
    const data = (r.data && typeof r.data === 'object' && !Array.isArray(r.data)) ? { ...(r.data as Record<string, unknown>) } : {}
    const tsSource = toEpochMs(r.timestamp ?? r.ts_source ?? (data.timestamp as unknown))
    return { agentType, data, tsSource, mapper: { id: 'identity', version: '1' } }
  }
  const spec = getMapper(mapperId)
  if (!spec) throw new Error(`unknown mapper: ${mapperId}`)
  return { ...applyMapper(spec, raw), mapper: { id: spec.id, version: spec.version } }
}
