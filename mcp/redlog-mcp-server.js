#!/usr/bin/env node
/**
 * RedLog MCP Server — Model Context Protocol server for AI agent integration.
 *
 * Connects to a running RedLog instance via its HTTP API (auto-discovers
 * token and port from ~/.redlog/).  Exposes RedLog functionality as MCP tools
 * that Claude Code, Cursor, Codex, and other MCP-compatible AI agents can call.
 *
 * Setup — add to your Claude Code MCP config:
 *   claude mcp add redlog -- node /path/to/redlog/mcp/redlog-mcp-server.js
 *
 * Or in .claude/settings.json:
 *   { "mcpServers": { "redlog": { "command": "node", "args": ["/path/to/redlog/mcp/redlog-mcp-server.js"] } } }
 */

const fs = require('fs')
const path = require('path')
const http = require('http')
const os = require('os')
const readline = require('readline')

const TOKEN_PATH = path.join(os.homedir(), '.redlog', 'api-token')
const PORT_PATH = path.join(os.homedir(), '.redlog', 'api-port')

function readToken() {
  try { return fs.readFileSync(TOKEN_PATH, 'utf-8').trim() } catch { return null }
}
function readPort() {
  try { return parseInt(fs.readFileSync(PORT_PATH, 'utf-8').trim()) } catch { return 6660 }
}

function apiRequest(method, apiPath, body) {
  return new Promise((resolve, reject) => {
    const token = readToken()
    if (!token) { reject(new Error('RedLog not running — no api-token found')); return }
    const port = readPort()
    const postData = body ? JSON.stringify(body) : null

    const opts = {
      hostname: '127.0.0.1', port, path: apiPath, method,
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
        ...(postData ? { 'Content-Length': Buffer.byteLength(postData) } : {})
      }
    }

    const req = http.request(opts, (res) => {
      const chunks = []
      res.on('data', c => chunks.push(c))
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString()
        try { resolve(JSON.parse(raw)) } catch { resolve(raw) }
      })
    })
    req.on('error', reject)
    if (postData) req.write(postData)
    req.end()
  })
}

// --- MCP Tool Definitions ---
const TOOLS = [
  {
    name: 'redlog_status',
    description: 'Get RedLog status: IP/VPN state, event count, scope violations, recording state.',
    inputSchema: { type: 'object', properties: {}, required: [] }
  },
  {
    name: 'redlog_mark',
    description: 'Create a timestamped marker in the RedLog timeline. Use for key moments: found a vuln, started new phase, noted something interesting.',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'What happened (e.g. "Found SQLi in /api/users")' },
        notes: { type: 'string', description: 'Additional context or details' },
        severity: { type: 'string', enum: ['info', 'low', 'medium', 'high', 'critical'], description: 'Severity level' },
        target: { type: 'string', description: 'Target host/IP this relates to' }
      },
      required: ['title']
    }
  },
  {
    name: 'redlog_log_event',
    description: 'Log a raw event to the RedLog timeline with custom agent_type and data. Prefer standard agent_type values (shell, agent, scanner, dns, credential_use, c2_checkin, file_transfer, marker, loot, system). Prefer standard data keys where they apply: subtype, command, output_preview, tool, dest_ip, dest_host, dest_port, src_ip, user_context, mitre_ttp, description, comments, sha256, bytes. See docs/event-schema.md.',
    inputSchema: {
      type: 'object',
      properties: {
        agent_type: { type: 'string', description: 'Event source type. Prefer: shell / agent / scanner / dns / credential_use / c2_checkin / file_transfer / marker / loot' },
        data: {
          type: 'object',
          description: 'Event payload. Populate standard keys when applicable (subtype, tool, dest_ip, dest_host, dest_port, user_context, mitre_ttp, description, sha256, bytes).',
          additionalProperties: true
        },
        target: { type: 'string', description: 'Target host/IP (also written to target_id column for filter/scope match)' }
      },
      required: ['agent_type', 'data']
    }
  },
  {
    name: 'redlog_search',
    description: 'Search across all RedLog events (commands, targets, clipboard, loot) by keyword.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query (min 2 chars)' },
        limit: { type: 'number', description: 'Max results (default 20)' }
      },
      required: ['query']
    }
  },
  {
    name: 'redlog_events',
    description: 'Query recent timeline events, optionally filtered by type or target.',
    inputSchema: {
      type: 'object',
      properties: {
        agent_type: { type: 'string', description: 'Filter by type: shell, screenshot, clipboard, marker, loot, system' },
        target: { type: 'string', description: 'Filter by target host/IP' },
        limit: { type: 'number', description: 'Max results (default 50)' }
      },
      required: []
    }
  },
  {
    name: 'redlog_scope',
    description: 'Get the current scope configuration: in-scope targets, exclusions, and violations.',
    inputSchema: { type: 'object', properties: {}, required: [] }
  },
  {
    name: 'redlog_config',
    description: 'Get the current RedLog project configuration (engagement, operator, network, scope settings).',
    inputSchema: { type: 'object', properties: {}, required: [] }
  },
  {
    name: 'redlog_quickmark',
    description: 'Create a QuickMark bookmark for the current finding or interesting URL.',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Bookmark title' },
        url: { type: 'string', description: 'URL to bookmark' },
        note: { type: 'string', description: 'Notes about this bookmark' }
      },
      required: ['title']
    }
  },
  {
    name: 'redlog_quickmarks_list',
    description: 'List all QuickMark bookmarks in the current project.',
    inputSchema: { type: 'object', properties: {}, required: [] }
  },
  {
    name: 'redlog_loot_scan',
    description: 'Scan text for credentials, secrets, API keys, JWTs, password hashes, and other loot.',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'Text to scan for secrets/credentials' }
      },
      required: ['text']
    }
  },
  {
    name: 'redlog_screenshot',
    description: 'Capture a screenshot of the current desktop.',
    inputSchema: { type: 'object', properties: {}, required: [] }
  },
  {
    name: 'redlog_recording',
    description: 'Control recording state: check, pause, resume, or toggle.',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['status', 'pause', 'resume', 'toggle'], description: 'Action to perform' }
      },
      required: ['action']
    }
  },
  {
    name: 'redlog_whoami',
    description: 'Return the operator identity that this token resolves to. Every event logged in this session is attributed to this operator.',
    inputSchema: { type: 'object', properties: {}, required: [] }
  },
  {
    name: 'redlog_operators_list',
    description: 'List every operator token registered on this RedLog instance (primary + secondary).',
    inputSchema: { type: 'object', properties: {}, required: [] }
  },
  {
    name: 'redlog_chain_status',
    description: 'Return the evidence-chain length and the latest OpenTimestamps anchor status.',
    inputSchema: { type: 'object', properties: {}, required: [] }
  },
  {
    name: 'redlog_chain_anchor_now',
    description: 'Submit the current chain head to all OpenTimestamps calendars right now. Use before wrapping up a session or after a critical finding to fix its timestamp.',
    inputSchema: { type: 'object', properties: {}, required: [] }
  },
  {
    name: 'redlog_chain_verify',
    description: 'Quick integrity check: confirm the latest anchor still describes a prefix of the current chain (event count only — no cryptographic rewalk).',
    inputSchema: { type: 'object', properties: {}, required: [] }
  },
  {
    name: 'redlog_chain_upgrade',
    description: 'Fetch upgraded OpenTimestamps proofs from calendars for pending anchors — call after a few hours have passed since anchoring, so the calendar can have folded the digest into a Bitcoin-anchored Merkle tree. Without id, upgrades every pending anchor.',
    inputSchema: {
      type: 'object',
      properties: {
        anchor_id: { type: 'string', description: 'Specific anchor id to upgrade. Omit to upgrade all pending anchors.' }
      },
      required: []
    }
  }
]

// --- MCP Tool Handlers ---
async function handleTool(name, args) {
  switch (name) {
    case 'redlog_status':
      return await apiRequest('GET', '/api/status')

    case 'redlog_mark':
      return await apiRequest('POST', '/api/marker', {
        title: args.title,
        notes: args.notes || '',
        severity: args.severity || 'info',
        target_id: args.target
      })

    case 'redlog_log_event':
      return await apiRequest('POST', '/api/events', {
        agent_type: args.agent_type,
        data: args.data,
        target_id: args.target
      })

    case 'redlog_search':
      return await apiRequest('GET', `/api/events/search?q=${encodeURIComponent(args.query)}&limit=${args.limit || 20}`)

    case 'redlog_events': {
      const params = new URLSearchParams()
      if (args.agent_type) params.set('agent_type', args.agent_type)
      if (args.target) params.set('target_id', args.target)
      params.set('limit', String(args.limit || 50))
      return await apiRequest('GET', `/api/events?${params}`)
    }

    case 'redlog_scope':
      return await apiRequest('GET', '/api/scope')

    case 'redlog_config':
      return await apiRequest('GET', '/api/config')

    case 'redlog_quickmark':
      return await apiRequest('POST', '/api/quickmarks', {
        title: args.title,
        url: args.url,
        note: args.note || ''
      })

    case 'redlog_quickmarks_list':
      return await apiRequest('GET', '/api/quickmarks')

    case 'redlog_loot_scan':
      return await apiRequest('POST', '/api/loot/scan', { text: args.text })

    case 'redlog_screenshot':
      return await apiRequest('POST', '/api/screenshot')

    case 'redlog_recording': {
      if (args.action === 'status') return await apiRequest('GET', '/api/recording')
      return await apiRequest('POST', '/api/recording', { action: args.action })
    }

    case 'redlog_whoami':
      return await apiRequest('GET', '/api/whoami')

    case 'redlog_operators_list':
      return await apiRequest('GET', '/api/operators')

    case 'redlog_chain_status':
      return await apiRequest('GET', '/api/chain')

    case 'redlog_chain_anchor_now':
      return await apiRequest('POST', '/api/anchors')

    case 'redlog_chain_verify':
      return await apiRequest('GET', '/api/anchors/verify')

    case 'redlog_chain_upgrade':
      return args.anchor_id
        ? await apiRequest('POST', `/api/anchors/${encodeURIComponent(args.anchor_id)}/upgrade`)
        : await apiRequest('POST', '/api/anchors/upgrade-all')

    default:
      throw new Error(`Unknown tool: ${name}`)
  }
}

// --- MCP stdio transport ---
const rl = readline.createInterface({ input: process.stdin, terminal: false })
let buffer = ''

function sendMessage(msg) {
  const json = JSON.stringify(msg)
  process.stdout.write(`Content-Length: ${Buffer.byteLength(json)}\r\n\r\n${json}`)
}

function handleMessage(msg) {
  if (msg.method === 'initialize') {
    sendMessage({
      jsonrpc: '2.0', id: msg.id,
      result: {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'redlog', version: '0.1.0' }
      }
    })
  } else if (msg.method === 'notifications/initialized') {
    // no-op
  } else if (msg.method === 'tools/list') {
    sendMessage({
      jsonrpc: '2.0', id: msg.id,
      result: { tools: TOOLS }
    })
  } else if (msg.method === 'tools/call') {
    const { name, arguments: args } = msg.params
    handleTool(name, args || {}).then(result => {
      sendMessage({
        jsonrpc: '2.0', id: msg.id,
        result: {
          content: [{ type: 'text', text: typeof result === 'string' ? result : JSON.stringify(result, null, 2) }]
        }
      })
    }).catch(err => {
      sendMessage({
        jsonrpc: '2.0', id: msg.id,
        result: {
          content: [{ type: 'text', text: `Error: ${err.message}` }],
          isError: true
        }
      })
    })
  } else if (msg.id !== undefined) {
    sendMessage({
      jsonrpc: '2.0', id: msg.id,
      error: { code: -32601, message: `Method not found: ${msg.method}` }
    })
  }
}

process.stdin.on('data', (chunk) => {
  buffer += chunk.toString()
  while (true) {
    const headerEnd = buffer.indexOf('\r\n\r\n')
    if (headerEnd === -1) break
    const header = buffer.slice(0, headerEnd)
    const match = header.match(/Content-Length:\s*(\d+)/i)
    if (!match) { buffer = buffer.slice(headerEnd + 4); continue }
    const len = parseInt(match[1])
    const bodyStart = headerEnd + 4
    if (buffer.length < bodyStart + len) break
    const body = buffer.slice(bodyStart, bodyStart + len)
    buffer = buffer.slice(bodyStart + len)
    try { handleMessage(JSON.parse(body)) } catch (e) { process.stderr.write(`Parse error: ${e.message}\n`) }
  }
})

process.stderr.write('RedLog MCP server started — waiting for connections\n')
