import { createHash } from 'node:crypto'
import { operationPairKey, sourceSessionKey } from './operation-pair-key'
import type { RedLogEvent } from './db/event-types'
import type { ActivityAction, ActivityKind, ToolAction } from './activity-contract'

type Source = Pick<RedLogEvent, 'id' | 'engagementId' | 'sessionId' | 'agentType' | 'data'>
const SHELL = new Set(['command_start', 'command_end', 'command_output', 'command'])
const TOOLS = new Set(['tool_call', 'tool_result', 'tool_interrupted'])
const HTTP = new Set(['http_request_start', 'http_response', 'http_response_chunk', 'http_error', 'websocket_message', 'ws_message', 'websocket_start', 'websocket_end'])
const MESSAGES = new Set(['user_message', 'assistant_message', 'thinking', 'compact_summary', 'away_summary'])

/** Derived identity only. Payload text, target, time, query, page and pairing state
 * never participate. Missing producer identity remains Event-addressable. */
export function activityKey(event: Source): string {
  const d = event.data, sub = String(d.subtype ?? '')
  let kind: ActivityKind = 'event'
  let tuple: unknown[] = ['act1', kind, event.engagementId, event.id]
  const pair = operationPairKey(event)
  if (pair && ((event.agentType === 'shell' && SHELL.has(sub)) || (event.agentType === 'agent' && TOOLS.has(sub)))) {
    kind = event.agentType === 'shell' ? 'command' : 'tool'
    tuple = ['act1', kind, pair]
  } else if (event.agentType === 'scanner' && HTTP.has(sub) && event.engagementId && event.sessionId && typeof d.flow_id === 'string' && d.flow_id) {
    kind = 'http'
    tuple = ['act1', kind, event.engagementId, event.sessionId, event.agentType, typeof d.source === 'string' ? d.source : '', d.flow_id]
  } else if (event.agentType === 'agent' && MESSAGES.has(sub) && typeof d.transcript_uuid === 'string' && d.transcript_uuid) {
    const session = sourceSessionKey(event)
    if (session) { kind = 'message'; tuple = ['act1', kind, session, d.transcript_uuid] }
  }
  return JSON.stringify(tuple)
}

export function activityId(key: string): string {
  return 'act1:' + createHash('sha256').update(key, 'utf8').digest('hex')
}

const TOOL_ACTIONS: Record<string, Record<string, ToolAction>> = {
  'claude-code': {
    Bash: 'execute', Read: 'file-read', Write: 'file-write', Edit: 'file-write', MultiEdit: 'file-write',
    Grep: 'search', Glob: 'search', WebFetch: 'browse', WebSearch: 'browse'
  },
  codex: {
    shell: 'execute', shell_command: 'execute', exec_command: 'execute', 'functions.exec_command': 'execute',
    write_stdin: 'execute', 'functions.write_stdin': 'execute',
    apply_patch: 'file-write', 'functions.apply_patch': 'file-write',
    view_image: 'file-read', 'functions.view_image': 'file-read', 'web.run': 'browse'
  }
}

/** Exact provider schema names only: a custom tool named "ReadBashSecret"
 * must never be inferred to have executed a shell or saved a file. */
export function activityClassification(event: Pick<RedLogEvent, 'agentType' | 'data'>): {
  action: ActivityAction; toolAction: ToolAction; provider: string | null; sourceSession: string | null
} {
  const d = event.data
  const provider = event.agentType === 'agent' && typeof d.agent === 'string' ? d.agent : null
  const sourceSession = typeof (provider ? d.session_id : d.terminalId) === 'string' ? String(provider ? d.session_id : d.terminalId) : null
  const toolAction = provider && TOOLS.has(String(d.subtype)) && typeof d.tool_name === 'string'
    ? TOOL_ACTIONS[provider]?.[d.tool_name] ?? 'unknown' : 'unknown'
  const action: ActivityAction = event.agentType === 'agent' ? toolAction === 'execute' ? 'command' : 'conversation'
    : event.agentType === 'shell' ? 'command'
      : ['scanner', 'dns', 'browser', 'pcap', 'connection'].includes(event.agentType) ? 'network'
        : ['screenshot', 'marker', 'loot', 'artifact'].includes(event.agentType) ? 'evidence'
          : ['alert', 'scope_violation'].includes(event.agentType) ? 'security'
            : ['system', 'process', 'file', 'clipboard', 'cleanup'].includes(event.agentType) ? 'system' : 'other'
  return { action, toolAction, provider, sourceSession }
}
