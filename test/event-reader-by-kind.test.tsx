// @vitest-environment jsdom
//
// Report 10 (2026-11-12) A.3 / A.4 #8 #9 / E.3: every kind a producer can write
// opens in a reader meant for it, or in the generic reader on purpose — never
// in a reader for another kind (non-HTTP `scanner` rows in the HTTP viewer) and
// never in nothing (a screenshot with no image). There is no kind registry yet
// (report 10 D.1 is later work), so the writable kinds are listed here, from
// report 10 A.1 checked against the writers. A new writable kind goes in this
// list; if it lands nowhere the test says so.

import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { I18nProvider } from '../src/renderer/src/i18n'
import { eventReader, hasContentReader, type EventReader } from '../src/renderer/src/lib/timelineEvents'
import { eventTitle } from '../src/renderer/src/lib/eventTitle'
import { toLane } from '../src/renderer/src/lib/timelineDomain'
import { GenericEventDetail, ScreenshotDetail } from '../src/renderer/src/components/TimelineEventDetails'

afterEach(() => { cleanup(); localStorage.clear() })

const ev = (agentType: string, data: Record<string, unknown>, targetId: string | null = null) =>
  ({ id: 'e1', timestamp: 1, agentType, targetId, data }) as unknown as RedLogEvent

// [agentType, subtype, reader]. `source` is given where the reader depends on it.
const WRITABLE: Array<[string, string, EventReader, Record<string, unknown>?]> = [
  ['shell', 'command_start', 'command'], ['shell', 'command_end', 'command'],
  ['shell', 'command_output', 'generic'], ['shell', 'command_boundary', 'generic'],
  ['shell', 'session_start', 'session', { source: 'builtin-terminal' }], ['shell', 'session_end', 'session', { source: 'builtin-terminal' }],
  ['shell', 'session_start', 'generic', { source: 'external-session' }], ['shell', 'session_output', 'generic'],
  ['shell', 'session_end', 'generic', { source: 'external-session' }],
  ['shell', 'capture_stopped', 'generic'], ['shell', 'capture_resumed', 'generic'], ['shell', 'wsl_test', 'generic'],
  ...(['user_message', 'assistant_message', 'thinking', 'tool_call', 'tool_result', 'tool_interrupted', 'compact_summary', 'away_summary']
    .map((s): [string, string, EventReader] => ['agent', s, 'agent-turn'])),
  ...(['model_refusal', 'api_error', 'transcript_capture_started', 'transcript_compacted', 'transcript_parent_missing',
    'transcript_schema_drift', 'transcript_snapshot', 'transcript_tool_gap', 'session_end']
    .map((s): [string, string, EventReader] => ['agent', s, 'generic'])),
  ...(['http_request_start', 'http_response', 'http_response_chunk', 'http_error', 'http_request_dropped', 'ws_message', 'websocket_end', 'tcp_message', 'tcp_end']
    .map((s): [string, string, EventReader] => ['scanner', s, 'http'])),
  ...(['cookie_change', 'capture_gap', 'connection', 'connection_end', 'packet_flow', 'pcap_segment', 'c2_checkin', 'c2_task', 'c2_pivot']
    .map((s): [string, string, EventReader] => ['scanner', s, 'generic'])),
  ['dns', 'dns_query', 'generic'], ['dns', 'dns_response', 'generic'],
  ...(['connection_attempt', 'port_scan', 'connection_established', 'connection_refused', 'udp_flow']
    .map((s): [string, string, EventReader] => ['pcap', s, 'generic'])),
  ['http_navigation', 'navigation', 'generic'], ['browser', 'console_error', 'console'], ['browser', 'exception', 'console'],
  ['screenshot', '', 'image'], ['marker', '', 'marker'], ['marker', 'amended', 'marker'],
  ['loot', 'credential_detected', 'generic'], ['pivot', 'tunnel_start', 'generic'], ['cleanup', 'log_clear', 'generic'],
  ['file_transfer', 'artifact_added', 'artifact'], ['file_transfer', 'upload', 'generic'], ['file_transfer', 'file_created', 'generic'],
  ['credential_use', 'ssh', 'generic'], ['clipboard', 'clipboard_changed', 'generic'],
  ['process', 'process_spawn', 'generic'], ['process', 'process_exit', 'generic'],
  ['system', 'sanitized', 'generic'], ['system', 'capture_gap', 'generic'], ['system', 'recording_paused', 'generic']
]

describe('every writable kind has a reader meant for it', () => {
  it.each(WRITABLE)('%s:%s → %s', (agentType, subtype, reader, extra) => {
    expect(eventReader({ agentType, data: { subtype, ...extra } } as never)).toBe(reader)
  })

  it('the generic reader shows labelled fields and names the kind, not a JSON dump', () => {
    for (const [agentType, subtype, reader] of WRITABLE) {
      if (reader !== 'generic') continue
      localStorage.setItem('redlog-locale', 'en')
      render(<I18nProvider><GenericEventDetail kind={`${agentType} · ${subtype}`} data={{ subtype, host: '10.0.0.5' }} /></I18nProvider>)
      const box = screen.getByTestId('generic-event-detail')
      expect(box.textContent).toContain(`${agentType} · ${subtype}`)
      expect(box.querySelector('pre')).toBeNull()
      expect(screen.getByText('10.0.0.5')).toBeTruthy()
      cleanup()
    }
  })

  it('a non-HTTP scanner row has no saved body, so no saved-content reader', () => {
    expect(hasContentReader({ agentType: 'scanner', data: { subtype: 'packet_flow', src: '10.0.0.1' } } as never)).toBe(false)
    expect(hasContentReader({ agentType: 'scanner', data: { subtype: 'http_response', status: 200 } } as never)).toBe(false)
  })
})

describe('a screenshot opened from the Timeline shows its image', () => {
  it('draws the stored file through the screenshot protocol', () => {
    localStorage.setItem('redlog-locale', 'en')
    render(<I18nProvider><ScreenshotDetail data={{ filePath: '/home/op/.redlog/shots/shot-1.png', sha256: 'a'.repeat(64), trigger: 'manual' }} /></I18nProvider>)
    const img = screen.getByTestId('screenshot-detail').querySelector('img')
    expect(img?.getAttribute('src')).toBe('redlog-screenshot://local/shot-1.png')
  })

  it('says the image is unavailable when the file cannot be read, or was never there', () => {
    localStorage.setItem('redlog-locale', 'en')
    render(<I18nProvider><ScreenshotDetail data={{ filePath: '/gone.png' }} /></I18nProvider>)
    fireEvent.error(screen.getByTestId('screenshot-detail').querySelector('img')!)
    expect(screen.getByTestId('screenshot-unreadable')).toBeTruthy()
    cleanup()
    render(<I18nProvider><ScreenshotDetail data={{ sha256: 'b'.repeat(64) }} /></I18nProvider>)
    expect(screen.getByTestId('screenshot-unreadable')).toBeTruthy()
  })
})

describe('titles say what the row is, from fields already on it', () => {
  // The fallbacks: `[subtype]`, `agent: subtype`, `System event: subtype`, `Shell event`.
  const RAW = [/^\[[a-z]+_[a-z_]+\]/, /^agent: /, /^System event: /, /^Shell event$/]
  it.each([
    [ev('scanner', { subtype: 'c2_checkin', framework: 'sliver', host: 'web01' }), 'web01'],
    [ev('scanner', { subtype: 'c2_task', host: 'web01', command: 'whoami' }), 'whoami'],
    [ev('scanner', { subtype: 'c2_pivot', state: 'open', via: '10.0.0.9' }), '10.0.0.9'],
    [ev('scanner', { subtype: 'c2_pivot', state: 'closed', via: '10.0.0.9' }), 'closed'],
    [ev('scanner', { subtype: 'packet_flow', proto: 'tcp', src: '10.0.0.1', src_port: 5555, dst: '10.0.0.5', dst_port: 22 }), '10.0.0.5:22'],
    [ev('scanner', { subtype: 'pcap_segment', pcap_file: '/cap/seg-001.pcap', bytes: 2048 }), 'seg-001.pcap'],
    [ev('shell', { subtype: 'capture_stopped', command: 'redlog stop', shell: 'zsh', pid: 4242 }), '4242'],
    [ev('shell', { subtype: 'capture_resumed', command: 'redlog start', terminalId: 't-7' }), 't-7'],
    [ev('shell', { subtype: 'command_boundary', reason: 'pane-closed', terminalId: 't-7' }), 'interrupted'],
    [ev('system', { subtype: 'capture_gap', agent: 'claude-code', skipped_units: 12 }), '12'],
    [ev('system', { subtype: 'sanitized', source_events: ['a', 'b'], fields: ['stdout'] }), '2'],
    [ev('system', { subtype: 'retention_pruned_logged', count: 340 }), '340'],
    [ev('system', { subtype: 'body_evicted', count: 7 }), '7'],
    [ev('agent', { subtype: 'model_refusal' }), 'refused'],
    [ev('agent', { subtype: 'api_error' }), 'error'],
    [ev('agent', { subtype: 'transcript_capture_started' }), 'capture']
  ])('%#', (event, expected) => {
    const title = eventTitle(event)
    for (const raw of RAW) expect(title).not.toMatch(raw)
    expect(title).toContain(expected)
  })

  it('the old c2_checkin type no longer prints braces around its host', () => {
    expect(eventTitle(ev('c2_checkin', { dest_ip: '10.0.0.5' }))).not.toContain('{')
  })
})

describe('rows sit in a lane named for what they are', () => {
  it('C2 rows go to the C2 lane, pcap rows to the network lane', () => {
    for (const s of ['c2_checkin', 'c2_task', 'c2_pivot']) expect(toLane('scanner', s)).toBe('c2_checkin')
    expect(toLane('pcap', 'port_scan')).toBe('scanner')
    expect(toLane('scanner', 'http_response')).toBe('scanner')
    expect(toLane('c2_checkin')).toBe('c2_checkin')
  })
})

describe('a kind RedLog no longer writes', () => {
  // The clipboard monitor was removed; a project may still hold its rows. They
  // land in the system lane, the generic reader and the generic title.
  const row = ev('clipboard', { subtype: 'copy', content_sha256: 'ab' })

  it('falls back instead of failing', () => {
    expect(toLane('clipboard')).toBe('system')
    expect(eventReader(row)).toBe('generic')
    expect(eventTitle(row)).toBe('clipboard: copy')
    render(<I18nProvider><GenericEventDetail kind="clipboard · copy" data={row.data as Record<string, unknown>} /></I18nProvider>)
    expect(screen.getByText(/clipboard · copy/)).toBeTruthy()
  })
})
