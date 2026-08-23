// @vitest-environment jsdom
//
// Smoke coverage for every renderer view. This exists because the Timeline
// shipped in v0.2.0 crashed on open — laneEvents was seeded from a hand-written
// object literal that had drifted from the LANES list, so laneEvents['dns'] was
// undefined and .map() threw. Nothing in the suite touched a component, so it
// reached a release. Each view here is rendered against a mocked bridge with at
// least one event of every agent_type, which is exactly the shape that broke.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, cleanup, screen } from '@testing-library/react'
import { I18nProvider } from '../src/renderer/src/i18n'

import App from '../src/renderer/src/App'
import OverlayApp from '../src/renderer/src/OverlayApp'
import TimelinePanel from '../src/renderer/src/components/Timeline'
import Settings from '../src/renderer/src/components/Settings'
import ProjectPicker from '../src/renderer/src/components/ProjectPicker'
import Sidebar from '../src/renderer/src/components/Sidebar'
import StatusBar from '../src/renderer/src/components/StatusBar'
import IPStatusCard from '../src/renderer/src/components/IPStatusCard'
import { TargetView } from '../src/renderer/src/components/TargetView'
import { ScopeStatus } from '../src/renderer/src/components/ScopeStatus'
import { LootPanel } from '../src/renderer/src/components/LootPanel'
import { QuickMarksView } from '../src/renderer/src/components/FindingsView'

const AGENT_TYPES = [
  'shell', 'dns', 'screenshot', 'clipboard', 'file_transfer',
  'credential_use', 'c2_checkin', 'marker', 'loot', 'system',
  'agent', 'scanner'
]

let seq = 0
function makeEvent(agentType: string): Record<string, unknown> {
  seq += 1
  return {
    id: `evt-${seq}`,
    timestamp: 1_700_000_000_000 + seq * 1000,
    engagementId: 'eng',
    sessionId: 'sess',
    operatorId: 'op-1',
    agentType,
    hostname: 'host',
    sourceIP: null,
    targetId: 'example.com',
    data: {
      subtype: `${agentType}_sub`,
      command: 'nmap -sV example.com',
      detectedTarget: 'example.com',
      exit_code: 0,
      trigger: 'manual',
      title: 'A finding',
      severity: 'high',
      type: 'aws_key',
      confidence: 'high',
      dest_host: 'example.com',
      user_context: 'root',
      bytes: 42,
      filename: 'loot.txt',
      content: 'clipboard text'
    },
    hash: 'a'.repeat(64),
    prevHash: null,
    createdAt: 1_700_000_000_000 + seq * 1000,
    monotonicNs: String(seq * 1_000_000),
    ntpOffsetMs: 3
  }
}

const EVENTS = AGENT_TYPES.map(makeEvent)

const unsub = (): void => {}

function installBridge(): void {
  ;(window as unknown as { redlog: unknown }).redlog = {
    platform: 'darwin',
    project: {
      list: async () => [{ id: 'p1', name: 'Proj', createdAt: 1, lastOpened: 2, path: '/tmp/p1' }],
      create: async () => ({ id: 'p1', name: 'Proj', createdAt: 1, lastOpened: 2, path: '/tmp/p1' }),
      open: async () => ({ id: 'p1', name: 'Proj', createdAt: 1, lastOpened: 2, path: '/tmp/p1' }),
      delete: async () => true,
      active: async () => ({ id: 'p1', name: 'Proj' })
    },
    ip: {
      getStatus: async () => ({
        externalIP: '203.0.113.7', internalIP: '10.0.0.2',
        ipSafety: 'safe', lastCheck: Date.now(), error: null
      }),
      onStatus: () => unsub
    },
    config: {
      get: async () => ({
        engagement: { id: 'eng', name: 'Engagement' },
        operator: { id: 'op-1', name: 'Operator' },
        network: { safeIPs: [], exposedIPs: [], checkInterval: 10 },
        scope: { warnOnViolation: true, targets: [], excludeTargets: [], scopeFile: '' },
        screenshot: { quality: 85 },
        terminal: { maxCastBytes: 1024 },
        redaction: { allowlist: [], denylist: [], entropyThreshold: 4.5, minLength: 20 },
        deconfliction: { enabled: false, url: '', secret: '', events: [], subtypes: [], includeData: false }
      }),
      save: async () => true,
      exportProfile: async () => null,
      importProfile: async () => null
    },
    events: {
      query: async () => EVENTS,
      getCount: async () => EVENTS.length,
      search: async () => EVENTS,
      onNew: () => unsub
    },
    marker: { create: async () => EVENTS[0], onShortcut: () => unsub },
    screenshot: { capture: async () => '/tmp/x.jpg', read: async () => null },
    scope: {
      getViolations: async () => [{ target: 'evil.com', command: 'curl evil.com', timestamp: Date.now() }],
      getViolationCount: async () => 1,
      isConfigured: async () => true
    },
    chain: {
      length: async () => EVENTS.length,
      anchors: async () => [],
      anchorNow: async () => null,
      verify: async () => ({ ok: true, anchor: null, currentHead: null }),
      upgrade: async () => ({ upgraded: 0, scanned: 0 })
    },
    loot: { getCount: async () => 2 },
    quickmarks: {
      list: async () => [{ id: 'q1', title: 'Mark', url: 'https://example.com', note: '', context: {}, createdAt: Date.now() }],
      get: async () => null,
      create: async () => ({ id: 'q1', title: 'Mark', url: null, note: '', context: {}, createdAt: Date.now() }),
      update: async () => null,
      delete: async () => true
    },
    cdp: { getTab: async () => ({ url: null, title: null, connected: false }), setPort: async () => true },
    browser: {
      detect: async () => '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      status: async () => ({ running: false }),
      launch: async () => ({ ok: true, pid: 1 }),
      stop: async () => ({ stopped: true })
    },
    data: { exportJson: async () => '/tmp/x.json', exportScopeFiltered: async () => '/tmp/y.json', exportBundle: async () => null },
    hooks: { detect: async () => [], install: async () => ({ success: true, message: '' }), uninstall: async () => ({ success: true, message: '' }) },
    operators: {
      list: async () => [{ id: 'op-1', name: 'Operator', isPrimary: true, createdAt: 1, revokedAt: null }],
      create: async () => null,
      rotate: async () => null,
      rename: async () => true,
      revoke: async () => true,
      delete: async () => true
    },
    deconfliction: {
      get: async () => ({ enabled: false, url: '', secret: '', events: [], subtypes: [], includeData: false }),
      test: async () => ({ ok: true, status: 200 })
    },
    mcp: {
      info: async () => ({ port: 6660, endpoint: 'http://127.0.0.1:6660/mcp', stdioPath: '/x/mcp/redlog-mcp-server.js', hasToken: false }),
      setupToken: async () => ({ token: 't'.repeat(64), port: 6660, endpoint: 'http://127.0.0.1:6660/mcp' })
    },
    capture: {
      health: async () => ({
        verdict: 'healthy', recording: true, lastEventAt: Date.now(), checkedAt: Date.now(),
        sources: [
          { id: 'shell-hook', installed: true, lastEventAt: Date.now(), state: 'active' },
          { id: 'claude-code', installed: true, lastEventAt: null, state: 'idle' },
          { id: 'mitmproxy', lastEventAt: null, state: 'idle' },
          { id: 'builtin-terminal', lastEventAt: null, state: 'idle' }
        ]
      })
    },
    recording: { get: async () => true, toggle: async () => true, onChange: () => unsub },
    pivots: {
      getActive: async () => [{ via: '10.0.0.5', tool: 'ligolo-ng', route: '10.10.20.0/24', ts: Date.now() }],
      onChange: () => unsub
    },
    terminal: {
      spawn: async () => ({ pid: 1 }), write: () => {}, resize: () => {}, kill: () => {},
      list: async () => [], onData: () => unsub, onExit: () => unsub
    },
    overlay: {
      toggle: () => {}, hide: () => {}, show: () => {},
      isVisible: async () => false, onVisibilityChanged: () => unsub,
      onInteractive: () => unsub, setExpanded: () => {}, quickMark: () => {},
      mouseEnter: () => {}, mouseLeave: () => {}
    }
  }
}

function renderView(ui: React.ReactElement): void {
  render(<I18nProvider>{ui}</I18nProvider>)
}

describe('renderer views render without throwing', () => {
  beforeEach(() => {
    installBridge()
    window.localStorage.clear()
    // ResizeObserver drives the Timeline's lane heights and jsdom has none.
    ;(window as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    }
  })

  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
  })

  const views: Array<[string, () => React.ReactElement]> = [
    ['App', () => <App />],
    ['Timeline', () => <TimelinePanel />],
    ['Settings', () => <Settings />],
    ['ProjectPicker', () => <ProjectPicker onProjectOpen={() => {}} />],
    ['Sidebar', () => <Sidebar active="dashboard" onNavigate={() => {}} />],
    ['StatusBar', () => <StatusBar />],
    ['IPStatusCard', () => <IPStatusCard />],
    ['TargetView', () => <TargetView />],
    ['ScopeStatus', () => <ScopeStatus />],
    ['LootPanel', () => <LootPanel />],
    ['QuickMarksView', () => <QuickMarksView />],
    ['OverlayApp', () => <OverlayApp />]
  ]

  for (const [name, make] of views) {
    it(`${name} mounts`, () => {
      expect(() => renderView(make())).not.toThrow()
    })
  }

  // The mount loop above only proves the FIRST synchronous render survives.
  // TargetView builds its rows after an async query resolves, and a crash in
  // that second render (a hook interleaved into the filter callback, reading
  // `filtered` before it was assigned) is invisible to a synchronous
  // not.toThrow — it shipped, and only an app-in-the-loop e2e caught it. This
  // waits for a real row so the data-render path is under test here too.
  it('TargetView survives rendering actual target rows', async () => {
    renderView(<TargetView />)
    expect(await screen.findByText('example.com', {}, { timeout: 3000 })).toBeTruthy()
  })

  it('Timeline renders a row for every agent_type without a missing-lane crash', async () => {
    const { findAllByText } = render(<I18nProvider><TimelinePanel /></I18nProvider>)
    // Lane labels only appear once events land, so waiting for one proves the
    // events flowed through toLane()/laneEvents without an undefined bucket.
    const shellLabels = await findAllByText('Shell')
    expect(shellLabels.length).toBeGreaterThan(0)
  })
})
