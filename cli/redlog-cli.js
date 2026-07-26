#!/usr/bin/env node
// RedLog CLI — talk to the RedLog HTTP API from any shell or agent
// Usage: redlog-cli <command> [options]

const fs = require('fs')
const path = require('path')
const http = require('http')
const os = require('os')

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
RedLog CLI v0.1.0

Usage:
  redlog-cli log <agent_type> [--target <id>] [--data '{"key":"val"}']
  redlog-cli mark <title> [--severity info|low|medium|high|critical] [--notes "..."] [--target <id>]
  redlog-cli search <query> [--limit N]
  redlog-cli events [--agent_type <type>] [--limit N] [--target <id>]
  redlog-cli loot <text>
  redlog-cli screenshot
  redlog-cli status
  redlog-cli health
  redlog-cli token

Environment:
  REDLOG_TOKEN   Override the auto-detected API token
  REDLOG_PORT    Override the auto-detected API port

Examples:
  redlog-cli log terminal --data '{"subtype":"command","command":"nmap -sV target.com"}'
  redlog-cli mark "Found SQLi in /api/users" --severity high --target api.example.com
  redlog-cli search "password"
  redlog-cli loot "root:x:0:0:root:/root:/bin/bash"
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

    case 'status': {
      const res = await request('GET', '/api/status')
      if (res.status === 200) {
        const d = res.data
        const ip = d.ip
        console.log(`RedLog Status:`)
        console.log(`  Events:     ${d.eventCount}`)
        console.log(`  Scope:      ${d.scopeViolations > 0 ? `${d.scopeViolations} violations` : 'OK'}`)
        if (ip) {
          console.log(`  VPN:        ${ip.vpnStatus}`)
          console.log(`  External IP: ${ip.externalIP || 'unknown'}`)
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

    default:
      console.error(`Unknown command: ${command}. Run "redlog-cli help" for usage.`)
      process.exit(1)
  }
}

main().catch((err) => {
  console.error('Fatal:', err.message)
  process.exit(1)
})
