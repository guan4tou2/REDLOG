import http from 'http'
import crypto from 'crypto'
import fs from 'fs'
import path from 'path'
import os from 'os'
import { insertEvent, queryEvents, getEventCount, searchEvents } from '../db/events'
import { eventBus } from './event-bus'
import { extractTarget } from './target-extractor'

const TOKEN_PATH = path.join(os.homedir(), '.redlog', 'api-token')
const PORT_PATH = path.join(os.homedir(), '.redlog', 'api-port')

let server: http.Server | null = null
let apiToken = ''
let engagementId = 'default'
let operatorId = 'operator-1'

let lootDetectorRef: { scan: (text: string) => unknown[] } | null = null
let screenshotAgentRef: { captureNow: (trigger: string) => Promise<string | null> } | null = null
let ipMonitorRef: { status: unknown } | null = null
let scopeMonitorRef: { getViolations: () => unknown[]; getViolationCount: () => number; checkTarget: (target: string, command: string) => { inScope: boolean; violation: boolean } } | null = null

export function configureApi(opts: {
  engagementId: string
  operatorId: string
  lootDetector?: typeof lootDetectorRef
  screenshotAgent?: typeof screenshotAgentRef
  ipMonitor?: typeof ipMonitorRef
  scopeMonitor?: typeof scopeMonitorRef
}): void {
  engagementId = opts.engagementId
  operatorId = opts.operatorId
  if (opts.lootDetector) lootDetectorRef = opts.lootDetector
  if (opts.screenshotAgent) screenshotAgentRef = opts.screenshotAgent
  if (opts.ipMonitor) ipMonitorRef = opts.ipMonitor
  if (opts.scopeMonitor) scopeMonitorRef = opts.scopeMonitor
}

function generateToken(): string {
  const token = crypto.randomBytes(32).toString('hex')
  fs.mkdirSync(path.dirname(TOKEN_PATH), { recursive: true })
  fs.writeFileSync(TOKEN_PATH, token, { mode: 0o600 })
  return token
}

function writePort(port: number): void {
  fs.writeFileSync(PORT_PATH, String(port), { mode: 0o600 })
}

function auth(req: http.IncomingMessage): boolean {
  const header = req.headers.authorization
  if (!header) return false
  const parts = header.split(' ')
  return parts.length === 2 && parts[0] === 'Bearer' && parts[1] === apiToken
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

  if (!auth(req)) {
    json(res, 401, { error: 'Unauthorized. Set Authorization: Bearer <token>' })
    return
  }

  try {
    if (route === '/api/events' && req.method === 'POST') {
      const body = JSON.parse(await readBody(req))
      const agentType = body.agent_type || body.agentType || 'external'
      const data = body.data || {}
      let targetId = body.target_id || body.targetId || undefined

      if (agentType === 'shell' && data.command) {
        const detected = extractTarget(data.command as string)
        if (detected) {
          data.detectedTarget = detected
          if (!targetId) targetId = detected
        }
        if (detected && scopeMonitorRef) {
          scopeMonitorRef.checkTarget(detected, data.command as string)
        }
        if (data.output && lootDetectorRef) {
          lootDetectorRef.scan(data.output as string, targetId)
        }
      }

      const event = insertEvent(agentType, data, { engagementId, operatorId, targetId })
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
      }, { engagementId, operatorId, targetId: body.target_id || body.targetId })
      eventBus.publish(event)
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

    json(res, 404, { error: `Unknown route: ${req.method} ${route}` })
  } catch (err) {
    json(res, 500, { error: (err as Error).message })
  }
}

export function startApiServer(port = 6660): Promise<number> {
  return new Promise((resolve, reject) => {
    apiToken = generateToken()

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
  return apiToken
}
