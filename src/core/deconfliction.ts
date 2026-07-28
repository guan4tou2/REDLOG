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
}

export const DEFAULT_DECONFLICTION: DeconflictionConfig = {
  enabled: false,
  url: '',
  secret: '',
  events: ['marker', 'system', 'credential_use', 'c2_checkin'],
  subtypes: ['scope_violation'],
  includeData: false
}

let active: DeconflictionConfig = { ...DEFAULT_DECONFLICTION }

const RETRY_INTERVALS_MS = [5_000, 30_000, 120_000]

export function configureDeconfliction(cfg: Partial<DeconflictionConfig>): void {
  active = { ...active, ...cfg }
}

export function getDeconflictionConfig(): DeconflictionConfig {
  return { ...active }
}

function shouldForward(event: RedLogEvent, cfg: DeconflictionConfig): boolean {
  if (!cfg.enabled || !cfg.url) return false
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

export function notifyDeconfliction(event: RedLogEvent): void {
  const cfg = active
  if (!shouldForward(event, cfg)) return
  const body = JSON.stringify(canonicalise(event, cfg))
  withRetry(cfg, body).catch(() => { /* silent — best effort */ })
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
