// One-line event title for the lane label, event list, first-run strip,
// and search index. Pulled out of Timeline.tsx so FirstRunView and the
// search index can import it directly without pulling in 4000 lines of
// component code.

import en from '../i18n/en.json'
import { AMENDABLE_FIELDS } from './markerFold'
import { firstStringArg } from './timelineDomain'
import { formatBytes } from '../components/HttpDetail'

/** Exported for the first-run strip, which is a preview of this timeline and
 *  must name rows the same way it does. */
export type Translate = (key: string, vars?: Record<string, string | number>) => string

// English fallback for the `eventTitle.*` keys when no translator is passed.
// The strings are the en.json entries; keeping the lookup here rather than a
// second copy means a caller without `t` (search indexing, tests) still gets
// the same English the interface shows in the en locale.
const enTitles = en as Record<string, string>
export const englishTitle: Translate = (key, vars) => {
  const tpl = enTitles[key] ?? key
  return vars ? tpl.replace(/\{\{(\w+)\}\}/g, (_, k) => String(vars[k] ?? `{{${k}}}`)) : tpl
}

/**
 * One line per event, for the lane label, the event list and the first-run
 * strip. Commands, URLs, hostnames and hashes are shown as captured; the
 * static words around them — "terminal opened", "Screenshot", "Recording
 * paused" — go through `t` so a Chinese interface does not read half in
 * English. Pass no `t` to get English regardless of locale, which is what
 * the search index does so a query matches the same text in every locale.
 */
export function eventTitle(event: RedLogEvent, t: Translate = englishTitle): string {
  const d = event.data
  switch (event.agentType) {
    case 'shell':
      if (d.subtype === 'command_start') return `$ ${(d.command as string).slice(0, 100)}`
      if (d.subtype === 'command_end') return `$ ${(d.command as string).slice(0, 80)} → exit ${d.exit_code}`
      if (d.subtype === 'command' && d.command) return `$ ${(d.command as string).slice(0, 100)}`
      if (d.subtype === 'session_start') return t('eventTitle.terminalOpened')
      if (d.subtype === 'session_end') {
        return d.exitCode != null ? t('eventTitle.terminalClosedExit', { code: String(d.exitCode) }) : t('eventTitle.terminalClosed')
      }
      return t('eventTitle.shellEvent')
    case 'dns': {
      const qName = (d.query_name as string) || (d.dest_host as string) || (d.command as string) || ''
      const qType = (d.query_type as string) || ''
      if (d.subtype === 'dns_response') {
        const answers = (d.answers as Array<{ type?: string; data?: string }> | undefined) ?? []
        const preview = answers.length > 0
          ? ` → ${answers.slice(0, 2).map((a) => a.data ?? '').filter(Boolean).join(', ')}`
          : ''
        const dur = d.duration_ms != null ? ` (${d.duration_ms}ms)` : ''
        const rcode = d.response_code ? ` [${d.response_code}]` : ''
        return `DNS ⇐ ${qName} ${qType}${rcode}${preview}${dur}`.trim()
      }
      return `DNS ⇒ ${qName} ${qType}`.trim()
    }
    case 'browser': {
      const level = String(d.level ?? 'log')
      const host = (d.host as string) || (d.url as string) || ''
      const msg = String(d.message ?? '').slice(0, 80).replace(/\s+/g, ' ')
      const glyph = level === 'error' || level === 'warning' || level === 'warn' || d.subtype === 'exception' ? '⚠' : '▸'
      if (d.subtype === 'exception') return `⚠ [exception] ${host}: ${(d.exception_class as string) || 'Error'} — ${msg}`.trim()
      return `${glyph} [${level}] ${host}: ${msg}`.trim()
    }
    case 'process': {
      const cmd = String(d.command ?? '').slice(0, 60)
      if (d.subtype === 'process_exit') {
        const dur = d.duration_sec != null ? ` (${d.duration_sec}s)` : ''
        return `▪ ${cmd}${dur}`.trim()
      }
      return `▶ ${cmd}`.trim()
    }
    case 'http_navigation':
      return `⇢ ${d.host || d.url || ''} ${d.title ? `— ${(d.title as string).slice(0, 60)}` : ''}`.trim()
    case 'scanner': {
      const method = (d.method as string) || ''
      const url = (d.url as string) || (d.host as string) || ''
      switch (d.subtype) {
        case 'http_request_start':
          return `[req] ${method} ${url}`.trim()
        case 'http_response':
          return `[${d.duration_ms ?? '?'} ms] ${method} ${url} → ${d.status ?? '?'}`.trim()
        case 'http_request_dropped': {
          const age = d.age_sec != null ? `${d.age_sec}s` : '?'
          return `[${t('eventTitle.droppedAfter', { age })}] ${method} ${url}`.trim()
        }
        case 'http_error':
          return `[err] ${method} ${url}: ${d.error || 'unknown'}`.trim()
        case 'ws_message': {
          const dir = d.direction === 'client' ? '▲' : '▼'
          const msgType = d.message_type === 'binary' ? 'bin' : 'txt'
          return `[WS ${dir}] ${url} (${formatBytes(d.size as number ?? 0)} ${msgType})`.trim()
        }
        case 'tcp_message': {
          const tcpDir = d.direction === 'client' ? '▲' : '▼'
          return `[TCP ${tcpDir}] ${d.host || ''}:${d.port || '?'} (${formatBytes(d.size as number ?? 0)})`.trim()
        }
        case 'cookie_change':
          return t('eventTitle.cookieRotated', { domain: String(d.domain || '?'), name: String(d.cookie_name || '?') }).trim()
        case 'connection': {
          const proto = (d.proto as string || 'tcp').toUpperCase()
          return `⇄ ${proto} ${d.remote_addr || '?'}:${d.remote_port ?? '?'}`.trim()
        }
        case 'connection_end': {
          const proto = (d.proto as string || 'tcp').toUpperCase()
          const dur = d.duration_sec != null ? ` (${d.duration_sec}s)` : ''
          return `⇄ ${proto} ${d.remote_addr || '?'}:${d.remote_port ?? '?'} ${t('eventTitle.connectionClosed')}${dur}`.trim()
        }
        default:
          return `[${d.subtype || 'req'}] ${method} ${url}`.trim()
      }
    }
    case 'screenshot':
      return t('eventTitle.screenshot', { trigger: String(d.trigger ?? '') })
    case 'clipboard':
      return t('eventTitle.clipboard', { preview: (d.content as string)?.slice(0, 60) || '' })
    case 'file_transfer': {
      const label = d.subtype || d.direction || 'transfer'
      const target = d.path || d.filename || d.localPath || d.remotePath || ''
      const size = d.size != null ? ` (${d.size}B)` : d.bytes ? ` (${d.bytes}B)` : ''
      return `${label}: ${target}${size}`.trim()
    }
    case 'credential_use': {
      const who = d.user_context || d.scheme || ''
      const where = d.dest_host || d.dest_ip || d.host || ''
      const detail = d.masked ? `${d.masked}${where ? ` → ${where}` : ''}` : `${who || '?'}${where ? ` @ ${where}` : ''}`
      return `🔑 ${d.subtype || 'cred'}: ${detail}`.trim()
    }
    case 'c2_checkin':
      return t('eventTitle.c2Beacon', { host: String(d.dest_ip || d.dest_host || ''), bytes: d.bytes ? `(${d.bytes}B)` : '' }).trim()
    case 'pivot':
      return t('eventTitle.pivot', { tool: String(d.tool ?? ''), rest: `${d.subtype || ''}${d.via ? ` → ${d.via}` : ''}${d.route ? ` (${d.route})` : ''}` }).trim()
    case 'cleanup':
      return t('eventTitle.cleanup', { tool: String(d.tool ?? ''), rest: `${d.subtype || ''}${d.target ? ` → ${d.target}` : ''}` }).trim()
    case 'marker': {
      if (d.subtype === 'amended') {
        return AMENDABLE_FIELDS.map((f) => d[f]).filter((v) => typeof v === 'string' && v).join(' · ')
      }
      return `${(d.severity as string || 'info').toUpperCase()}: ${d.title}`
    }
    case 'loot': {
      const m = (d.matches as Array<{ type: string; confidence: string }>)?.[0]
      return m
        ? t('eventTitle.lootMatch', { type: m.type.replace(/_/g, ' '), confidence: m.confidence })
        : t('eventTitle.lootCount', { count: Number(d.count ?? 0) })
    }
    case 'agent': {
      const sub = String(d.subtype ?? '')
      const raw = String(
        d.preview ?? d.full ?? d.output ?? d.textContent ?? ''
      ).replace(/\s+/g, ' ').trim()
      const cap = 100
      const body = raw.length > cap ? raw.slice(0, cap) + '…' : raw
      if (sub === 'user_message') return body ? `${t('eventTitle.agentUser')}: ${body}` : t('eventTitle.agentUser')
      if (sub === 'assistant_message') return body ? `${t('eventTitle.agentAssistant')}: ${body}` : t('eventTitle.agentAssistant')
      if (sub === 'tool_call') {
        const name = String(d.tool_name ?? 'tool')
        const input = d.tool_input as Record<string, unknown> | undefined
        const hint = input ? firstStringArg(input, 60) : ''
        return hint ? `⚙ ${name}: ${hint}` : `⚙ ${name}`
      }
      if (sub === 'tool_result') return body ? `${t('eventTitle.agentResult')}: ${body}` : t('eventTitle.agentResult')
      if (sub === 'thinking') return body ? `💭 ${body}` : t('eventTitle.agentThinking')
      if (sub === 'compact_summary') return t('eventTitle.agentCompacted')
      if (sub === 'tool_interrupted') return body ? `${t('eventTitle.agentInterrupted')}: ${body}` : t('eventTitle.agentInterrupted')
      if (sub === 'away_summary') return body ? `${t('eventTitle.agentAway')}: ${body}` : t('eventTitle.agentAway')
      if (sub === 'transcript_snapshot') return t('eventTitle.agentSnapshot', { turns: String(d.turns_emitted ?? '?') })
      if (sub === 'session_end') return t('eventTitle.agentSessionEnd', { turns: String(d.turns_emitted ?? '?') })
      if (sub === 'transcript_compacted') return t('eventTitle.agentTranscriptReset')
      if (sub === 'transcript_schema_drift') return t('eventTitle.agentSchemaDrift', { type: String(d.unknown_type ?? '?') })
      if (sub === 'transcript_parent_missing') return t('eventTitle.agentParentMissing')
      if (sub === 'transcript_tool_gap') return t('eventTitle.agentToolGap', { seen: String(d.tool_calls_seen ?? '?'), emitted: Number(d.tool_calls_emitted ?? 0) })
      return `agent: ${sub}`
    }
    case 'system':
      if (d.subtype === 'scope_violation') return t('eventTitle.scopeViolation', { target: String(d.target || d.command || '') })
      if (d.subtype === 'ip_transition') return `⇋ ${d.description || t('eventTitle.ipTransition')}`
      if (d.subtype === 'opsec_state_changed') return t('eventTitle.opsecChanged', { description: String(d.description || t('eventTitle.opsecChangedDefault')) })
      if (d.subtype === 'recording_paused') return t('eventTitle.recordingPaused')
      if (d.subtype === 'recording_resumed') return t('eventTitle.recordingResumed')
      if (d.subtype === 'config_changed') return `⚙ ${d.description || t('eventTitle.configChanged')}`
      if (d.subtype === 'scope_recomputed') return `⟲ ${d.description || ''}`.trim()
      if (d.subtype === 'scope_cleared') return `✓ ${d.description || ''}`.trim()
      if (d.subtype === 'browser_launched') {
        return t('eventTitle.browserLaunched', { proxy: d.proxy ? t('eventTitle.browserProxy', { proxy: String(d.proxy) }) : t('eventTitle.browserNoProxy') })
      }
      if (d.subtype === 'secret_revealed') return t('eventTitle.secretRevealed', { fields: (d.fields as string[])?.join(', ') || t('eventTitle.secretRevealedUnknown') })
      if (d.subtype === 'connection_capture_started') return t('eventTitle.connectionCaptureOn')
      if (d.subtype === 'connection_monitor_saturated') return t('eventTitle.connectionSaturated', { count: String(d.count ?? '?') })
      return `${event.agentType}: ${d.subtype || ''}`
    default:
      return `${event.agentType}: ${d.subtype || ''}`
  }
}
