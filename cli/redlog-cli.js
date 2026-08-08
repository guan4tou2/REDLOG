#!/usr/bin/env node
// RedLog CLI — talk to the RedLog HTTP API from any shell or agent
// Usage: redlog-cli <command> [options]

const fs = require('fs')
const path = require('path')
const http = require('http')
const os = require('os')

let VERSION = 'dev'
try { VERSION = require('../package.json').version } catch { /* dev mode */ }

const TOKEN_PATH = path.join(os.homedir(), '.redlog', 'api-token')
const PORT_PATH = path.join(os.homedir(), '.redlog', 'api-port')

function readToken() {
  try { return fs.readFileSync(TOKEN_PATH, 'utf-8').trim() } catch {
    console.error('Error: RedLog not running (no api-token found at ~/.redlog/api-token)')
    process.exit(1)
  }
}

function readPort() {
  try { return parseInt(fs.readFileSync(PORT_PATH, 'utf-8').trim()) } catch { return 6660 }
}

function requestRaw(method, path) {
  return new Promise((resolve, reject) => {
    const token = readToken()
    const port = readPort()
    const opts = {
      hostname: '127.0.0.1', port, path, method,
      headers: { 'Authorization': `Bearer ${token}` }
    }
    const req = http.request(opts, (res) => {
      const chunks = []
      res.on('data', (c) => chunks.push(c))
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, buffer: Buffer.concat(chunks) }))
    })
    req.on('error', reject)
    req.end()
  })
}

function request(method, path, body) {
  return new Promise((resolve, reject) => {
    const token = readToken()
    const port = readPort()
    const postData = body ? JSON.stringify(body) : null

    const opts = {
      hostname: '127.0.0.1',
      port,
      path,
      method,
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
        ...(postData ? { 'Content-Length': Buffer.byteLength(postData) } : {})
      }
    }

    const req = http.request(opts, (res) => {
      const chunks = []
      res.on('data', (c) => chunks.push(c))
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString()
        try { resolve({ status: res.statusCode, data: JSON.parse(raw) }) }
        catch { resolve({ status: res.statusCode, data: raw }) }
      })
    })
    req.on('error', (err) => {
      if (err.code === 'ECONNREFUSED') {
        console.error(`Error: Cannot connect to RedLog API on port ${port}. Is RedLog running?`)
        process.exit(1)
      }
      reject(err)
    })
    if (postData) req.write(postData)
    req.end()
  })
}

function parseArgs(args) {
  const flags = {}
  const positional = []
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith('--')) {
      const key = args[i].slice(2)
      flags[key] = args[i + 1] || true
      i++
    } else {
      positional.push(args[i])
    }
  }
  return { flags, positional }
}

async function main() {
  const args = process.argv.slice(2)
  const command = args[0]

  if (!command || command === 'help' || command === '-h' || command === '--help') {
    console.log(`
RedLog CLI v${VERSION}

Usage:
  redlog-cli log <agent_type> [--target <id>] [--data '{"key":"val"}']
  redlog-cli mark <title> [--severity info|low|medium|high|critical] [--notes "..."] [--target <id>]
  redlog-cli search <query> [--limit N]
  redlog-cli events [--agent_type <type>] [--limit N] [--target <id>]
  redlog-cli loot <text>
  redlog-cli screenshot
  redlog-cli recording [status|pause|resume|toggle]
  redlog-cli quickmark [list|add <title> [--url <url>] [--note <text>]]
  redlog-cli replay <event_id>
  redlog-cli status
  redlog-cli health
  redlog-cli token
  redlog-cli whoami
  redlog-cli operators [list|add <name>|rotate <id>|revoke <id>|delete <id>]
  redlog-cli chain [status|anchor|verify [--full]|anchors|export-ots <id> [--out <file>]|upgrade [<id>|--all]]
  redlog-cli export bundle

Environment:
  REDLOG_TOKEN   Override the auto-detected API token
  REDLOG_PORT    Override the auto-detected API port

Examples:
  redlog-cli log terminal --data '{"subtype":"command","command":"nmap -sV target.com"}'
  redlog-cli mark "Found SQLi in /api/users" --severity high --target api.example.com
  redlog-cli search "password"
  redlog-cli loot "root:x:0:0:root:/root:/bin/bash"
  redlog-cli whoami
  redlog-cli operators add "Codex agent"
  redlog-cli chain anchor
  curl -s -H "Authorization: Bearer $(redlog-cli token)" http://127.0.0.1:6660/api/events
`)
    return
  }

  if (process.env.REDLOG_TOKEN) {
    fs.mkdirSync(path.dirname(TOKEN_PATH), { recursive: true })
    // Override for this invocation only — read from env
  }

  const { flags, positional } = parseArgs(args.slice(1))

  switch (command) {
    case 'log': {
      const agentType = positional[0]
      if (!agentType) { console.error('Usage: redlog-cli log <agent_type> [--target <id>] [--data \'...\']'); process.exit(1) }
      let data = {}
      if (flags.data) {
        try { data = JSON.parse(flags.data) } catch { data = { raw: flags.data } }
      }
      const res = await request('POST', '/api/events', {
        agent_type: agentType,
        data,
        target_id: flags.target || undefined
      })
      if (res.status === 201) {
        console.log(`Event created: ${res.data.id} (${res.data.agentType})`)
      } else {
        console.error(`Error ${res.status}:`, res.data)
        process.exit(1)
      }
      break
    }

    case 'mark': {
      const title = positional[0]
      if (!title) { console.error('Usage: redlog-cli mark <title> [--severity ...] [--notes ...] [--target ...]'); process.exit(1) }
      const res = await request('POST', '/api/marker', {
        title,
        severity: flags.severity || 'info',
        notes: flags.notes || '',
        target_id: flags.target || undefined
      })
      if (res.status === 201) {
        console.log(`Marker created: ${res.data.id} [${flags.severity || 'info'}] ${title}`)
      } else {
        console.error(`Error ${res.status}:`, res.data)
        process.exit(1)
      }
      break
    }

    case 'search': {
      const query = positional[0]
      if (!query) { console.error('Usage: redlog-cli search <query> [--limit N]'); process.exit(1) }
      const limit = flags.limit || 20
      const res = await request('GET', `/api/events/search?q=${encodeURIComponent(query)}&limit=${limit}`)
      if (res.status === 200) {
        console.log(`${res.data.count} results for "${query}":`)
        for (const e of res.data.events) {
          const time = new Date(e.timestamp).toLocaleTimeString()
          const target = e.targetId ? ` → ${e.targetId}` : ''
          console.log(`  [${time}] ${e.agentType}: ${JSON.stringify(e.data).slice(0, 100)}${target}`)
        }
      } else {
        console.error(`Error ${res.status}:`, res.data)
        process.exit(1)
      }
      break
    }

    case 'events': {
      const params = new URLSearchParams()
      if (flags.agent_type) params.set('agent_type', flags.agent_type)
      if (flags.limit) params.set('limit', flags.limit)
      if (flags.target) params.set('target_id', flags.target)
      const res = await request('GET', `/api/events?${params}`)
      if (res.status === 200) {
        console.log(`${res.data.count} events:`)
        for (const e of res.data.events.slice(0, 30)) {
          const time = new Date(e.timestamp).toLocaleTimeString()
          console.log(`  [${time}] ${e.agentType}: ${JSON.stringify(e.data).slice(0, 100)}`)
        }
        if (res.data.count > 30) console.log(`  ... and ${res.data.count - 30} more`)
      } else {
        console.error(`Error ${res.status}:`, res.data)
      }
      break
    }

    case 'loot': {
      const text = positional.join(' ')
      if (!text) { console.error('Usage: redlog-cli loot <text>'); process.exit(1) }
      const res = await request('POST', '/api/loot/scan', { text })
      if (res.status === 200) {
        const findings = res.data.findings || []
        if (findings.length === 0) {
          console.log('No loot detected.')
        } else {
          console.log(`${findings.length} loot item(s) found:`)
          for (const f of findings) {
            console.log(`  [${f.confidence}] ${f.type}: ${f.value}`)
          }
        }
      } else {
        console.error(`Error ${res.status}:`, res.data)
      }
      break
    }

    case 'screenshot': {
      const res = await request('POST', '/api/screenshot')
      if (res.status === 200) {
        console.log(res.data.captured ? `Screenshot saved: ${res.data.filePath}` : 'Screenshot failed')
      } else {
        console.error(`Error ${res.status}:`, res.data)
      }
      break
    }

    case 'recording': {
      const sub = positional[0] || 'status'
      if (sub === 'status') {
        const res = await request('GET', '/api/recording')
        if (res.status === 200) console.log(res.data.recording ? 'recording' : 'paused')
        else { console.error(`Error ${res.status}:`, res.data); process.exit(1) }
      } else if (sub === 'pause' || sub === 'resume' || sub === 'toggle') {
        const res = await request('POST', '/api/recording', { action: sub })
        if (res.status === 200) console.log(res.data.recording ? 'recording' : 'paused')
        else { console.error(`Error ${res.status}:`, res.data); process.exit(1) }
      } else {
        console.error('Usage: redlog-cli recording [status|pause|resume|toggle]'); process.exit(1)
      }
      break
    }

    case 'replay': {
      const evId = positional[0]
      if (!evId) { console.error('Usage: redlog-cli replay <event_id>'); process.exit(1) }
      const res = await request('POST', '/api/terminal/replay', { eventId: evId })
      if (res.status === 200) {
        const d = res.data
        console.log(`# ${d.command}  (exit ${d.exitCode}, ${d.durationSec}s)`)
        console.log(d.text || '(no output)')
      } else {
        console.error(`Error ${res.status}:`, res.data); process.exit(1)
      }
      break
    }

    case 'quickmark':
    case 'quickmarks': {
      const sub = positional[0] || 'list'
      if (sub === 'list') {
        const res = await request('GET', '/api/quickmarks')
        if (res.status === 200) {
          const list = res.data.quickmarks || []
          if (list.length === 0) console.log('(no quickmarks)')
          for (const m of list) console.log(`${m.id}  ${m.title}${m.url ? '  ' + m.url : ''}`)
        } else { console.error(`Error ${res.status}:`, res.data); process.exit(1) }
      } else if (sub === 'add' || sub === 'create') {
        const title = positional[1]
        if (!title) { console.error('Usage: redlog-cli quickmark add <title> [--url <url>] [--note <text>]'); process.exit(1) }
        const res = await request('POST', '/api/quickmarks', { title, url: flags.url, note: flags.note })
        if (res.status === 201) console.log(`Quickmark created: ${res.data.id}`)
        else { console.error(`Error ${res.status}:`, res.data); process.exit(1) }
      } else {
        console.error('Usage: redlog-cli quickmark [list|add <title> [--url <url>] [--note <text>]]'); process.exit(1)
      }
      break
    }

    case 'status': {
      const res = await request('GET', '/api/status')
      if (res.status === 200) {
        const d = res.data
        const ip = d.ip
        console.log(`RedLog Status:`)
        console.log(`  Events:     ${d.eventCount}`)
        console.log(`  Scope:      ${d.scopeViolations > 0 ? `${d.scopeViolations} violations` : 'OK'}`)
        if (ip) {
          console.log(`  IP safety:  ${ip.ipSafety || 'unknown'}`)
          console.log(`  External IP: ${ip.externalIP || 'unknown'}`)
        }
        if (d.capture) {
          const c = d.capture
          const mark = c.verdict === 'dark' ? '⚠ RECORDING NOTHING' : c.verdict === 'partial' ? 'wired but idle' : 'recording'
          console.log(`  Capture:    ${mark}`)
          for (const s of c.sources) {
            const flag = s.installed === false ? 'not installed' : s.state
            console.log(`    - ${s.id.padEnd(18)} ${flag}`)
          }
        }
      } else {
        console.error(`Error ${res.status}:`, res.data)
      }
      break
    }

    case 'health': {
      try {
        const port = readPort()
        const res = await request('GET', '/api/health')
        console.log(res.status === 200 ? `RedLog API running on port ${port}` : 'RedLog API error')
      } catch {
        console.error('RedLog API not reachable')
        process.exit(1)
      }
      break
    }

    case 'token': {
      const token = readToken()
      process.stdout.write(token)
      break
    }

    case 'whoami': {
      const res = await request('GET', '/api/whoami')
      if (res.status === 200) {
        const op = res.data.operator
        const tag = op.isPrimary ? ' (PRIMARY)' : ''
        console.log(`Operator: ${op.name}${tag}`)
        console.log(`  ID:         ${op.id}`)
        console.log(`  Engagement: ${res.data.engagementId}`)
      } else {
        console.error(`Error ${res.status}:`, res.data)
        process.exit(1)
      }
      break
    }

    case 'operators': {
      const sub = positional[0] || 'list'
      if (sub === 'list') {
        const res = await request('GET', '/api/operators')
        if (res.status === 200) {
          for (const op of res.data.operators) {
            const tag = op.isPrimary ? '[PRIMARY]' : op.revokedAt ? '[REVOKED]' : '         '
            console.log(`  ${tag} ${op.id.padEnd(28)} ${op.name}`)
          }
        } else { console.error(`Error ${res.status}:`, res.data); process.exit(1) }
      } else if (sub === 'add') {
        const name = positional.slice(1).join(' ')
        if (!name) { console.error('Usage: redlog-cli operators add <name>'); process.exit(1) }
        const res = await request('POST', '/api/operators', { name })
        if (res.status === 201) {
          console.log(`Created: ${res.data.operator.id}`)
          console.log(`Token (save now — not shown again):`)
          console.log(`  ${res.data.token}`)
        } else { console.error(`Error ${res.status}:`, res.data); process.exit(1) }
      } else if (sub === 'rotate') {
        const id = positional[1]
        if (!id) { console.error('Usage: redlog-cli operators rotate <id>'); process.exit(1) }
        const res = await request('POST', `/api/operators/${encodeURIComponent(id)}/rotate`)
        if (res.status === 200) {
          console.log(`New token for ${id}:`)
          console.log(`  ${res.data.token}`)
        } else { console.error(`Error ${res.status}:`, res.data); process.exit(1) }
      } else if (sub === 'revoke') {
        const id = positional[1]
        if (!id) { console.error('Usage: redlog-cli operators revoke <id>'); process.exit(1) }
        const res = await request('POST', `/api/operators/${encodeURIComponent(id)}/revoke`)
        console.log(res.status === 200 ? `Revoked ${id}` : `Error ${res.status}: ${JSON.stringify(res.data)}`)
        if (res.status !== 200) process.exit(1)
      } else if (sub === 'delete') {
        const id = positional[1]
        if (!id) { console.error('Usage: redlog-cli operators delete <id>'); process.exit(1) }
        const res = await request('DELETE', `/api/operators/${encodeURIComponent(id)}`)
        console.log(res.status === 200 ? `Deleted ${id}` : `Error ${res.status}: ${JSON.stringify(res.data)}`)
        if (res.status !== 200) process.exit(1)
      } else {
        console.error(`Unknown operators subcommand: ${sub}. Use list|add|rotate|revoke|delete`)
        process.exit(1)
      }
      break
    }

    case 'sanitize': {
      // Layer 4 of four-layer redaction (docs/redaction-design.md). Rewrites
      // event bytes for pre-delivery scrub by writing a masked copy to the
      // sanitized_events table + appending a system.sanitized chain event.
      // The source events row is never mutated.
      const eventIds = positional.filter((p) => !p.startsWith('--'))
      if (eventIds.length === 0) {
        console.error('Usage: redlog-cli sanitize <event-id> [<event-id> …] [--fields output,command] [--dry-run|--confirm] [--reason "..."]')
        process.exit(1)
      }
      const fields = (flags.fields ? String(flags.fields).split(',') : ['output', 'output_preview', 'command']).map((s) => s.trim()).filter(Boolean)
      const dryRun = !flags.confirm
      const res = await request('POST', '/api/sanitize', {
        event_ids: eventIds, fields,
        reason: flags.reason || undefined,
        dry_run: dryRun
      })
      if (res.status !== 200 && res.status !== 201) {
        console.error(`Error ${res.status}:`, res.data); process.exit(1)
      }
      const r = res.data
      if (r.planned.length === 0) {
        console.log('No sanitizable fields (event has no redaction spans, or fields not string).')
        break
      }
      console.log(dryRun ? '── Dry run — nothing written ──' : '── Applied ──')
      for (const p of r.planned) console.log(`  ${p.eventId}  ${p.field}  ${p.spanCount} span(s)  sha256=${p.replacementSha256.slice(0, 16)}…`)
      if (dryRun) console.log('Re-run with --confirm to write.')
      else console.log(`Wrote ${r.applied} row(s). system.sanitized event: ${r.sanitizedEventId}`)
      break
    }

    case 'export': {
      const sub = positional[0]
      if (sub === 'bundle') {
        const res = await request('POST', '/api/export/bundle')
        if (res.status === 201) {
          console.log(`Bundle written: ${res.data.outDir}`)
          console.log(`  files: ${res.data.manifest.files.length}`)
          if (res.data.manifest.lastAnchor) {
            console.log(`  last anchor: ${res.data.manifest.lastAnchor.status} @ event_count=${res.data.manifest.lastAnchor.eventCount}`)
          }
        } else { console.error(`Error ${res.status}:`, res.data); process.exit(1) }
      } else {
        console.error(`Unknown export subcommand: ${sub}. Use bundle`)
        process.exit(1)
      }
      break
    }

    case 'chain': {
      const sub = positional[0] || 'status'
      if (sub === 'status') {
        const res = await request('GET', '/api/chain')
        if (res.status === 200) {
          console.log(`Chain length: ${res.data.length} events`)
          const a = res.data.lastAnchor
          if (a) {
            const ok = a.calendarReceipts.filter((r) => r.ok).length
            console.log(`Last anchor:  ${a.status} (${ok}/${a.calendarReceipts.length} calendars) @ ${new Date(a.createdAt).toLocaleString()}`)
            console.log(`  head_hash:  ${a.headHash}`)
            console.log(`  event_count: ${a.eventCount}`)
          } else {
            console.log(`Last anchor:  (none yet)`)
          }
        } else { console.error(`Error ${res.status}:`, res.data); process.exit(1) }
      } else if (sub === 'anchor') {
        const res = await request('POST', '/api/anchors')
        if (res.status === 201 && res.data.anchor) {
          const a = res.data.anchor
          const ok = a.calendarReceipts.filter((r) => r.ok).length
          console.log(`Anchor ${a.status}: ${ok}/${a.calendarReceipts.length} calendars`)
          for (const r of a.calendarReceipts) {
            console.log(`  ${r.ok ? 'OK ' : 'FAIL'} ${r.calendar}${r.error ? ' — ' + r.error : ''}`)
          }
        } else { console.error(`Error ${res.status}:`, res.data); process.exit(1) }
      } else if (sub === 'verify') {
        const full = !!flags.full
        const res = await request('GET', `/api/anchors/verify${full ? '?full=1' : ''}`)
        if (res.status === 200) {
          if (full) {
            const d = res.data
            console.log(d.ok
              ? `OK — walked ${d.walked} events, hash chain intact`
              : `BROKEN at event ${d.brokenAtEventId}: ${d.brokenReason}`)
            if (d.currentHead) console.log(`  current head: ${d.currentHead}`)
            if (d.anchor) console.log(`  anchor match: ${d.anchorMatchesWalkedHead ? 'yes' : 'no'} (anchor covers ${d.anchor.eventCount})`)
            const anomalies = d.clockAnomalies || []
            if (anomalies.length > 0) {
              console.log(`  clock anomalies: ${anomalies.length}`)
              for (const a of anomalies.slice(0, 5)) {
                console.log(`    ${a.eventId} wall_delta=${a.wallDeltaMs}ms mono_delta=${a.monoDeltaMs}ms diff=${a.diffMs}ms host=${a.hostname}`)
              }
              if (anomalies.length > 5) console.log(`    ... and ${anomalies.length - 5} more`)
            } else {
              console.log(`  clock anomalies: 0`)
            }
            if (!d.ok) process.exit(2)
          } else if (!res.data.anchor) {
            // Never anchored — not a mismatch. Exiting 2 here made `chain
            // verify` a permanent red in CI until the first hourly anchor
            // landed, and told the operator to investigate a non-problem.
            console.log('NO ANCHOR YET — nothing to verify against')
            if (res.data.currentHead) console.log(`  current head:       ${res.data.currentHead}`)
            console.log('  run `redlog-cli chain anchor` to create the first one,')
            console.log('  or `redlog-cli chain verify --full` to re-walk the chain itself')
          } else {
            console.log(res.data.ok ? 'OK — latest anchor is a prefix of current chain' : 'MISMATCH — investigate')
            console.log(`  anchor event_count: ${res.data.anchor.eventCount}`)
            if (res.data.currentHead) console.log(`  current head:       ${res.data.currentHead}`)
            if (!res.data.ok) process.exit(2)
          }
        } else { console.error(`Error ${res.status}:`, res.data); process.exit(1) }
      } else if (sub === 'anchors') {
        const limit = flags.limit || 20
        const res = await request('GET', `/api/anchors?limit=${limit}`)
        if (res.status === 200) {
          for (const a of res.data.anchors) {
            const ok = a.calendarReceipts.filter((r) => r.ok).length
            console.log(`  [${new Date(a.createdAt).toISOString()}] ${a.status.padEnd(8)} ${ok}/${a.calendarReceipts.length}  events=${a.eventCount}  head=${a.headHash.slice(0, 16)}...`)
          }
        } else { console.error(`Error ${res.status}:`, res.data); process.exit(1) }
      } else if (sub === 'upgrade') {
        if (flags.all || positional[1] === '--all') {
          const res = await request('POST', '/api/anchors/upgrade-all')
          if (res.status === 200) {
            console.log(`Upgraded ${res.data.upgraded}/${res.data.scanned} pending anchors`)
          } else { console.error(`Error ${res.status}:`, res.data); process.exit(1) }
        } else {
          const id = positional[1]
          if (!id) { console.error('Usage: redlog-cli chain upgrade <anchor-id> | --all'); process.exit(1) }
          const res = await request('POST', `/api/anchors/${encodeURIComponent(id)}/upgrade`)
          if (res.status === 200 && res.data.anchor) {
            const a = res.data.anchor
            const up = a.calendarReceipts.filter((r) => r.upgraded).length
            console.log(`Anchor ${a.id}: ${up}/${a.calendarReceipts.length} calendars upgraded (status=${a.status})`)
            for (const r of a.calendarReceipts) {
              const tag = r.upgraded ? 'UP  ' : r.ok ? 'PEND' : 'FAIL'
              const size = r.upgradedBytes ?? (r.receiptB64 ? Buffer.from(r.receiptB64, 'base64').length : 0)
              console.log(`  ${tag} ${r.calendar} (${size} B)${r.error ? ' — ' + r.error : ''}`)
            }
          } else { console.error(`Error ${res.status}:`, res.data); process.exit(1) }
        }
      } else if (sub === 'export-ots') {
        const id = positional[1]
        if (!id) { console.error('Usage: redlog-cli chain export-ots <anchor-id> [--out file.ots] [--calendar url]'); process.exit(1) }
        const qs = flags.calendar ? `?calendar=${encodeURIComponent(flags.calendar)}` : ''
        const res = await requestRaw('GET', `/api/anchors/${encodeURIComponent(id)}/ots${qs}`)
        if (res.status !== 200) {
          try { console.error(`Error ${res.status}:`, JSON.parse(res.buffer.toString())) } catch { console.error(`Error ${res.status}`) }
          process.exit(1)
        }
        const outPath = flags.out || `redlog-anchor-${id}.ots`
        fs.writeFileSync(outPath, res.buffer)
        console.log(`Wrote ${res.buffer.length} bytes to ${outPath}`)
        console.log(`  head_hash: ${res.headers['x-redlog-head-hash'] || '?'}`)
        console.log(`  calendar:  ${res.headers['x-redlog-calendar'] || '?'}`)
        console.log(`  verify:    ots upgrade ${outPath} && ots verify ${outPath}`)
      } else {
        console.error(`Unknown chain subcommand: ${sub}. Use status|anchor|verify|anchors`)
        process.exit(1)
      }
      break
    }

    default:
      console.error(`Unknown command: ${command}. Run "redlog-cli help" for usage.`)
      process.exit(1)
  }
}

main().catch((err) => {
  console.error('Fatal:', err.message)
  process.exit(1)
})
