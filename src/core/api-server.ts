import http from 'http'
import fs from 'fs'
import path from 'path'
import os from 'os'
import { insertEvent, queryEvents, queryEventById, getEventCount, searchEvents, PAUSE_EXEMPT_AGENT_TYPES } from './db/events'
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
import { extractTarget, extractTargetWithProvenance } from './target-extractor'
import { detectPivot } from './pivot-detector'
import { detectCleanup, detectFileTransfer } from './technique-tagger'
import { tagCommand } from './command-tagger'
import { anchorNow, listAnchors, verifyLatestAnchor, verifyChainFullAsync, getAnchorById, buildOtsBundle, upgradeAnchor, upgradeAllPending } from './chain-anchor'
import { getChainLength } from './evidence-chain'
import { readCastSlice, readCastRange } from './cast-slice'
import { getNtpOffsetMs, getLastNtpQuery } from './clock'
import { redact, getRules } from './redaction'
import { sanitize } from './sanitize'
import { exportBundle } from './bundle-export'
import { getDeconflictionConfig, testWebhook } from './deconfliction'
import { handleMcpMessage, type ToolDispatch } from './mcp-tools'
import { listPluginTools, dispatchPluginTool } from './plugins/tool-registry'
import { getCaptureHealth } from './capture-health'
import { resolveIncomingCauses, noteStartEvent } from './causes-resolver'
import { isInsideDir } from './paths'
import { getProjectDir } from './db/index'
import { stampIoRefs, readBody as readIoBody, resolveRef as resolveIoRef, MAX_IO_READ_BYTES } from './io-store'

let appVersion = 'dev'
export function setAppVersion(v: string): void { appVersion = v }

const TOKEN_PATH = path.join(os.homedir(), '.redlog', 'api-token')
const PORT_PATH = path.join(os.homedir(), '.redlog', 'api-port')

let server: http.Server | null = null
let primaryToken = ''
let listeningPort = 6660
let engagementId = 'default'

let primaryOperatorId = ''
let primaryOperatorName = ''

let configLoaderRef: { getConfig: () => unknown; getTargets: () => string[] } | null = null

let lootDetectorRef: {
  scan: (text: string, targetId?: string, source?: string) => Array<{ type: string; value: string; confidence: string }>
  findMatches?: (text: string) => Array<{ type: string; value: string; line: string; confidence: string }>
  emit?: (matches: Array<{ type: string; value: string; line: string; confidence: string }>, opts: { targetId?: string; source?: string; causeEventId?: string }) => void
} | null = null
let screenshotAgentRef: { captureNow: (trigger: string) => Promise<string | null> } | null = null
let ipMonitorRef: { status: unknown } | null = null
let scopeMonitorRef: {
  getViolations: () => unknown[]
  getViolationCount: () => number
  checkTarget: (target: string, command: string) => { inScope: boolean; violation: boolean }
} | null = null

/** v0.9.6 (T2): lets main wire terminal-manager's live cast position in
 *  without core importing main. Same shape as setPluginHost / the tailer
 *  contribution sink. */
type CastProbe = (terminalId: string) => { castPath: string; offset: number; truncated: boolean } | null
let castProbe: CastProbe | null = null
export function setCastProbe(fn: CastProbe | null): void { castProbe = fn }

// Byte offset in the session cast at each command_start, keyed by terminalId.
// Bounded by the number of live terminals, and overwritten per command, so it
// needs no eviction beyond dropping the key when the pair completes.
const castOffsetAtStart = new Map<string, number>()

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

// Runs an MCP tool directly against the same internal functions the REST
// routes use, attributed to the operator the bearer token resolved to. This is
// the app-hosted counterpart of mcp/redlog-mcp-server.js's HTTP calls — same
// tools, no subprocess.
function makeMcpDispatch(operator: Operator): ToolDispatch {
  const attributed = { engagementId, operatorId: operator.id }

  return async (name, args): Promise<unknown> => {
    switch (name) {
      case 'redlog_status':
        return {
          ip: ipMonitorRef?.status ?? null,
          eventCount: getEventCount(),
          scopeViolations: scopeMonitorRef?.getViolationCount() ?? 0,
          capture: getCaptureHealth()
        }

      case 'redlog_whoami':
        return { operator: publicOperator(operator), engagementId }

      case 'redlog_operators_list':
        return { operators: listOperators().map(publicOperator) }

      case 'redlog_mark': {
        const event = insertEvent('marker', {
          title: args.title ?? 'Untitled',
          notes: args.notes ?? '',
          severity: args.severity ?? 'info',
          category: 'mcp'
        }, { ...attributed, targetId: args.target as string | undefined })
        if (event) eventBus.publish(event)
        return event
      }

      case 'redlog_log_event': {
        const data = (args.data as Record<string, unknown>) ?? {}
        const event = insertEvent(
          (args.agent_type as string) || 'agent',
          data,
          { ...attributed, targetId: args.target as string | undefined }
        )
        if (event) eventBus.publish(event)
        return event
      }

      case 'redlog_search':
        return { events: searchEvents(String(args.query ?? ''), Number(args.limit) || 20) }

      case 'redlog_events':
        return {
          events: queryEvents({
            agentType: args.agent_type as string | undefined,
            targetId: args.target as string | undefined,
            limit: Number(args.limit) || 50
          })
        }

      case 'redlog_scope':
        return {
          targets: configLoaderRef?.getTargets() ?? [],
          violations: scopeMonitorRef?.getViolations() ?? [],
          violationCount: scopeMonitorRef?.getViolationCount() ?? 0
        }

      case 'redlog_config':
        return configLoaderRef?.getConfig() ?? {}

      case 'redlog_quickmark':
        return createQuickMark({
          title: (args.title as string) || 'Untitled',
          url: args.url as string | undefined,
          note: (args.note as string) || '',
          context: {}
        })

      case 'redlog_quickmarks_list':
        return { quickmarks: listQuickMarks() }

      case 'redlog_loot_scan': {
        if (!lootDetectorRef) return { findings: [] }
        return { findings: lootDetectorRef.scan(String(args.text ?? ''), args.targetId ? String(args.targetId) : undefined, args.source ? String(args.source) : undefined) }
      }

      case 'redlog_screenshot': {
        if (!screenshotAgentRef) return { captured: false }
        const filePath = await screenshotAgentRef.captureNow('mcp')
        return { captured: !!filePath, filePath }
      }

      case 'redlog_recording': {
        const action = args.action as string
        if (action === 'pause') eventBus.pause('mcp')
        else if (action === 'resume') eventBus.resume('mcp')
        else if (action === 'toggle') { if (eventBus.paused) eventBus.resume('mcp'); else eventBus.pause('mcp') }
        return { recording: !eventBus.paused }
      }

      case 'redlog_chain_status':
        return { length: getChainLength(), lastAnchor: listAnchors(1)[0] ?? null }

      case 'redlog_chain_anchor_now':
        return { anchor: await anchorNow() }

      case 'redlog_chain_verify':
        return verifyLatestAnchor()

      case 'redlog_chain_upgrade':
        return args.anchor_id
          ? { anchor: await upgradeAnchor(String(args.anchor_id)) }
          : await upgradeAllPending()

      default: {
        // Route to a trusted 🔴 plugin tool if one owns this name.
        const plug = await dispatchPluginTool(name, args)
        if (plug.owned) return plug.result
        throw new Error(`Unknown tool: ${name}`)
      }
    }
  }
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
  // A dropped sidecar file (see selfHealSidecarFiles for why) would leave
  // `redlog-cli` unable to authenticate even though the server is happily
  // handling requests. Rewrite on every request — no-op when both files
  // exist.
  selfHealSidecarFiles()

  const url = new URL(req.url || '/', `http://localhost`)
  const route = url.pathname

  // v0.6.93 P0-E: strict Host allowlist. The server binds to 127.0.0.1 but
  // a browser can be tricked into DNS-rebinding a hostile hostname to
  // 127.0.0.1, then talking to us with the attacker's Origin. Reject any
  // Host header that isn't a known local name.
  const hostHeader = (req.headers.host || '').toLowerCase().split(':')[0]
  const HOST_ALLOWLIST = new Set(['localhost', '127.0.0.1', '[::1]', '::1', ''])
  if (!HOST_ALLOWLIST.has(hostHeader)) {
    res.writeHead(400)
    res.end('bad host')
    return
  }
  // v0.6.93 P0-E: was `Access-Control-Allow-Origin: *` — RedLog is a local-
  // only server, no browser should be reading responses from it. Reflect
  // the Origin (still allows the packaged Electron renderer, which uses
  // its own file:// or app:// scheme) but never wildcard. Downstream
  // clients (hooks, CLI) don't preflight and are unaffected.
  const origin = req.headers.origin
  if (origin && /^(app|file|http):\/\/(localhost|127\.0\.0\.1|\[::1\])(:|$|\/)/.test(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin)
    res.setHeader('Vary', 'Origin')
  }
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type')
  if (req.method === 'OPTIONS') {
    res.writeHead(204)
    res.end()
    return
  }

  if (route === '/api/health' && req.method === 'GET') {
    json(res, 200, { ok: true, version: typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : 'dev' })
    return
  }

  const operator = authenticate(req)
  if (!operator) {
    json(res, 401, { error: 'Unauthorized. Set Authorization: Bearer <token>' })
    return
  }

  try {
    // MCP over Streamable HTTP — the app hosts its own MCP server, so it is live
    // whenever RedLog is open. Connect with:
    //   claude mcp add --transport http redlog http://127.0.0.1:<port>/mcp \
    //     --header "Authorization: Bearer <operator-token>"
    if ((route === '/mcp' || route === '/api/mcp') && req.method === 'POST') {
      const parsed = JSON.parse(await readBody(req))
      const dispatch = makeMcpDispatch(operator)
      const messages = Array.isArray(parsed) ? parsed : [parsed]
      const extraTools = listPluginTools().map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema }))
      const responses = (await Promise.all(
        messages.map((m) => handleMcpMessage(m, { version: appVersion, dispatch, extraTools }))
      )).filter((r): r is Record<string, unknown> => r !== null)

      if (responses.length === 0) { res.writeHead(202); res.end(); return }
      json(res, 200, Array.isArray(parsed) ? responses : responses[0])
      return
    }

    if (route === '/api/whoami' && req.method === 'GET') {
      json(res, 200, { operator: publicOperator(operator), engagementId })
      return
    }

    if (route === '/api/events' && req.method === 'POST') {
      const body = JSON.parse(await readBody(req))
      const agentType = body.agent_type || body.agentType || 'external'
      const data = body.data || {}
      let targetId = body.target_id || body.targetId || undefined

      // v0.9.5: bail before ANY derivation while paused. The insertEvent gate
      // would drop the main row anyway, but the normalisation below runs first
      // and emits its own rows — scope_violation, loot, pivot, cleanup,
      // file_transfer. Those are `system`/derived and would leak the very
      // content the operator paused to keep out: a scope_violation names the
      // target host of a command that was never recorded.
      //
      // Must answer 200. The shell hook posts with `curl -sf`, so any non-2xx
      // makes it spool the payload to ~/.redlog/pending/ — which RedLog
      // replays on the next project open, putting the paused commands into the
      // chain after all. A refusal has to read as success on the wire.
      if (!PAUSE_EXEMPT_AGENT_TYPES.has(agentType) && eventBus.paused) {
        json(res, 200, { ok: true, recording: false, skipped: 'recording paused' })
        return
      }

      // v0.6.89 _causes wiring: resolve upstream event id from linker fields
      // that already exist on the payload (flow_id for http_*, terminal_id+pid
      // for shell command_end). The api-server keeps two small in-memory maps
      // (populated on the "start" side, consumed on the "end" side) so we don't
      // have to hit the DB per row. See causesResolver.ts for the shared cache.
      const causeIds = resolveIncomingCauses(agentType, data)
      if (causeIds.length > 0) {
        const existing = Array.isArray(data._causes) ? (data._causes as string[]) : []
        data._causes = [...new Set([...existing, ...causeIds])]
      }
      // v0.6.88 P0-B: strip any caller-supplied operator id from body/data.
      // The operator was already resolved from the Bearer token above
      // (`operator.id`) — accepting a body field would let any token holder
      // forge attribution. Warn once per stripped payload for audit trail.
      const forgedFields = ['operator_id', 'operatorId'].filter((k) => body[k] != null || data[k] != null)
      if (forgedFields.length > 0) {
        console.warn(`[api] stripped forged operator field from ${req.socket.remoteAddress || 'unknown'}: ${forgedFields.join(',')}`)
        for (const k of forgedFields) { delete body[k]; delete data[k] }
      }

      let lootValues: string[] = []
      let pendingLootMatches: Array<{ type: string; value: string; line: string; confidence: string }> = []
      let pivot: ReturnType<typeof detectPivot> = null
      let pivotClose: ReturnType<typeof detectPivot> = null
      let cleanup: ReturnType<typeof detectCleanup> = null
      let fileXfer: ReturnType<typeof detectFileTransfer> = null

      if (agentType === 'shell' && data.command) {
        const cmd = data.command as string
        const isStart = data.subtype === 'command_start'
        // A command_end for a foreground pivot (ssh -D running until Ctrl-C, etc.)
        // is our closest signal that the tunnel actually shut down. The near-zero
        // duration guard skips backgrounded `-fN`/`&` variants that exit instantly
        // while the tunnel keeps running — we can't tell those from a live pivot.
        const isEnd = data.subtype === 'command_end' && Number(data.duration_sec ?? 0) >= 2
        if (isEnd) pivotClose = detectPivot(cmd)
        // Stamp fields contributed by commandTag plugins (e.g. the bundled
        // mitre-common-tools plugin). Zero-config by default — no core patterns.
        // Downstream tagging (ELK/Splunk on the SIEM side) can replace this
        // entirely by disabling the plugin.
        // v0.9.6 (T2): bracket this command's output by byte range in the
        // session's .cast. The bytes stay on disk — only the reference enters
        // the chain, which is the v0.6.47 invariant (in-chain stdout blew up
        // on TUI output and made the hash cover ANSI noise). What changes is
        // that the operator can now SEE that output exists, and how much,
        // without clicking through to a replay.
        const termId = typeof data.terminalId === 'string' ? data.terminalId : null
        if (termId && data.source === 'builtin-terminal' && castProbe) {
          const pos = castProbe(termId)
          if (pos) {
            if (isStart) {
              castOffsetAtStart.set(termId, pos.offset)
            } else if (data.subtype === 'command_end') {
              const from = castOffsetAtStart.get(termId)
              castOffsetAtStart.delete(termId)
              // No matching start (hook installed mid-session, or RedLog
              // restarted between the pair) → record that we can't bracket it
              // rather than guessing a window.
              data.io = from === undefined
                ? { stream: 'cast', ref: pos.castPath, unbracketed: true, truncated: pos.truncated }
                : { stream: 'cast', ref: pos.castPath, off: from, len: Math.max(0, pos.offset - from), truncated: pos.truncated }
            }
          }
        }

        if (isStart) {
          const tagStamp = tagCommand(cmd)
          for (const [k, v] of Object.entries(tagStamp)) {
            if (data[k] === undefined) data[k] = v
          }
          cleanup = detectCleanup(cmd)
          fileXfer = detectFileTransfer(cmd)
        }

        // v0.9.1: extractTargetWithProvenance stamps plugin attribution
        // when a plugin-contributed extractor was the one that matched.
        // Built-in matches leave the two extra fields unset → shell-event
        // shape stays byte-identical for the built-in path.
        const detectedResult = extractTargetWithProvenance(cmd)
        const detected = detectedResult.host
        if (detected) {
          data.detectedTarget = detected
          if (detectedResult.pluginId) {
            data.extractor_plugin_id = detectedResult.pluginId
            data.extractor_name = detectedResult.extractorName
          }
          if (!targetId) targetId = detected
        }

        if (isStart && detected && scopeMonitorRef) {
          scopeMonitorRef.checkTarget(detected, cmd)
        }

        // Internal-network pivots (ligolo-ng, chisel, ssh -D/-L/-R, sshuttle,
        // proxychains, socat) get a first-class `pivot` event so the timeline
        // records the intermediate node / route, not just the raw command.
        if (isStart) pivot = detectPivot(cmd)

        if (!isStart && lootDetectorRef) {
          // v0.6.89: `redlog-run` wrapper now sends stdout/stderr as separate
          // fields. Scan both (plus the legacy `output` field for backward
          // compat with older CLI helpers). Any of them may be undefined.
          const textToScan = [cmd, data.stdout, data.stderr, data.output]
            .filter((s): s is string => typeof s === 'string' && s.length > 0)
            .join('\n')
          if (textToScan) {
            // v0.6.89 `_causes`: find matches now (so redaction denylist gets
            // fed) but defer the emit() until after the shell event is
            // inserted — the loot event's `_causes` must point at the
            // command_end that produced the stdout. Falls back to `scan()`
            // (which emits without cause) if the detector is an older shape
            // that pre-dates the split.
            if (lootDetectorRef.findMatches) {
              const matches = lootDetectorRef.findMatches(textToScan)
              pendingLootMatches = matches
              lootValues = matches.map((m) => m.value).filter((v) => v && v.length >= 6)
            } else {
              const matches = lootDetectorRef.scan(textToScan, targetId, cmd)
              lootValues = matches.map((m) => m.value).filter((v) => v && v.length >= 6)
            }
          }
        }
      }

      const baseRules = getRules()
      const perEventRules = lootValues.length > 0
        ? { ...baseRules, denylist: [...baseRules.denylist, ...lootValues] }
        : baseRules

      // Four-layer redaction (see docs/redaction-design.md): DETECT spans here,
      // but leave the raw bytes in data[field] so the hash chain closes over the
      // true text. The UI masks by default (layer 3) and `redlog-cli sanitize`
      // does the actual byte replacement at export time (layer 4).
      // v0.6.89: also redact new `stdout`/`stderr` fields so masked spans
      // land on them consistently with the existing `output` handling.
      for (const field of ['output', 'output_preview', 'command', 'stdout', 'stderr']) {
        if (typeof data[field] === 'string' && data[field]) {
          const result = redact(data[field] as string, perEventRules)
          if (result.redacted.length > 0) {
            const redactions = (data.redactions as unknown[] | undefined) ?? []
            data.redactions = [...redactions, ...result.redacted.map((r) => ({ ...r, field }))]
          }
        }
      }

      // io_ref sidecar (SPEC-IO-SIDECAR.md): move any posted full HTTP body into
      // <projectDir>/io/<sha256>.bin and replace it with a digest-only ref BEFORE
      // chaining, so the chain closes over the sha256, never the bytes (the
      // v0.6.47 invariant). No-op for events without a `*_body_full` field.
      try {
        stampIoRefs(data, getProjectDir())
      } catch (e) {
        // No active project dir (or write failed): never let raw bytes fall
        // through into the chain — drop the full-body fields, keep the preview.
        for (const f of ['request_body_full', 'request_body_ct', 'request_body_full_truncated',
          'response_body_full', 'response_body_ct', 'response_body_full_truncated']) delete data[f]
        console.warn(`[api] io sidecar skipped: ${(e as Error).message}`)
      }

      const event = insertEvent(agentType, data, {
        engagementId,
        operatorId: operator.id,
        targetId
      })
      if (!event) { json(res, 409, { error: 'Duplicate event (dedup window)' }); return }
      eventBus.publish(event)
      // v0.6.89 `_causes`: if this was a "start" event that later "end" events
      // will want to cite (shell.command_start, scanner.http_request_start),
      // cache its id in the in-memory resolver so the matching end event can
      // stamp `_causes: [thisId]` when it arrives.
      noteStartEvent(agentType, data, event.id)
      // v0.6.89 `_causes` for loot: emit the loot event NOW that we have the
      // shell command_end's id — so `_causes: [event.id]` points at the exact
      // command whose stdout produced the match. See loot-detector.emit().
      if (pendingLootMatches.length > 0 && lootDetectorRef?.emit) {
        lootDetectorRef.emit(pendingLootMatches, { targetId, source: data.command as string, causeEventId: event.id })
      }

      // Emit the companion pivot event (best-effort; never blocks the shell event).
      if (pivot) {
        try {
          const pv = insertEvent('pivot', {
            subtype: pivot.subtype, tool: pivot.tool, via: pivot.via, route: pivot.route,
            socks_port: pivot.socksPort, forward: pivot.forward, mitre_ttp: pivot.mitreTtp,
            command: data.command, description: `Pivot via ${pivot.tool}${pivot.via ? ` → ${pivot.via}` : ''}${pivot.route ? ` (${pivot.route})` : ''}`,
            // v0.6.89: pivot is a companion to the shell command_start that
            // triggered detectPivot — that's the event we just inserted above.
            _causes: [event.id]
          }, { engagementId, operatorId: operator.id, targetId: pivot.via ?? targetId })
          if (pv) eventBus.publish(pv)
        } catch { /* pivot event is additive; ignore failures */ }
      }
      // Anti-forensics / cleanup — first-class event so log-clearing or timestomp
      // never hides in a plain shell row (NIST SP 800-86 requires tracking these).
      if (cleanup) {
        try {
          const cv = insertEvent('cleanup', {
            subtype: cleanup.subtype, tool: cleanup.tool,
            target: cleanup.target, mitre_ttp: cleanup.mitreTtp,
            command: data.command,
            description: `Cleanup [${cleanup.tool}] ${cleanup.subtype}${cleanup.target ? ` → ${cleanup.target}` : ''}`,
            _causes: [event.id]
          }, { engagementId, operatorId: operator.id, targetId })
          if (cv) eventBus.publish(cv)
        } catch { /* additive */ }
      }
      // File transfer detected in a shell command — companion event so the
      // dedicated file_transfer lane shows ingress/exfil independent of shell noise.
      if (fileXfer) {
        try {
          const fv = insertEvent('file_transfer', {
            subtype: fileXfer.direction, tool: fileXfer.tool,
            url: fileXfer.url, localPath: fileXfer.localPath, remotePath: fileXfer.remotePath,
            mitre_ttp: fileXfer.mitreTtp,
            command: data.command,
            description: `${fileXfer.direction === 'download' ? '↓' : '↑'} ${fileXfer.tool}: ${fileXfer.url || fileXfer.remotePath || fileXfer.localPath || ''}`.trim(),
            _causes: [event.id]
          }, { engagementId, operatorId: operator.id, targetId })
          if (fv) eventBus.publish(fv)
        } catch { /* additive */ }
      }
      // Closed foreground pivot — a separate event so the audit trail shows both
      // ends of the tunnel, not only when it opened.
      if (pivotClose) {
        try {
          const pv = insertEvent('pivot', {
            subtype: 'closed', tool: pivotClose.tool, via: pivotClose.via,
            route: pivotClose.route, forward: pivotClose.forward,
            command: data.command, exit_code: data.exit_code,
            duration_sec: data.duration_sec,
            description: `Pivot closed [${pivotClose.tool}]${pivotClose.via ? ` → ${pivotClose.via}` : ''}`,
            _causes: [event.id]
          }, { engagementId, operatorId: operator.id, targetId: pivotClose.via ?? targetId })
          if (pv) eventBus.publish(pv)
        } catch { /* additive */ }
      }

      json(res, 201, event)
      return
    }

    if (route === '/api/events' && req.method === 'GET') {
      const agentType = url.searchParams.get('agent_type') || undefined
      const limit = parseInt(url.searchParams.get('limit') || '100')
      const since = url.searchParams.get('since') ? parseInt(url.searchParams.get('since')!) : undefined
      const before = url.searchParams.get('before') ? parseInt(url.searchParams.get('before')!) : undefined
      const targetId = url.searchParams.get('target_id') || undefined
      const events = queryEvents({ agentType, limit, since, before, targetId })
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
      const findings = lootDetectorRef.scan(body.text || '', body.targetId || undefined, body.source || undefined)
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
        scopeViolations: scopeMonitorRef?.getViolationCount() || 0,
        capture: getCaptureHealth()
      })
      return
    }

    if (route === '/api/capture' && req.method === 'GET') {
      json(res, 200, getCaptureHealth())
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
      if (body.action === 'pause') eventBus.pause('api')
      else if (body.action === 'resume') eventBus.resume('api')
      else if (body.action === 'toggle') {
        if (eventBus.paused) eventBus.resume('api'); else eventBus.pause('api')
      }
      json(res, 200, { recording: !eventBus.paused })
      return
    }

    if (route === '/api/operators' && req.method === 'GET') {
      json(res, 200, { operators: listOperators().map(publicOperator) })
      return
    }

    // Replay a builtin-terminal command by pulling its stdout out of the
    // asciinema .cast on disk instead of storing it in the chain. Given a
    // command_end event id, we find the matching session_start (same
    // terminalId) to get its castPath, then slice the .cast from the
    // preceding command_start to command_end.
    if (route === '/api/terminal/replay' && req.method === 'POST') {
      const body = JSON.parse(await readBody(req)) as { eventId?: string }
      const eventId = body.eventId
      if (!eventId) { json(res, 400, { error: 'eventId required' }); return }
      const target = queryEventById(eventId)
      if (!target) { json(res, 404, { error: 'event not found' }); return }
      const td = target.data as Record<string, unknown>
      const tid = td.terminalId as string | undefined
      if (target.agentType !== 'shell' || td.subtype !== 'command_end' || td.source !== 'builtin-terminal' || !tid) {
        json(res, 400, { error: 'not a builtin-terminal command_end event' }); return
      }
      // Find the session_start with matching terminalId (most recent one before target.timestamp)
      const sessions = queryEvents({ agentType: 'shell', limit: 5000 })
        .filter((e) => e.data?.subtype === 'session_start' && e.data.terminalId === tid && e.timestamp <= target.timestamp)
      const sess = sessions[0]
      const castPath = sess?.data?.castPath as string | undefined
      if (!castPath) { json(res, 404, { error: 'no cast file for this session' }); return }
      // v0.6.93 P0-D: castPath comes from an event whose `data` was written
      // by an attacker with a valid token — verify the resolved path is
      // inside the project's casts/ directory before reading. Was:
      // arbitrary-file-read via forged session_start `{castPath:"/…/.ssh/id_ed25519"}`.
      let castsDir: string
      try { castsDir = path.join(getProjectDir(), 'casts') } catch { json(res, 500, { error: 'no active project' }); return }
      const resolvedCast = path.resolve(castPath)
      if (!isInsideDir(castsDir, resolvedCast)) {
        json(res, 403, { error: 'castPath outside project casts directory' })
        return
      }
      const duration = Number(td.duration_sec ?? 0) * 1000
      // Guard against zero-duration events (instantaneous commands still get
      // a small window so echoed prompt/output isn't lost to rounding).
      const startMs = target.timestamp - Math.max(duration, 100)
      // v0.9.6 (T2): prefer the byte range stamped at capture time — O(len)
      // instead of streaming the file from 0. Falls back to the time window
      // for pre-v0.9.6 events and unbracketed pairs.
      const io = td.io as { off?: number; len?: number } | undefined
      const slice = typeof io?.off === 'number' && typeof io.len === 'number' && io.len > 0
        ? await readCastRange(resolvedCast, io.off, io.len)
          ?? await readCastSlice(resolvedCast, startMs, target.timestamp)
        : await readCastSlice(resolvedCast, startMs, target.timestamp)
      if (!slice) { json(res, 500, { error: 'failed to read cast file' }); return }
      json(res, 200, {
        command: td.command,
        exitCode: td.exit_code,
        durationSec: td.duration_sec,
        castPath,
        startMs,
        endMs: target.timestamp,
        bytes: slice.bytes,
        text: slice.text,
        truncated: slice.truncated
      })
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
        const err = e as Error
        // Log stack to main-process stderr so the failure is diagnosable
        // from an installed .app (`Console.app` or CLI). The JSON body still
        // gets only the message so tokens/paths don't leak to logs the caller
        // may forward.
        // v0.6.96 Sec-1: don't return err.stack in the HTTP response — leaks
        // absolute paths + module layout to any token holder. Stack stays in
        // console.error for local debugging.
        console.error('[export/bundle] failed:', err.stack || err.message)
        json(res, 500, { error: err.message })
      }
      return
    }

    // Four-layer redaction, layer 4 — sanitize event bytes for pre-delivery.
    // POST /api/sanitize { event_ids, fields, reason?, dry_run? }
    if (route === '/api/sanitize' && req.method === 'POST') {
      try {
        const body = JSON.parse(await readBody(req))
        const result = sanitize({
          eventIds: Array.isArray(body.event_ids) ? body.event_ids : [],
          fields: Array.isArray(body.fields) && body.fields.length ? body.fields : ['output', 'output_preview', 'command'],
          engagementId, operatorId: operator.id,
          reason: typeof body.reason === 'string' ? body.reason : undefined,
          dryRun: body.dry_run === true
        })
        json(res, result.dryRun ? 200 : 201, result)
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
      // v0.6.95 P0-4a: full walk goes through the async, chunked variant so
      // the main loop keeps servicing other HTTP requests while it runs.
      json(res, 200, full ? await verifyChainFullAsync() : verifyLatestAnchor())
      return
    }

    if (route === '/api/anchors/upgrade-all' && req.method === 'POST') {
      const result = await upgradeAllPending()
      json(res, 200, result)
      return
    }

    const upgradeMatch = route.match(/^\/api\/anchors\/([^/]+)\/upgrade$/)
    if (upgradeMatch && req.method === 'POST') {
      const result = await upgradeAnchor(decodeURIComponent(upgradeMatch[1]))
      json(res, result ? 200 : 404, { anchor: result })
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
      listeningPort = actualPort
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
  // Deliberately NOT deleting TOKEN_PATH / PORT_PATH here anymore. Rationale:
  // the previous behaviour caused a class of hard-to-diagnose CLI failures
  // where the operator saw a live API on 6660 (via `lsof` / curl `/api/health`)
  // but `redlog-cli` bailed with "no api-token found". Root cause: on this box
  // the app process outlived what looked like a normal shutdown handshake, then
  // something (macOS session restore, a Finder move, an operator cleanup)
  // dropped the files while the port was still bound — and `stopApiServer`'s
  // eager delete matched that same shape. The files are mode 0600 anyway, so
  // leaving them around across restarts costs nothing; a future startApiServer
  // rewrites them unconditionally. Self-heal below rewrites on demand too.
}

/**
 * Idempotent — writes the token/port files if either is missing. Called from
 * the request handler so a live server always has matching sidecar files even
 * if the operator deleted them (or macOS did). Cheap: two `fs.existsSync`
 * calls per request; only writes when actually missing.
 */
function selfHealSidecarFiles(): void {
  if (!primaryToken) return
  try {
    if (!fs.existsSync(TOKEN_PATH)) {
      fs.mkdirSync(path.dirname(TOKEN_PATH), { recursive: true })
      fs.writeFileSync(TOKEN_PATH, primaryToken, { mode: 0o600 })
    }
    if (listeningPort && !fs.existsSync(PORT_PATH)) {
      fs.writeFileSync(PORT_PATH, String(listeningPort), { mode: 0o600 })
    }
  } catch { /* best effort */ }
}

export function getApiToken(): string {
  return primaryToken
}

export function getApiPort(): number {
  return listeningPort
}

// v0.6.96 Clean-2: removed getPrimaryOperatorSnapshot() — was never called.
// Callers that want the primary operator import getPrimaryOperator from
// './db/operators' directly.
