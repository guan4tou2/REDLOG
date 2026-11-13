// Spec 072 T003 — one example row for every kind a writer writes today.
//
// Not a fixture of the product: a fixture of the contract. T004 feeds these to
// today's tables and stores the answers, so each row has to be the shape the
// writer really sends (field names from the writer, not invented ones) and has
// to be byte-stable: no clock, no random id, no path of this machine.
//
//   - `ALL_KINDS` is the list T002 found; test/kinds/examples.test.ts fails if a
//     kind found by the scan has no row here, or a row here names a kind no
//     writer writes (unless it is one of LEGACY below, which no writer writes
//     but old projects still hold).
//   - `VARIANTS` are the extra rows the spec asks for beyond one per kind: each
//     relay `completeness × output_disposition`, the three built-in-terminal
//     `io` states, a `command_end` with no completeness field at all, the old
//     `shell:command`, an `agent:*` subtype nobody registered, and the plugin
//     kinds the c2 and pcap plugins write.
//
// A row is a RedLogEvent with every id and time derived from its position, so
// adding a row at the END never moves an existing one's id (golden files key on
// the example id, not on the number).
import type { RedLogEvent } from '../../src/core/db/event-types'

export interface Example {
  /** `<agent_type>[:<subtype>]` of the kind this row stands for. */
  kind: string
  /** Unique; golden files key on it. `<kind>` for the default row, `<kind>#<variant>` otherwise. */
  id: string
  /** What this row demonstrates, for a reader of a golden diff. */
  note: string
  row: RedLogEvent
}

/** Kinds old projects hold that no writer writes any more. */
export const LEGACY: readonly string[] = ['shell:command', 'terminal:session_start']

const T0 = 1_700_000_000_000
const SHA = 'a'.repeat(64)
const REF = { sha256: SHA, size: 4096, file: 'bodies/aa/aaaa', encoding: 'text' }

/** Default `data` per kind, beyond `{ subtype }`. Field names are the writers'. */
const DATA: Record<string, Record<string, unknown>> = {
  'shell:command_start': { command: 'nmap -sV 10.0.0.5', command_id: 'cmd-1', cwd: '/work', pid: 4242, shell: 'zsh' },
  'shell:command_end': { command: 'ls -al', command_id: 'cmd-2', cwd: '/work', pid: 4243, shell: 'zsh', exit_code: 0, duration_sec: 1, stdout: 'total 0\n', stderr: '', stdout_bytes: 8, stderr_bytes: 0, completeness: 'complete', output_disposition: 'captured', captured_by: 'relay' },
  'shell:command_output': { command_id: 'cmd-3', late: true, stdout: 'late line\n', sequence: 1 },
  'shell:session_start': { terminalId: 't-1', shell: 'zsh', cwd: '/work', source: 'builtin-terminal' },
  'shell:session_output': { terminalId: 't-1', sequence: 7, stdout: 'prompt$ ' },
  'shell:session_end': { terminalId: 't-1', exitCode: 0, durationMs: 60000, source: 'builtin-terminal' },
  'shell:command_boundary': { terminalId: 't-1', reason: 'pane-closed', command: 'sleep 100', command_id: 'cmd-4' },
  'shell:capture_stopped': { command: 'redlog stop', shell: 'zsh', pid: 4244 },
  'shell:capture_resumed': { command: 'redlog start', shell: 'zsh', pid: 4244 },
  'shell:wsl_test': { command: 'wsl-redlog-test.sh', shell: 'bash', pid: 99 },
  'agent:user_message': { agent: 'claude-code', session_id: 's-1', preview: 'run the scan' },
  'agent:assistant_message': { agent: 'claude-code', session_id: 's-1', preview: 'Running nmap.' },
  'agent:thinking': { agent: 'claude-code', session_id: 's-1', full_length: 120 },
  'agent:tool_call': { agent: 'claude-code', session_id: 's-1', tool_name: 'Bash', tool_use_id: 'tu-1', tool_input: { command: 'ls' } },
  'agent:tool_result': { agent: 'claude-code', session_id: 's-1', tool_use_id: 'tu-1', tool_name: 'Bash', output_preview: 'ok' },
  'agent:tool_interrupted': { agent: 'claude-code', session_id: 's-1', tool_use_id: 'tu-2' },
  'agent:compact_summary': { agent: 'claude-code', session_id: 's-1', preview: 'summary' },
  'agent:away_summary': { agent: 'claude-code', session_id: 's-1', preview: 'while you were away' },
  'agent:model_refusal': { agent: 'claude-code', session_id: 's-1', system_subtype: 'model_refusal_fallback' },
  'agent:api_error': { agent: 'claude-code', session_id: 's-1', system_subtype: 'api_error' },
  'agent:session_end': { agent: 'claude-code', session_id: 's-1', reason: 'idle' },
  'agent:transcript_capture_started': { agent: 'claude-code', session_id: 's-1', skipped_source_bytes: 0 },
  'agent:transcript_compacted': { agent: 'claude-code', session_id: 's-1' },
  'agent:transcript_parent_missing': { agent: 'claude-code', session_id: 's-1' },
  'agent:transcript_schema_drift': { agent: 'claude-code', session_id: 's-1' },
  'agent:transcript_snapshot': { agent: 'claude-code', session_id: 's-1', transcript_ref: REF },
  'agent:transcript_tool_gap': { agent: 'claude-code', session_id: 's-1' },
  'scanner:http_request_start': { flow_id: 'f-1', method: 'GET', url: 'https://t.test/', host: 't.test', port: 443 },
  'scanner:http_response': { flow_id: 'f-1', status: 200, url: 'https://t.test/', host: 't.test', response_body_ref: REF, content_length: 4096 },
  'scanner:http_response_chunk': { flow_id: 'f-1', sequence: 1 },
  'scanner:http_error': { flow_id: 'f-2', url: 'https://t.test/x', host: 't.test', error: 'timeout' },
  'scanner:http_request_dropped': { flow_id: 'f-3', url: 'https://t.test/y', host: 't.test', reason: 'queue-full' },
  'scanner:ws_message': { flow_id: 'f-4', host: 't.test', direction: 'out' },
  'scanner:websocket_end': { flow_id: 'f-4', host: 't.test' },
  'scanner:tcp_message': { flow_id: 'f-5', host: '10.0.0.5', port: 22 },
  'scanner:tcp_end': { flow_id: 'f-5', host: '10.0.0.5', port: 22, streamed: true },
  'scanner:cookie_change': { host: 't.test', name: 'sid' },
  'scanner:capture_gap': { source: 'mitmproxy', reason: 'spool', gap_started_at: T0, gap_ended_at: T0 + 5000, lost_events: 3 },
  'scanner:connection': { proto: 'tcp', local_port: 51000, remote_addr: '10.0.0.5', remote_port: 22, pid: 4242 },
  'scanner:connection_end': { proto: 'tcp', local_port: 51000, remote_addr: '10.0.0.5', remote_port: 22 },
  'scanner:packet_flow': { src: '10.0.0.9', dst: '10.0.0.5', dst_port: 445, proto: 'tcp', packets: 1, syn_only: true },
  'scanner:pcap_segment': { sha256: SHA, path: 'capture-01.pcap', bytes: 1048576 },
  'scanner:c2_checkin': { framework: 'sliver', host: '10.0.0.5', implant: 'implant-1' },
  'scanner:c2_task': { framework: 'sliver', host: '10.0.0.5', task: 'ls' },
  'scanner:c2_pivot': { framework: 'sliver', host: '10.0.0.5', state: 'open' },
  'dns:dns_query': { query_name: 't.test', query_type: 'A' },
  'dns:dns_response': { query_name: 't.test', query_type: 'A', answers: [{ type: 'A', data: '10.0.0.5' }], response_code: 'NOERROR' },
  'pcap:connection_attempt': { dst_port: 22, proto: 'tcp', at: T0 },
  'pcap:port_scan': { dst_port: 0, proto: 'tcp', ports: 100 },
  'pcap:connection_established': { dst_port: 22, proto: 'tcp', at: T0 },
  'pcap:connection_refused': { dst_port: 23, proto: 'tcp', at: T0 },
  'pcap:udp_flow': { dst_port: 53, proto: 'udp', at: T0 },
  'http_navigation:navigation': { url: 'https://t.test/', host: 't.test', title: 'Home', tab_id: 'tab-1' },
  'browser:console_log': { level: 'log', url: 'https://t.test/', host: 't.test', tab_id: 'tab-1', message: 'hello' },
  'browser:console_info': { level: 'info', url: 'https://t.test/', host: 't.test', tab_id: 'tab-1', message: 'info' },
  'browser:console_warn': { level: 'warning', url: 'https://t.test/', host: 't.test', tab_id: 'tab-1', message: 'warn' },
  'browser:console_error': { level: 'error', url: 'https://t.test/', host: 't.test', tab_id: 'tab-1', message: 'err' },
  'browser:console_debug': { level: 'debug', url: 'https://t.test/', host: 't.test', tab_id: 'tab-1', message: 'dbg' },
  'browser:console_trace': { level: 'trace', url: 'https://t.test/', host: 't.test', tab_id: 'tab-1', message: 'trace' },
  'browser:exception': { level: 'error', url: 'https://t.test/', host: 't.test', tab_id: 'tab-1', message: 'boom', exception_class: 'TypeError' },
  'browser:log_entry': { level: 'info', log_source: 'network', url: 'https://t.test/', host: 't.test', tab_id: 'tab-1' },
  'process:process_spawn': { pid: 5000, ppid: 4242, command: 'sh -c id' },
  'process:process_exit': { pid: 5000, command: 'sh -c id', duration_sec: 1 },
  'file_transfer:artifact_added': { stored: 'artifacts/aa/aaaa', filename: 'loot.txt', sha256: SHA, size: 12 },
  'file_transfer:file_created': { source: 'file-watcher', path: '/work/new.txt', isDir: false },
  'file_transfer:file_modified': { source: 'file-watcher', path: '/work/new.txt', isDir: false },
  'file_transfer:file_deleted': { source: 'file-watcher', path: '/work/new.txt', isDir: false },
  'file_transfer:upload': { tool: 'curl', url: 'https://t.test/up', localPath: '/work/a', command: 'curl -T a https://t.test/up', mitre_ttp: 'T1041' },
  'file_transfer:download': { tool: 'wget', url: 'https://t.test/a', localPath: '/work/a', command: 'wget https://t.test/a', mitre_ttp: 'T1105' },
  'loot:credential_detected': { kind: 'password', masked: 'pa****', source: 'cmd' },
  'cleanup:log_clear': { tool: 'journalctl', command: 'journalctl --vacuum-time=1s', mitre_ttp: 'T1070.002' },
  'cleanup:history_clear': { tool: 'shell', command: 'history -c', mitre_ttp: 'T1070.003' },
  'cleanup:file_shred': { tool: 'shred', command: 'shred -u a', target: 'a', mitre_ttp: 'T1070.004' },
  'cleanup:timestomp': { tool: 'touch', command: 'touch -r a b', target: 'b', mitre_ttp: 'T1070.006' },
  'cleanup:attr_hide': { tool: 'chattr', command: 'chattr +i a', target: 'a', mitre_ttp: 'T1564.001' },
  'pivot:tunnel_start': { tool: 'chisel', command: 'chisel server --reverse', via: '10.0.0.9' },
  'pivot:agent_connect': { tool: 'ligolo-ng', command: 'agent -connect 10.0.0.9:11601', via: '10.0.0.9' },
  'pivot:socks_up': { tool: 'ssh', command: 'ssh -D 1080 h', via: 'h', socks_port: 1080 },
  'pivot:port_forward': { tool: 'ssh', command: 'ssh -L 8080:t:80 h', via: 'h', forward: '8080:t:80' },
  'pivot:route_add': { tool: 'sshuttle', command: 'sshuttle -r h 10.0.0.0/24', via: 'h', route: '10.0.0.0/24' },
  'pivot:proxied': { tool: 'proxychains', command: 'proxychains nmap t', via: 't' },
  'pivot:interactive': { tool: 'ssh', command: 'ssh h', via: 'h' },
  'pivot:closed': { tool: 'ssh', command: 'ssh -D 1080 h', via: 'h', exit_code: 0, duration_sec: 60 },
  'credential_use:basic_auth': { url: 'https://t.test/', host: 't.test', mitre_ttp: 'T1078' },
  'credential_use:bearer_token': { url: 'https://t.test/', host: 't.test', mitre_ttp: 'T1078' },
  'credential_use:ntlm': { url: 'https://t.test/', host: 't.test', mitre_ttp: 'T1078' },
  'credential_use:negotiate': { url: 'https://t.test/', host: 't.test', mitre_ttp: 'T1078' },
  'credential_use:digest': { url: 'https://t.test/', host: 't.test', mitre_ttp: 'T1078' },
  'credential_use:session_cookie': { url: 'https://t.test/', host: 't.test', mitre_ttp: 'T1078' },
  'credential_use:api_key': { url: 'https://t.test/', host: 't.test', mitre_ttp: 'T1078' },
  'credential_use:form_login': { url: 'https://t.test/login', host: 't.test', mitre_ttp: 'T1078' },
  // `<masked>` rather than a shortened value: the title golden renders this as
  // "password_flag: …", and a secret scanner reads a value after that label as
  // a password. The field holds an already-masked string in production too.
  'credential_use:password_flag': { masked: '<masked>', host: 't.test', mitre_ttp: 'T1078' },
  'credential_use:url_userinfo': { masked: 'us****', host: 't.test', mitre_ttp: 'T1078' },
  'credential_use:auth_header': { masked: 'ey****', host: 't.test', scheme: 'Bearer', mitre_ttp: 'T1078' },
  'marker': { title: 'Found admin panel', notes: 'n', severity: 'important', category: 'finding' },
  'marker:amended': { markerId: 'm-1', changes: { severity: 'critical' } },
  'screenshot': { trigger: 'manual', filePath: 'screenshots/s.jpg', filename: 's.jpg', size: 100, width: 800, height: 600, sha256: SHA },
  'system:session_start': {},
  'system:browser_launched': { browser: 'chromium' },
  'system:recording_paused': { description: 'Recording paused', source: 'ui' },
  'system:recording_resumed': { description: 'Recording resumed', source: 'ui' },
  'system:config_changed': { changed: ['retention'], description: 'config changed' },
  'system:ip_verdict': { ip_verdict_kind: 'safe', authority: 'fact', severity: 'info' },
  'system:scope_violation': { target: '10.9.9.9', action: 'nmap 10.9.9.9', source: 'shell', distance: 'out_of_scope', authority: 'fact', severity: 'critical' },
  'system:scope_recomputed': { in_scope: 3, flagged: 1 },
  'system:scope_cleared': { cleared: 1 },
  'system:capture_gap': { source: 'managed-http-proxy', reason: 'gap-unsaved', gap_reason: 'queue-full', units: 3 },
  'system:http_proxy_started': { source: 'managed-http-proxy', state: 'running', proxy: 'http://127.0.0.1:8080', pid: 100, error: null },
  'system:http_proxy_stopped': { source: 'managed-http-proxy', state: 'stopped', proxy: null, pid: null, error: null },
  'system:http_proxy_failed': { source: 'managed-http-proxy', state: 'failed', proxy: null, pid: null, error: 'EADDRINUSE' },
  'system:http_proxy_orphan_reclaimed': { pid: 99 },
  'system:opsec_airgap': { enabled: true, description: 'Air-gap ON' },
  'system:opsec_state_changed': { state: 'on' },
  'system:active_target_changed': { target: '10.0.0.5' },
  'system:sanitized': { removed: 2 },
  'system:update_pending': { version: '9.9.9' },
  'system:update_completed': { version: '9.9.9' },
  'system:update_not_applied': { version: '9.9.9' },
  'system:retention_pruned_logged': { count: 5, oldest_pruned_at: T0, newest_pruned_at: T0 + 1000 },
  'system:bookmarks_pruned': { count: 2, keep_days: 30 },
  'system:body_evicted': { count: 1, bytes: 4096 },
  'system:cast_evicted': { path: 'casts/a.cast', bytes: 100 },
  'system:screenshot_evicted': { path: 'screenshots/a.jpg', bytes: 100 },
  'system:cast_pruned': { path: 'casts/a.cast', bytes: 100, ageDays: 40 },
  'system:screenshot_pruned': { path: 'screenshots/a.jpg', bytes: 100, ageDays: 40 },
  'system:agent_transcript_pruned': { path: 'agent-transcripts/a.jsonl', bytes: 100, ageDays: 40 },
  'system:http_body_pruned': { path: 'bodies/aa/aaaa', bytes: 100, ageDays: 40 },
  'system:screenshot_deleted': { filename: 's.jpg' },
  'system:logged_tier_digest': { count: 100, digest: SHA },
  'system:anchor_failed': { reason: 'offline' },
  'system:chain_sample_broken': { at: 'e-1' },
  'system:export_sealed': { manifestSha256: SHA },
  'system:producer_heartbeat': { producer: 'pcap-capture' },
  'system:process_monitor_saturated': { dropped: 10 },
  'system:process_monitor_ps_unavailable': {},
  'system:connection_capture_started': {},
  'system:connection_monitor_saturated': { dropped: 10 }
}

/** The rows that carry no subtype at all. */
const NO_SUBTYPE = new Set(['marker', 'screenshot'])

let n = 0
function row(agentType: string, data: Record<string, unknown>): RedLogEvent {
  n += 1
  return {
    id: `ex-${String(n).padStart(4, '0')}`,
    timestamp: T0 + n * 1000,
    engagementId: 'eng-1',
    sessionId: 'sess-1',
    operatorId: 'op-1',
    agentType,
    hostname: 'host',
    sourceIP: null,
    targetId: null,
    data,
    createdAt: T0 + n * 1000,
    tier: 'chained'
  }
}

/** `variant` rows state every field themselves: the default row's fields are not merged in. */
function make(kind: string, id: string, note: string, extra?: Record<string, unknown>, variant = false, verbatim = false): Example {
  const [agentType, subtype] = kind.split(':')
  const withSubtype = NO_SUBTYPE.has(kind) || subtype === undefined ? {} : { subtype }
  const data = verbatim ? { ...(extra ?? {}) }
    : variant ? { ...withSubtype, ...(extra ?? {}) }
      : { ...withSubtype, ...(DATA[kind] ?? {}) }
  return { kind, id, note, row: row(agentType, data) }
}

/** Every kind T002 finds, one default row each. Order is by kind id (stable). */
export const ALL_KINDS: readonly string[] = Object.keys(DATA).sort()

const BASE_END = { command: 'nmap -oN scan.txt 10.0.0.5', command_id: 'cmd-9', shell: 'zsh', exit_code: 0, duration_sec: 3, captured_by: 'relay' }

/** Beyond one per kind. Appended; never reorder. */
const VARIANT_SPECS: Array<[kind: string, variant: string, note: string, data: Record<string, unknown>, replace?: boolean]> = [
  // relay completeness × output_disposition, as redlog-relay.py:556-592,975-1013 and shell-common.sh:974,1011 write them
  ['shell:command_end', 'relay-complete', 'relay: complete / captured', { ...BASE_END, stdout: 'Nmap done\n', stderr: '', stdout_bytes: 10, stderr_bytes: 0, stdout_truncated: false, stderr_truncated: false, completeness: 'complete', output_disposition: 'captured', limit_hit: null }],
  ['shell:command_end', 'relay-complete-empty', 'relay: complete / captured, nothing printed', { ...BASE_END, command: 'true', stdout: '', stderr: '', stdout_bytes: 0, stderr_bytes: 0, stdout_truncated: false, stderr_truncated: false, completeness: 'complete', output_disposition: 'captured', limit_hit: null }],
  ['shell:command_end', 'relay-truncated', 'relay: truncated / captured, 64 KiB of 900000 bytes', { ...BASE_END, command: 'cat big.log', stdout: 'x'.repeat(64), stderr: '', stdout_bytes: 900000, stderr_bytes: 0, stdout_truncated: true, stderr_truncated: false, completeness: 'truncated', output_disposition: 'captured', limit_hit: 'stdout:65536' }],
  ['shell:command_end', 'relay-drain-timeout', 'relay: truncated / captured because the drain timed out', { ...BASE_END, stdout: '', stderr: '', stdout_bytes: 0, stderr_bytes: 0, completeness: 'truncated', output_disposition: 'captured', limit_hit: 'drain-timeout' }],
  ['shell:command_end', 'relay-partial-background', 'relay: partial / captured, a background job still prints', { ...BASE_END, command: 'ping -c 100 t &', stdout: 'PING t\n', stderr: '', stdout_bytes: 7, stderr_bytes: 0, completeness: 'partial', output_disposition: 'captured', late_output: true, limit_hit: null }],
  ['shell:command_end', 'relay-partial-streamed', 'relay: partial, output_streamed (output rides as command_output rows)', { ...BASE_END, command: 'tail -f log', stdout_bytes: 500, stderr_bytes: 0, completeness: 'partial', output_disposition: 'captured', output_streamed: true, limit_hit: null }],
  ['shell:command_end', 'relay-redirected', 'relay: metadata-only / redirected (nmap -oN)', { ...BASE_END, stdout: '', stderr: '', stdout_bytes: 0, stderr_bytes: 0, completeness: 'metadata-only', output_disposition: 'redirected', limit_hit: null }],
  ['shell:command_end', 'relay-not-captured', 'relay: metadata-only / not-captured (relay held no output)', { ...BASE_END, command: 'vim notes', stdout: '', stderr: '', stdout_bytes: 0, stderr_bytes: 0, completeness: 'metadata-only', output_disposition: 'not-captured', limit_hit: null }],
  ['shell:command_end', 'redlog-run-builtin', 'redlog-run built-in: metadata-only / not-captured, no stdout field', { exit_code: 0, duration_sec: 0, cwd: '/work', captured_by: 'redlog-run', command: 'cd /tmp', command_id: 'cmd-10', completeness: 'metadata-only', output_disposition: 'not-captured' }],
  ['shell:command_end', 'legacy-no-fields', 'a command_end from before completeness existed: no completeness, no disposition, no captured_by', { command: 'ls -al', exit_code: 0, duration_sec: 1, shell: 'bash', pid: 77 }],
  ['shell:command_end', 'powershell-transcript', 'Windows pack: output as one preview field', { command: 'Get-Process', exit_code: 0, source: 'start-transcript', output_preview: 'Handles NPM(K)', shell: 'powershell' }],
  // the built-in terminal records into a cast; `io` points at the span
  ['shell:command_end', 'builtin-io-bytes', 'built-in terminal: bracketed span with bytes', { command: 'ls', exit_code: 0, source: 'builtin-terminal', terminalId: 't-1', io: { off: 0, len: 42 } }],
  ['shell:command_end', 'builtin-io-empty', 'built-in terminal: bracketed span of length 0', { command: 'true', exit_code: 0, source: 'builtin-terminal', terminalId: 't-1', io: { off: 42, len: 0 } }],
  ['shell:command_end', 'builtin-io-unbracketed', 'built-in terminal: span could not be bracketed', { command: 'sleep 1', exit_code: 0, source: 'builtin-terminal', terminalId: 't-1', io: { off: 42, len: 9, unbracketed: true } }],
  ['shell:command_end', 'tlogger-prompt', 'the POSIX adapter prompt function (housekeeping)', { command: '_tlogger_prompt_command', exit_code: 0, shell: 'bash' }],
  ['shell:command_end', 'powershell-profile', 'reloading the PowerShell profile (housekeeping in SQL, evidence in JS)', { command: '. $PROFILE # Microsoft.PowerShell_profile.ps1', exit_code: 0, shell: 'powershell' }],
  ['shell:command_end', 'hook-source', 'the shell hook script itself (housekeeping)', { command: 'source ~/.redlog/shell-zsh-hook.zsh', exit_code: 0, shell: 'zsh' }],
  ['shell:command_start', 'tlogger-prompt', 'the POSIX adapter prompt function (housekeeping)', { command: 'tlogger_prompt_command', command_id: 'cmd-11', shell: 'bash' }],
  ['shell:command_start', 'powershell-profile', 'reloading the PowerShell profile', { command: '. $PROFILE # Microsoft.PowerShell_profile.ps1', command_id: 'cmd-12', shell: 'powershell' }],
  ['shell:command_output', 'streamed', 'a streamed chunk of a command that has ended', { command_id: 'cmd-9', streamed: true, stdout: 'chunk', sequence: 2 }],
  ['shell:command_output', 'foreground', 'an in-flight chunk (not late, not streamed)', { command_id: 'cmd-13', stdout: 'chunk', sequence: 1, late: false }],
  ['shell:session_start', 'external', 'an external (pty-mode) session start', { terminalId: 'ext-1', source: 'external-session', shell: 'bash' }],
  ['shell:session_end', 'incomplete', 'external session ended with omitted bytes', { terminalId: 'ext-1', source: 'external-session', exitCode: 0, omittedBytes: 10, pausedBytes: 0, incomplete: true }],
  ['shell:session_end', 'recovered', 'an orphaned session recovered at next open', { terminalId: 't-2', recovered: true }],
  ['scanner:capture_gap', 'inflight', 'scanner gap from inflight-marker', { source: 'mitmproxy', reason: 'inflight-at-exit', gap_started_at: T0, gap_ended_at: T0 + 100 }],
  ['system:scope_violation', 'in-scope-tally', 'an adherence tally stored under the violation subtype', { target: '10.0.0.5', distance: 'in_scope', authority: 'fact', severity: 'info' }],
  ['system:session_start', 'api', 'an api_started-era session row', { source: 'api' }],
  ['system:api_started', 'legacy', 'api_started: no writer; housekeeping still names it', { port: 8081 }],
  // a subtype nobody registered, as the adapter's open branch (`return t.systemSubtype ?? 'system'`) can write
  ['agent:future_subtype', 'unknown-subtype', 'an agent:* subtype no registry names', { agent: 'claude-code', session_id: 's-1' }],
  ['agent:system', 'open-branch', 'the adapter falls back to the subtype "system"', { agent: 'claude-code', session_id: 's-1' }],
  ['shell:command', 'legacy', 'the pre-two-event shell:command row', { command: 'id', exit_code: 0 }],
  ['terminal:session_start', 'legacy', 'a terminal agent_type row the CLI help text names', { terminalId: 'cli-1' }],
  ['external:note', 'external-family', 'an external:* row through the legacy ingest door', { text: 'x' }],
  ['terminal:command', 'cli-help-text', 'redlog-cli log terminal --data {"subtype":"command"}', { command: 'nmap -sV target.com' }],
  // plugin kinds
  ['scanner:packet_flow', 'syn-only', 'pcap plugin: a half-open probe', { src: '10.0.0.9', dst: '10.0.0.5', dst_port: 22, proto: 'tcp', packets: 1, syn_only: true, byte_count: 60 }],
  ['scanner:c2_checkin', 'generic', 'c2-tailers: generic framework', { framework: 'generic', host: '10.0.0.5' }],
  ['scanner:c2_pivot', 'closed', 'c2-tailers: pivot closed', { framework: 'sliver', host: '10.0.0.5', state: 'closed' }],
  ['c2_checkin:beacon', 'agent-type-with-no-writer', 'the agent_type the c2 lane and title were written for; no writer produces it', { subtype: 'beacon', host: '10.0.0.5' }, true],
  ['plugin-kind:probe', 'plugin-declared', 'a kind only a plugin manifest could declare', { subtype: 'probe' }, true]
]

export const EXAMPLES: readonly Example[] = [
  ...ALL_KINDS.map((k) => make(k, k, `default row for ${k}`)),
  ...VARIANT_SPECS.map(([kind, variant, note, data, replace]) => {
    return make(kind, `${kind}#${variant}`, note, data, true, replace ?? false)
  })
]

export function exampleById(id: string): Example {
  const found = EXAMPLES.find((e) => e.id === id)
  if (!found) throw new Error(`no example ${id}`)
  return found
}
