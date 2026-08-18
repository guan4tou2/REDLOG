import crypto from 'crypto'
import https from 'https'
import http from 'http'
import { URL } from 'url'
import { RedLogEvent } from './db/events'

export interface DeconflictionConfig {
  enabled: boolean
  url: string
  secret: string
  events: string[]     // agent_type values that should be forwarded
  subtypes: string[]   // optional subtype values (any match forwards)
  includeData: boolean // include full event.data, or just metadata + description
  /** Lowest §3 authority tier to forward (G-C2). 'inferred' (default) forwards
   *  everything, labelled; 'fact' forwards only observed rule matches, holding
   *  proximity inferences back. Events that carry no `authority` are unaffected
   *  — absence is not an inferred claim, and quietly cutting the blue team off
   *  from real activity is the wrong direction to fail in. */
  authorityFloor: 'inferred' | 'fact'
}

export const DEFAULT_DECONFLICTION: DeconflictionConfig = {
  enabled: false,
  url: '',
  secret: '',
  // NOTE: 'system' here already forwards every system event, so the `subtypes`
  // entry below is decorative for `scope_violation` — it matters only if an
  // operator removes 'system' from this list.
  events: ['marker', 'system', 'credential_use', 'c2_checkin'],
  subtypes: ['scope_violation'],
  includeData: false,
  // Default forwards both tiers. Narrowing what an outward-facing feed tells
  // the blue team is a deliberate act, not a default.
  authorityFloor: 'inferred'
}

let active: DeconflictionConfig = { ...DEFAULT_DECONFLICTION }

const RETRY_INTERVALS_MS = [5_000, 30_000, 120_000]

export function configureDeconfliction(cfg: Partial<DeconflictionConfig>): void {
  active = { ...active, ...cfg }
}

export function getDeconflictionConfig(): DeconflictionConfig {
  return { ...active }
}

/** G-C2: the authority gate is applied AFTER the match, not inside one branch —
 *  an event can arrive here via `events` or via `subtypes`, and the tier rule
 *  must hold either way. */
function passesAuthorityFloor(event: RedLogEvent, cfg: DeconflictionConfig): boolean {
  if (cfg.authorityFloor !== 'fact') return true
  const authority = event.data?.authority as string | undefined
  return authority !== 'inferred'
}

function shouldForward(event: RedLogEvent, cfg: DeconflictionConfig): boolean {
  if (!cfg.enabled || !cfg.url) return false
  if (!passesAuthorityFloor(event, cfg)) return false
  if (cfg.events.includes(event.agentType)) return true
  const subtype = (event.data?.subtype as string | undefined) ?? ''
  return subtype !== '' && cfg.subtypes.includes(subtype)
}

function canonicalise(event: RedLogEvent, cfg: DeconflictionConfig): Record<string, unknown> {
  const base = {
    id: event.id,
    timestamp: event.timestamp,
    engagement_id: event.engagementId,
    operator_id: event.operatorId,
    agent_type: event.agentType,
    target_id: event.targetId,
    hostname: event.hostname,
    hash: event.hash,
    subtype: (event.data?.subtype as string | undefined) ?? null,
    description: (event.data?.description as string | undefined) ?? null,
    severity: (event.data?.severity as string | undefined) ?? null,
    // G-C2: without these the blue team received a proximity INFERENCE in the
    // same shape as an observed rule match — a `scope_violation` for a
    // neighbouring host was indistinguishable from one for an explicitly
    // forbidden target. Both are bounded enums, so they carry no PII and are
    // safe outside the `includeData` gate.
    authority: (event.data?.authority as string | undefined) ?? null,
    reason: (event.data?.reason as string | undefined) ?? null,
    mitre_ttp: event.data?.mitre_ttp ?? null
  }
  if (cfg.includeData) return { ...base, data: event.data }
  return base
}

function signBody(body: string, secret: string): string {
  return crypto.createHmac('sha256', secret).update(body).digest('hex')
}

function postOnce(cfg: DeconflictionConfig, body: string): Promise<{ ok: boolean; status: number; error?: string }> {
  return new Promise((resolve) => {
    let parsed: URL
    try { parsed = new URL(cfg.url) } catch (e) { return resolve({ ok: false, status: 0, error: (e as Error).message }) }
    const transport = parsed.protocol === 'https:' ? https : http
    const sig = signBody(body, cfg.secret)
    const req = transport.request({
      hostname: parsed.hostname,
      port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
      path: parsed.pathname + parsed.search,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
        'User-Agent': 'RedLog-deconfliction/0.1',
        'X-Redlog-Signature': `sha256=${sig}`
      },
      timeout: 5000
    }, (res) => {
      res.on('data', () => { /* drain */ })
      res.on('end', () => {
        const s = res.statusCode ?? 0
        resolve({ ok: s >= 200 && s < 300, status: s })
      })
    })
    req.on('error', (err) => resolve({ ok: false, status: 0, error: err.message }))
    req.on('timeout', () => { req.destroy(); resolve({ ok: false, status: 0, error: 'timeout' }) })
    req.write(body)
    req.end()
  })
}

async function withRetry(cfg: DeconflictionConfig, body: string): Promise<void> {
  for (let i = 0; i < RETRY_INTERVALS_MS.length + 1; i++) {
    const res = await postOnce(cfg, body)
    if (res.ok) return
    if (i >= RETRY_INTERVALS_MS.length) return
    await new Promise((r) => setTimeout(r, RETRY_INTERVALS_MS[i]))
  }
}

// v0.6.97 A: coalesce events before POSTing. Pre-v0.6.97: 1 event = 1 POST
// with retry storm; a 200 evt/s burst (mitmproxy scan) fires 200 POSTs/s at
// the SIEM. Now: buffer + flush every 500ms as a JSON array. Semantics
// change: the SIEM must accept `Array<Event>` bodies. Since deconfliction
// is opt-in and the receiver is operator-configured, this is documented in
// the webhook spec + the pre-flight `testWebhook` still fires a single-event
// body so operators can see whether their receiver handles the empty case.
const BATCH_FLUSH_MS = 500
const MAX_BATCH = 100
let pendingBatch: Array<Record<string, unknown>> = []
let batchFlushTimer: ReturnType<typeof setTimeout> | null = null
let flushCfgSnapshot: DeconflictionConfig | null = null

function flushBatch(): void {
  batchFlushTimer = null
  const batch = pendingBatch
  const cfg = flushCfgSnapshot
  pendingBatch = []
  flushCfgSnapshot = null
  if (!cfg || batch.length === 0) return
  const body = JSON.stringify(batch)
  withRetry(cfg, body).catch(() => { /* silent — best effort */ })
}

export function notifyDeconfliction(event: RedLogEvent): void {
  const cfg = active
  if (!shouldForward(event, cfg)) return
  pendingBatch.push(canonicalise(event, cfg))
  // v0.6.100 F2: capture the cfg at first-event-in-batch, not per-event.
  // Pre-v0.6.100 the assignment ran on every notify, so if the operator
  // rotated the webhook URL / secret mid-batch the buffered events (still
  // canonicalised under the OLD cfg's `includeData`/`events` filters)
  // would be POSTed to the NEW cfg's endpoint. Now the batch belongs to
  // whichever cfg was active when it opened.
  if (!flushCfgSnapshot) flushCfgSnapshot = cfg
  if (pendingBatch.length >= MAX_BATCH) {
    if (batchFlushTimer) { clearTimeout(batchFlushTimer); batchFlushTimer = null }
    flushBatch()
    return
  }
  if (!batchFlushTimer) batchFlushTimer = setTimeout(flushBatch, BATCH_FLUSH_MS)
}

// v0.6.100 F1: shutdown-flush entry point. `app.on('before-quit')` calls this
// so up-to-500ms of buffered events don't vanish when the operator quits mid-
// engagement. Runs synchronously — we clear the timer, wrap the POST in
// withRetry, and return immediately. Electron's `before-quit` doesn't await
// the promise, so a slow receiver can still lose the last batch, but at
// least the POST fires. Best-effort; the operator's chain integrity doesn't
// depend on deconfliction delivery — the SIEM is a downstream mirror.
export function flushDeconflictionOnShutdown(): void {
  if (batchFlushTimer) { clearTimeout(batchFlushTimer); batchFlushTimer = null }
  if (pendingBatch.length > 0) flushBatch()
}

/** Test-only: drain pending batch synchronously (fires the POST). */
export function _flushDeconflictionForTest(): void {
  if (batchFlushTimer) { clearTimeout(batchFlushTimer); batchFlushTimer = null }
  flushBatch()
}

export async function testWebhook(cfg: DeconflictionConfig): Promise<{ ok: boolean; status: number; error?: string }> {
  if (!cfg.url) return { ok: false, status: 0, error: 'no url configured' }
  const body = JSON.stringify({
    id: 'test',
    engagement_id: 'test',
    agent_type: 'system',
    subtype: 'deconfliction_test',
    timestamp: Date.now(),
    description: 'RedLog deconfliction webhook test',
    test: true
  })
  return postOnce(cfg, body)
}
