import http from 'http'
import fs from 'fs'
import path from 'path'
import os from 'os'
import { insertEvent, queryEvents, getEventCount, searchEvents } from './db/events'
import { createQuickMark, listQuickMarks } from './db/findings'
import {
  ensurePrimaryOperator,
  resolveOperatorByToken,
  listOperators,
  createOperator,
  updateOperatorToken,
  revokeOperator,
  deleteOperator,
  renameOperator,
  generateToken,
  slugifyOperatorId,
  getPrimaryOperator,
  type Operator
} from './db/operators'
import { eventBus } from './event-bus'
import { extractTarget } from './target-extractor'
import { anchorNow, listAnchors, verifyLatestAnchor, verifyChainFull, getAnchorById, buildOtsBundle } from './chain-anchor'
import { getChainLength } from './evidence-chain'
import { getNtpOffsetMs, getLastNtpQuery } from './clock'
import { redact, getRules } from './redaction'
import { exportBundle } from './bundle-export'
import { getDeconflictionConfig, testWebhook } from './deconfliction'

const TOKEN_PATH = path.join(os.homedir(), '.redlog', 'api-token')
const PORT_PATH = path.join(os.homedir(), '.redlog', 'api-port')

let server: http.Server | null = null
let primaryToken = ''
let engagementId = 'default'
let primaryOperatorId = ''
let primaryOperatorName = ''

let configLoaderRef: { getConfig: () => unknown; getTargets: () => string[] } | null = null

let lootDetectorRef: { scan: (text: string, targetId?: string) => Array<{ type: string; value: string; confidence: string }> } | null = null
let screenshotAgentRef: { captureNow: (trigger: string) => Promise<string | null> } | null = null
let ipMonitorRef: { status: unknown } | null = null
let scopeMonitorRef: {
  getViolations: () => unknown[]
  getViolationCount: () => number
  checkTarget: (target: string, command: string) => { inScope: boolean; violation: boolean }
} | null = null

export function configureApi(opts: {
  engagementId: string
  operatorId: string
  operatorName?: string
  configLoader?: typeof configLoaderRef
  lootDetector?: typeof lootDetectorRef
  screenshotAgent?: typeof screenshotAgentRef
  ipMonitor?: typeof ipMonitorRef
  scopeMonitor?: typeof scopeMonitorRef
}): void {
  engagementId = opts.engagementId
  primaryOperatorId = opts.operatorId
  if (opts.operatorName) primaryOperatorName = opts.operatorName
  if (opts.configLoader) configLoaderRef = opts.configLoader
  if (opts.lootDetector) lootDetectorRef = opts.lootDetector
  if (opts.screenshotAgent) screenshotAgentRef = opts.screenshotAgent
  if (opts.ipMonitor) ipMonitorRef = opts.ipMonitor
  if (opts.scopeMonitor) scopeMonitorRef = opts.scopeMonitor
}

function writePrimaryToken(): string {
  const token = generateToken()
  fs.mkdirSync(path.dirname(TOKEN_PATH), { recursive: true })
  fs.writeFileSync(TOKEN_PATH, token, { mode: 0o600 })
  primaryToken = token
  return token
}

function writePort(port: number): void {
  fs.writeFileSync(PORT_PATH, String(port), { mode: 0o600 })
}

function extractBearerToken(req: http.IncomingMessage): string | null {
  const header = req.headers.authorization
  if (!header) return null
  const parts = header.split(' ')
  if (parts.length !== 2 || parts[0] !== 'Bearer') return null
  return parts[1]
}

function authenticate(req: http.IncomingMessage): Operator | null {
  const token = extractBearerToken(req)
  if (!token) return null
  return resolveOperatorByToken(token)
}

function json(res: http.ServerResponse, status: number, data: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(data))
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => resolve(Buffer.concat(chunks).toString()))
    req.on('error', reject)
  })
}

function publicOperator(op: Operator): Record<string, unknown> {
  return {
    id: op.id,
    name: op.name,
    isPrimary: op.isPrimary,
    createdAt: op.createdAt,
    revokedAt: op.revokedAt
  }
}

async function handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const url = new URL(req.url || '/', `http://localhost`)
  const route = url.pathname

  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type')
  if (req.method === 'OPTIONS') {
    res.writeHead(204)
    res.end()
    return
  }

  if (route === '/api/health' && req.method === 'GET') {
    json(res, 200, { ok: true, version: '0.1.0' })
    return
  }

  const operator = authenticate(req)
  if (!operator) {
    json(res, 401, { error: 'Unauthorized. Set Authorization: Bearer <token>' })
    return
  }

  try {
    if (route === '/api/whoami' && req.method === 'GET') {
      json(res, 200, { operator: publicOperator(operator), engagementId })
      return
    }

    if (route === '/api/events' && req.method === 'POST') {
      const body = JSON.parse(await readBody(req))
      const agentType = body.agent_type || body.agentType || 'external'
      const data = body.data || {}
      let targetId = body.target_id || body.targetId || undefined

      let lootValues: string[] = []
      if (agentType === 'shell' && data.command) {
        const cmd = data.command as string
        const isStart = data.subtype === 'command_start'

        const detected = extractTarget(cmd)
        if (detected) {
          data.detectedTarget = detected
          if (!targetId) targetId = detected
        }

        if (isStart && detected && scopeMonitorRef) {
          scopeMonitorRef.checkTarget(detected, cmd)
        }

        if (!isStart && lootDetectorRef) {
          const textToScan = [cmd, data.output].filter(Boolean).join('\n')
          if (textToScan) {
            const matches = lootDetectorRef.scan(textToScan, targetId)
            lootValues = matches.map((m) => m.value).filter((v) => v && v.length >= 6)
          }
        }
      }

      const baseRules = getRules()
      const perEventRules = lootValues.length > 0
        ? { ...baseRules, denylist: [...baseRules.denylist, ...lootValues] }
        : baseRules

      for (const field of ['output', 'output_preview']) {
        if (typeof data[field] === 'string' && data[field]) {
          const result = redact(data[field] as string, perEventRules)
          data[field] = result.text
          if (result.redacted.length > 0) {
            const redactions = (data.redactions as unknown[] | undefined) ?? []
            data.redactions = [...redactions, ...result.redacted.map((r) => ({ ...r, field }))]
          }
        }
      }

      const event = insertEvent(agentType, data, {
        engagementId,
        operatorId: operator.id,
        targetId
      })
      if (!event) { json(res, 409, { error: 'Duplicate event (dedup window)' }); return }
      eventBus.publish(event)
      json(res, 201, event)
      return
    }

    if (route === '/api/events' && req.method === 'GET') {
      const agentType = url.searchParams.get('agent_type') || undefined
      const limit = parseInt(url.searchParams.get('limit') || '100')
      const since = url.searchParams.get('since') ? parseInt(url.searchParams.get('since')!) : undefined
      const targetId = url.searchParams.get('target_id') || undefined
      const events = queryEvents({ agentType, limit, since, targetId })
      json(res, 200, { count: events.length, events })
      return
    }

    if (route === '/api/events/search' && req.method === 'GET') {
      const q = url.searchParams.get('q') || ''
      const limit = parseInt(url.searchParams.get('limit') || '100')
      if (q.length < 2) {
        json(res, 400, { error: 'Query must be at least 2 characters' })
        return
      }
      const events = searchEvents(q, limit)
      json(res, 200, { count: events.length, events })
      return
    }

    if (route === '/api/events/count' && req.method === 'GET') {
      json(res, 200, { count: getEventCount() })
      return
    }

    if (route === '/api/marker' && req.method === 'POST') {
      const body = JSON.parse(await readBody(req))
      const event = insertEvent('marker', {
        title: body.title || 'Untitled',
        notes: body.notes || '',
        severity: body.severity || 'info',
        category: body.category || 'external'
      }, { engagementId, operatorId: operator.id, targetId: body.target_id || body.targetId })
      if (event) eventBus.publish(event)
      json(res, 201, event)
      return
    }

    if (route === '/api/loot/scan' && req.method === 'POST') {
      const body = JSON.parse(await readBody(req))
      if (!lootDetectorRef) {
        json(res, 503, { error: 'Loot detector not available' })
        return
      }
      const findings = lootDetectorRef.scan(body.text || '')
      json(res, 200, { findings })
      return
    }

    if (route === '/api/screenshot' && req.method === 'POST') {
      if (!screenshotAgentRef) {
        json(res, 503, { error: 'Screenshot agent not available' })
        return
      }
      const filePath = await screenshotAgentRef.captureNow('api')
      json(res, 200, { captured: !!filePath, filePath })
      return
    }

    if (route === '/api/status' && req.method === 'GET') {
      json(res, 200, {
        ip: ipMonitorRef?.status || null,
        eventCount: getEventCount(),
        scopeViolations: scopeMonitorRef?.getViolationCount() || 0
      })
      return
    }

    if (route === '/api/config' && req.method === 'GET') {
      json(res, 200, configLoaderRef?.getConfig() || {})
      return
    }

    if (route === '/api/scope' && req.method === 'GET') {
      json(res, 200, {
        configured: scopeMonitorRef ? true : false,
        targets: configLoaderRef?.getTargets() || [],
        violations: scopeMonitorRef?.getViolations() || [],
        violationCount: scopeMonitorRef?.getViolationCount() || 0
      })
      return
    }

    if (route === '/api/quickmarks' && req.method === 'GET') {
      json(res, 200, { quickmarks: listQuickMarks() })
      return
    }

    if (route === '/api/quickmarks' && req.method === 'POST') {
      const body = JSON.parse(await readBody(req))
      const mark = createQuickMark({
        title: body.title || 'Untitled',
        url: body.url,
        note: body.note || '',
        context: body.context || {}
      })
      json(res, 201, mark)
      return
    }

    if (route === '/api/recording' && req.method === 'GET') {
      json(res, 200, { recording: !eventBus.paused })
      return
    }

    if (route === '/api/recording' && req.method === 'POST') {
      const body = JSON.parse(await readBody(req))
      if (body.action === 'pause') eventBus.pause()
      else if (body.action === 'resume') eventBus.resume()
      else if (body.action === 'toggle') {
        if (eventBus.paused) eventBus.resume(); else eventBus.pause()
      }
      json(res, 200, { recording: !eventBus.paused })
      return
    }

    if (route === '/api/operators' && req.method === 'GET') {
      json(res, 200, { operators: listOperators().map(publicOperator) })
      return
    }

    if (route === '/api/chain' && req.method === 'GET') {
      const last = listAnchors(1)[0] ?? null
      json(res, 200, { length: getChainLength(), lastAnchor: last })
      return
    }

    if (route === '/api/anchors' && req.method === 'GET') {
      const limit = parseInt(url.searchParams.get('limit') || '50')
      json(res, 200, { anchors: listAnchors(limit) })
      return
    }

    if (route === '/api/anchors' && req.method === 'POST') {
      const anchor = await anchorNow()
      json(res, anchor ? 201 : 400, { anchor })
      return
    }

    if (route === '/api/export/bundle' && req.method === 'POST') {
      try {
        const bundle = exportBundle(engagementId)
        json(res, 201, { outDir: bundle.outDir, manifest: bundle.manifest })
      } catch (e) {
        json(res, 500, { error: (e as Error).message })
      }
      return
    }

    if (route === '/api/deconfliction' && req.method === 'GET') {
      const cfg = getDeconflictionConfig()
      json(res, 200, { ...cfg, secret: cfg.secret ? '***' : '' })
      return
    }

    if (route === '/api/deconfliction/test' && req.method === 'POST') {
      const result = await testWebhook(getDeconflictionConfig())
      json(res, 200, result)
      return
    }

    if (route === '/api/clock' && req.method === 'GET') {
      json(res, 200, {
        ntpOffsetMs: getNtpOffsetMs(),
        lastQueryAt: getLastNtpQuery(),
        hostWallMs: Date.now()
      })
      return
    }

    if (route === '/api/anchors/verify' && req.method === 'GET') {
      const full = url.searchParams.get('full') === '1'
      json(res, 200, full ? verifyChainFull() : verifyLatestAnchor())
      return
    }

    const otsMatch = route.match(/^\/api\/anchors\/([^/]+)\/ots$/)
    if (otsMatch && req.method === 'GET') {
      const anchor = getAnchorById(decodeURIComponent(otsMatch[1]))
      if (!anchor) { json(res, 404, { error: 'Anchor not found' }); return }
      const calendarFilter = url.searchParams.get('calendar')
      const receipt = anchor.calendarReceipts.find((r) =>
        r.ok && r.receiptB64 && (!calendarFilter || r.calendar === calendarFilter)
      )
      if (!receipt || !receipt.receiptB64) {
        json(res, 404, { error: 'No successful calendar receipt available for this anchor' })
        return
      }
      const bundle = buildOtsBundle(anchor.headHash, receipt.receiptB64)
      res.writeHead(200, {
        'Content-Type': 'application/octet-stream',
        'Content-Disposition': `attachment; filename="redlog-anchor-${anchor.id}.ots"`,
        'Content-Length': String(bundle.length),
        'X-Redlog-Head-Hash': anchor.headHash,
        'X-Redlog-Calendar': receipt.calendar
      })
      res.end(bundle)
      return
    }

    if (route === '/api/operators' && req.method === 'POST') {
      if (!operator.isPrimary) {
        json(res, 403, { error: 'Only the primary operator can create operators' })
        return
      }
      const body = JSON.parse(await readBody(req))
      const name = (body.name || '').toString().trim()
      if (!name) { json(res, 400, { error: 'name is required' }); return }
      const id = (body.id || '').toString().trim() || slugifyOperatorId(name)
      const token = generateToken()
      try {
        const op = createOperator({ id, name, token, isPrimary: false })
        json(res, 201, { operator: publicOperator(op), token })
      } catch (e) {
        json(res, 400, { error: (e as Error).message })
      }
      return
    }

    const opMatch = route.match(/^\/api\/operators\/([^/]+)(?:\/(rotate|revoke))?$/)
    if (opMatch) {
      const targetId = decodeURIComponent(opMatch[1])
      const action = opMatch[2]

      if (action === 'rotate' && req.method === 'POST') {
        if (!operator.isPrimary && operator.id !== targetId) {
          json(res, 403, { error: 'Cannot rotate another operator token' })
          return
        }
        const token = generateToken()
        const ok = updateOperatorToken(targetId, token)
        if (!ok) { json(res, 404, { error: 'Operator not found' }); return }
        if (targetId === primaryOperatorId) {
          fs.writeFileSync(TOKEN_PATH, token, { mode: 0o600 })
          primaryToken = token
        }
        json(res, 200, { token })
        return
      }

      if (action === 'revoke' && req.method === 'POST') {
        if (!operator.isPrimary) { json(res, 403, { error: 'Primary only' }); return }
        const ok = revokeOperator(targetId)
        json(res, ok ? 200 : 400, { revoked: ok })
        return
      }

      if (!action && req.method === 'PATCH') {
        if (!operator.isPrimary) { json(res, 403, { error: 'Primary only' }); return }
        const body = JSON.parse(await readBody(req))
        const name = (body.name || '').toString().trim()
        if (!name) { json(res, 400, { error: 'name is required' }); return }
        const ok = renameOperator(targetId, name)
        json(res, ok ? 200 : 404, { renamed: ok })
        return
      }

      if (!action && req.method === 'DELETE') {
        if (!operator.isPrimary) { json(res, 403, { error: 'Primary only' }); return }
        const ok = deleteOperator(targetId)
        json(res, ok ? 200 : 400, { deleted: ok })
        return
      }
    }

    json(res, 404, { error: `Unknown route: ${req.method} ${route}` })
  } catch (err) {
    json(res, 500, { error: (err as Error).message })
  }
}

export function startApiServer(port = 6660): Promise<number> {
  return new Promise((resolve, reject) => {
    const token = writePrimaryToken()
    ensurePrimaryOperator(primaryOperatorId, primaryOperatorName, token)

    server = http.createServer((req, res) => {
      handleRequest(req, res).catch((err) => {
        json(res, 500, { error: (err as Error).message })
      })
    })

    server.listen(port, '127.0.0.1', () => {
      const addr = server!.address()
      const actualPort = typeof addr === 'object' && addr ? addr.port : port
      writePort(actualPort)
      resolve(actualPort)
    })

    server.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'EADDRINUSE') {
        server!.listen(0, '127.0.0.1')
      } else {
        reject(err)
      }
    })
  })
}

export function stopApiServer(): void {
  server?.close()
  server = null
  try { fs.unlinkSync(TOKEN_PATH) } catch { /* */ }
  try { fs.unlinkSync(PORT_PATH) } catch { /* */ }
}

export function getApiToken(): string {
  return primaryToken
}

export function getPrimaryOperatorSnapshot(): Operator | null {
  return getPrimaryOperator()
}
