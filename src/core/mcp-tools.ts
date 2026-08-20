// MCP tool definitions + a transport-agnostic JSON-RPC handler.
//
// These are the SAME 19 tools the standalone stdio server (mcp/redlog-mcp-server.js)
// exposes, but served directly from the app's own HTTP server so MCP is live the
// moment RedLog is open — no subprocess to spawn, no node-on-PATH or asar-unpack
// problems in a packaged build. Keep this list in sync with the stdio server.

export interface McpTool {
  name: string
  description: string
  inputSchema: Record<string, unknown>
}

const noArgs = { type: 'object', properties: {}, required: [] as string[] }

export const MCP_TOOLS: McpTool[] = [
  { name: 'redlog_status', description: 'Get RedLog status: IP state, event count, scope violations.', inputSchema: noArgs },
  {
    name: 'redlog_mark',
    description: 'Create a timestamped marker in the RedLog timeline. Use for key moments: found a vuln, started a new phase, noted something worth recording.',
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
    description: 'Log a raw event with custom agent_type and data — only for actions no hook captured (GUI clicks, manual observations). Do NOT use for shell commands the hooks already log. Prefer standard agent_type (shell, agent, scanner, dns, credential_use, c2_checkin, file_transfer, pivot) and standard data keys (subtype, tool, dest_ip, dest_host, dest_port, user_context, mitre_ttp, description, sha256, bytes; for pivot: via, route, socks_port, forward). See docs/event-schema.md.',
    inputSchema: {
      type: 'object',
      properties: {
        agent_type: { type: 'string', description: 'Event source type. Prefer: agent / scanner / dns / credential_use / c2_checkin / file_transfer' },
        data: { type: 'object', description: 'Event payload. Populate standard keys when applicable.', additionalProperties: true },
        target: { type: 'string', description: 'Target host/IP (also written to target_id for filter/scope match)' }
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
        agent_type: { type: 'string', description: 'Filter by type: shell, dns, screenshot, marker, loot, system, …' },
        target: { type: 'string', description: 'Filter by target host/IP' },
        limit: { type: 'number', description: 'Max results (default 50)' }
      },
      required: []
    }
  },
  { name: 'redlog_scope', description: 'Get the current scope configuration: in-scope targets, exclusions, and violations.', inputSchema: noArgs },
  { name: 'redlog_config', description: 'Get the current RedLog project configuration (engagement, operator, network, scope).', inputSchema: noArgs },
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
  { name: 'redlog_quickmarks_list', description: 'List all QuickMark bookmarks in the current project.', inputSchema: noArgs },
  {
    name: 'redlog_loot_scan',
    description: 'Scan text for credentials, secrets, API keys, JWTs, password hashes, and other loot.',
    inputSchema: {
      type: 'object',
      properties: { text: { type: 'string', description: 'Text to scan for secrets/credentials' } },
      required: ['text']
    }
  },
  { name: 'redlog_screenshot', description: 'Capture a screenshot of the current desktop.', inputSchema: noArgs },
  {
    name: 'redlog_recording',
    description: 'Control recording state: check, pause, resume, or toggle.',
    inputSchema: {
      type: 'object',
      properties: { action: { type: 'string', enum: ['status', 'pause', 'resume', 'toggle'], description: 'Action to perform' } },
      required: ['action']
    }
  },
  { name: 'redlog_whoami', description: 'Return the operator identity this token resolves to. Every event is attributed to this operator.', inputSchema: noArgs },
  { name: 'redlog_operators_list', description: 'List every operator token registered on this RedLog instance.', inputSchema: noArgs },
  { name: 'redlog_chain_status', description: 'Return the evidence-chain length and the latest OpenTimestamps anchor status.', inputSchema: noArgs },
  { name: 'redlog_chain_anchor_now', description: 'Submit the current chain head to OpenTimestamps calendars now. Use before ending a session or after a critical finding.', inputSchema: noArgs },
  { name: 'redlog_chain_verify', description: 'Quick integrity check: confirm the latest anchor still describes a prefix of the current chain.', inputSchema: noArgs },
  {
    name: 'redlog_chain_upgrade',
    description: 'Fetch upgraded OpenTimestamps proofs for pending anchors (wait a few hours after anchoring). Omit anchor_id to upgrade all pending.',
    inputSchema: {
      type: 'object',
      properties: { anchor_id: { type: 'string', description: 'Specific anchor id. Omit to upgrade all pending.' } },
      required: []
    }
  },
  {
    name: 'redlog_session_register',
    description: 'Register the current Claude Code session for capture and auto-add its working directory to the watchPaths whitelist. Call at session start so RedLog records this session\'s transcript. The cwd parameter adds the directory to ~/.redlog/hook-config.json watchPaths so the tailer\'s directory gate passes — essential when watchPaths is non-empty. Without registration, all sessions are captured (backward compatible); once any session registers, only registered ones are recorded.',
    inputSchema: {
      type: 'object',
      properties: {
        session_id: { type: 'string', description: 'Claude Code session ID' },
        cwd: { type: 'string', description: 'Working directory of the session. When provided, auto-added to the watchPaths whitelist so the tailer captures this session.' }
      },
      required: ['session_id']
    }
  }
]

export interface JsonRpcMessage {
  jsonrpc?: string
  id?: string | number | null
  method?: string
  params?: Record<string, unknown>
}

export type ToolDispatch = (name: string, args: Record<string, unknown>) => Promise<unknown>

export const MCP_PROTOCOL_VERSION = '2024-11-05'

/**
 * Handle one JSON-RPC message. Returns the response object, or null for
 * notifications (which get a 202 with no body). Transport-agnostic: the caller
 * supplies the version and a dispatch that actually runs the tool.
 */
export async function handleMcpMessage(
  msg: JsonRpcMessage,
  opts: { version: string; dispatch: ToolDispatch; extraTools?: McpTool[] }
): Promise<Record<string, unknown> | null> {
  const id = msg.id ?? null

  switch (msg.method) {
    case 'initialize':
      return {
        jsonrpc: '2.0', id,
        result: {
          protocolVersion: MCP_PROTOCOL_VERSION,
          capabilities: { tools: {} },
          serverInfo: { name: 'redlog', version: opts.version }
        }
      }

    case 'notifications/initialized':
    case 'notifications/cancelled':
      return null

    case 'tools/list':
      return { jsonrpc: '2.0', id, result: { tools: [...MCP_TOOLS, ...(opts.extraTools ?? [])] } }

    case 'tools/call': {
      const name = (msg.params?.name as string) ?? ''
      const args = (msg.params?.arguments as Record<string, unknown>) ?? {}
      try {
        const result = await opts.dispatch(name, args)
        return {
          jsonrpc: '2.0', id,
          result: { content: [{ type: 'text', text: typeof result === 'string' ? result : JSON.stringify(result, null, 2) }] }
        }
      } catch (e) {
        return {
          jsonrpc: '2.0', id,
          result: { content: [{ type: 'text', text: `Error: ${(e as Error).message}` }], isError: true }
        }
      }
    }

    case 'ping':
      return { jsonrpc: '2.0', id, result: {} }

    default:
      if (msg.id === undefined || msg.id === null) return null
      return { jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${msg.method}` } }
  }
}
