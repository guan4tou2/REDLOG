// @vitest-environment jsdom
//
// Spec 075 T005 (US2): what each place that shows capture status says TODAY,
// for ONE machine. The machine, in the facts every surface reads:
//   - the zsh hook is installed, and nothing has been typed in an own terminal;
//   - the managed proxy is running, and no client has verified HTTPS;
//   - the screenshot source is failing (`screen capture came back empty`);
//   - Claude Code is installed, the project asks for it, and its transcript
//     directory is configured as a RELATIVE path, which capture refuses
//     (04-U4): the capture row is `off`.
// Each surface gets that machine in the shape it reads: capture-health
// snapshot, hook list, proxy status, plugin list, event stream, pane state.
// `PAYLOAD` is what `getCaptureHealth` returns for it (a golden in
// test/capture-payload-golden.test.ts); the other inputs are written to
// match it, because several surfaces do not read the snapshot at all, and
// that is part of what is being recorded.
//
// The first block pins the words. The second states where surfaces that talk
// about the same source must agree and today do not; those are `it.fails`
// with the reason, and Phase 3-6 turns each one green by deleting the
// surface's own judgement (G2). Never edit production code to change a pin.
//
// Surfaces (the plan's nine), each rendered for real in jsdom:
//   1 dashboard card    CaptureHealthCard
//   2 status bar        StatusBar
//   3 commands & terminal  HooksPanel (Settings)
//   4 HTTP              HttpCaptureStep
//   5 capture control   CaptureControlPage (screenshot row, AI row)
//   6 plugin detail     PluginsPanel -> PluginDetailPanel
//   7 first run         FirstRunView
//   8 HUD               OverlayApp
//   9 pane badge        TerminalView's session meta
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useState } from 'react'
import { I18nProvider } from '../src/renderer/src/i18n'
import en from '../src/renderer/src/i18n/en.json'
import StatusBar from '../src/renderer/src/components/StatusBar'
import { CaptureHealthCard } from '../src/renderer/src/components/CaptureHealth'
import CaptureControlPage from '../src/renderer/src/components/settings/CaptureControlPage'
import HooksPanel from '../src/renderer/src/components/settings/HooksPanel'
import PluginsPanel from '../src/renderer/src/components/settings/PluginsPanel'
import { HttpCaptureStep } from '../src/renderer/src/components/HttpCaptureStep'
import { FirstRunView } from '../src/renderer/src/components/FirstRunView'
import OverlayApp from '../src/renderer/src/OverlayApp'
import { _resetCaptureHealth } from '../src/renderer/src/lib/captureHealthStore'
import { _resetIssues } from '../src/renderer/src/lib/issues'

vi.mock('@xterm/xterm/css/xterm.css', () => ({}))
vi.mock('@xterm/xterm', () => ({
  Terminal: class {
    element = document.createElement('div'); cols = 80; rows = 24; options: Record<string, unknown> = {}
    loadAddon(): void {} attachCustomKeyEventHandler(): void {} open(parent: HTMLElement): void { parent.appendChild(this.element) }
    write(): void {} onData(): { dispose(): void } { return { dispose() {} } } onResize(): { dispose(): void } { return { dispose() {} } }
    focus(): void {} dispose(): void {} hasSelection(): boolean { return false }
  }
}))
vi.mock('@xterm/addon-fit', () => ({ FitAddon: class { fit(): void {} } }))
vi.mock('@xterm/addon-search', () => ({ SearchAddon: class { findNext(): void {} findPrevious(): void {} } }))
const NOW = Date.now()
const noop = (): void => {}
const text = (el: Element | null): string => (el?.textContent ?? '').replace(/\s+/g, ' ').trim()
const t = (key: string, vars?: Record<string, string | number>): string =>
  ((en as Record<string, string>)[key] ?? key).replace(/\{\{(\w+)\}\}/g, (_, k) => String(vars?.[k] ?? ''))

const PAYLOAD = {
  verdict: 'partial', hasRecorded: false, lastEventAt: null, checkedAt: NOW, dbErrorTotal: 0, dbErrorFirstAt: null,
  sources: [
    { id: 'terminal', installed: true, hookId: 'shell-zsh', lastEventAt: null, state: 'ready', ownShellLastEventAt: null, ownShellOutputAt: null, ownShellName: null },
    { id: 'mitmproxy', installed: true, hookId: 'mitmproxy', lastEventAt: null, state: 'ready' },
    { id: 'agent-claude-code', label: 'Claude Code', installed: true, enabled: false, lastEventAt: null, state: 'off' },
    { id: 'screenshot', lastEventAt: null, state: 'error', lastError: { at: NOW, message: 'screen capture came back empty' } }
  ],
  managedHttpProxy: { state: 'running', url: 'http://127.0.0.1:8080', certReady: true }
} as unknown as CaptureHealthInfo
const PROXY = { state: 'running', url: 'http://127.0.0.1:8080', caFingerprint: { sha256: 'aa' } }
const ZSH_HOOK = { id: 'shell-zsh', name: 'Zsh adapter', description: '', agentType: 'shell', installed: true, available: true, installMethod: 'shell-source', hookFile: '', builtin: true }
const CLAUDE_ENTRY = { agentKind: 'claude-code', pluginId: 'official-ai-claude-code', name: 'Claude Code', source: {}, state: 'installed', installationId: 'i1' }
const CLAUDE_PLUGIN = { id: 'official-ai-claude-code', name: 'Claude Code', version: '1.0.0', description: '', author: 'RedLog', source: 'bundled', tier: 'declarative', status: 'active', capabilities: [], contributes: [], report: null }
const CLAUDE_CONFIG = { enabled: true, installationId: 'i1', workPaths: ['/work'], startedAt: 1, sourceRoot: 'relative/dir' }
const PREFLIGHT = { platform: 'darwin', shell: { name: 'zsh', hookId: 'shell-zsh' }, checks: [
  { id: 'python3', found: true, neededFor: ['shell-zsh', 'shell-bash'] }, { id: 'curl', found: true, neededFor: ['shell-zsh', 'shell-bash'] },
  { id: 'zsh', found: true, neededFor: ['shell-zsh'] }, { id: 'bash', found: true, neededFor: ['shell-bash'] },
  { id: 'mitmdump', found: true, neededFor: ['mitmproxy'] }
] }

/** The preload bridge: what the surfaces read, one entry per area; any other
 *  call answers with an empty value so a surface cannot trip on an area this
 *  test does not care about. */
function bridge(extra: Record<string, Record<string, unknown>> = {}): void {
  const named: Record<string, Record<string, unknown>> = {
    capture: { health: async () => PAYLOAD },
    events: { getCount: async () => 0, onNewBatch: () => noop, query: async () => [], commandEvidence: async () => ({ builtin: false, external: false }) },
    chain: { length: async () => 0, anchors: async () => [] },
    project: { active: async () => ({ createdAt: NOW - 60_000 }) },
    ip: { getStatus: async () => null, onStatus: () => noop },
    recording: { get: async () => true, onChange: () => noop },
    overlay: { autosize: noop, onInteractive: () => noop },
    scope: { getObservationCount: async () => 0, isConfigured: async () => true, getLastRecompute: async () => null },
    loot: { getCount: async () => 0 },
    config: { get: async () => ({ browser: { ignoreCertErrors: false }, httpCapture: { port: 8080, routeTerminals: false } }), getPrefs: async () => ({}) },
    plugins: { list: async () => [{ id: 'pack-host-monitors', source: 'bundled', status: 'active' }], officialAgents: async () => [CLAUDE_ENTRY] },
    agents: { sources: async () => [], sessions: async () => [] },
    hooks: { detect: async () => [ZSH_HOOK], terminalPolicy: async () => null },
    pivots: { getActive: async () => [], onChange: () => noop },
    runtime: { preflight: async () => PREFLIGHT, install: noop },
    httpCapture: { status: async () => PROXY, onVerify: () => noop, start: noop, stop: noop },
    clipboard: { writeText: async () => true, readText: async () => '' },
    app: { openExternal: noop },
    ...extra
  }
  const area = (name: string): unknown => new Proxy(named[name] ?? {}, {
    get: (target, fn: string) => fn in target ? target[fn] : fn.startsWith('on') ? () => noop : async () => undefined
  })
  ;(window as unknown as { redlog: unknown }).redlog = new Proxy({ platform: 'darwin' } as Record<string, unknown>, {
    get: (target, name: string) => name in target ? target[name] : area(name)
  })
}
const wrap = (ui: React.ReactElement): ReturnType<typeof render> => render(<I18nProvider>{ui}</I18nProvider>)

beforeEach(() => {
  window.localStorage.clear(); window.localStorage.setItem('redlog-locale', 'en')
  _resetCaptureHealth(); _resetIssues(); bridge()
  vi.stubGlobal('requestAnimationFrame', (cb: () => void) => { cb(); return 0 })
  vi.stubGlobal('ResizeObserver', class { observe(): void {} disconnect(): void {} })
})
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); window.localStorage.clear() })

/** What every surface says about the machine above. Filled by the first block
 *  and read by the second, so the agreement cases compare recorded words. */
const said: Record<string, string> = {}

// --- surfaces -------------------------------------------------------------

async function card(): Promise<void> {
  wrap(<CaptureHealthCard capture={PAYLOAD} projectId="p" onNavigate={noop} onRefresh={noop} />)
  said['card.headline'] = text(screen.getByTestId('capture-verdict'))
  said['card.commands'] = text(screen.getByTestId('capture-core-commands'))
  said['card.ownShell'] = text(screen.getByTestId('capture-core-commands-own-shell'))
  said['card.https'] = text(screen.getByTestId('capture-https-verification'))
  said['card.screenshot'] = text(screen.getByTestId('capture-state-screenshot'))
  said['card.claudeCodeRow'] = screen.queryByTestId('capture-row-agent-claude-code') ? 'listed' : 'not listed'
}

async function statusBar(): Promise<void> {
  wrap(<StatusBar />)
  const bar = await waitFor(() => {
    const el = screen.getByTestId('status-bar-recording')
    expect(el.getAttribute('data-capture')).toBe('partial')
    return el
  })
  said['statusBar.dot'] = bar.getAttribute('data-capture') ?? ''
  said['statusBar.label'] = text(bar)
  said['statusBar.aria'] = bar.getAttribute('aria-label') ?? ''
}

async function controlPage(): Promise<void> {
  bridge({ plugins: { list: async () => [{ id: 'pack-host-monitors', source: 'bundled', status: 'active' }, CLAUDE_PLUGIN], officialAgents: async () => [CLAUDE_ENTRY] } })
  function Harness(): JSX.Element {
    const [config, setConfig] = useState({ engagement: { id: 'p' }, packs: { hostMonitors: true }, screenshot: { intervalSec: 30 }, agentTailer: { sources: { 'claude-code': CLAUDE_CONFIG } } } as never)
    return <I18nProvider><CaptureControlPage config={config} setConfig={setConfig} t={t} /></I18nProvider>
  }
  render(<Harness />)
  said['control.screenshot'] = text(await screen.findByTestId('source-last-screenshot'))
  const agent = await screen.findByTestId('agent-source-claude-code')
  said['control.claudeCode.record'] = (screen.getByTestId('agent-enabled-claude-code') as HTMLInputElement).checked ? 'on' : 'off'
  said['control.claudeCode.folder'] = text(within(agent).getByText('Transcript folder not found'))
}

async function hooksPanel(): Promise<void> {
  render(<HooksPanel hooks={[ZSH_HOOK] as never} setHooks={noop} t={t} />)
  said['hooks.zsh'] = text(screen.getByText('Installed'))
}

async function httpStep(): Promise<void> {
  wrap(<HttpCaptureStep />)
  said['http.checks'] = text(await screen.findByTestId('first-run-http-checks'))
}

async function pluginDetail(): Promise<void> {
  bridge({ plugins: { list: async () => [CLAUDE_PLUGIN], officialAgents: async () => [CLAUDE_ENTRY], reload: noop, openFolder: noop } })
  render(<PluginsPanel t={t} config={{ engagement: { id: 'p' }, agentTailer: { sources: { 'claude-code': CLAUDE_CONFIG } } } as never} />)
  fireEvent.click(await screen.findByTestId('plugin-details-official-ai-claude-code'))
  said['plugin.project'] = text(await screen.findByTestId('plugin-project-official-ai-claude-code'))
  said['plugin.health'] = text(screen.getByTestId('plugin-health-official-ai-claude-code'))
}

async function firstRun(): Promise<void> {
  wrap(<FirstRunView onNavigate={noop} renderCaptureCard={() => <div />} />)
  said['firstRun.commands'] = text(await screen.findByTestId('first-run-commands-status'))
  said['firstRun.http'] = text(await screen.findByTestId('first-run-http-check-https'))
}

async function hud(): Promise<void> {
  wrap(<OverlayApp />)
  await act(async () => {})
  said['hud.rec'] = text(await screen.findByTestId('hud-rec'))
}

async function paneBadge(): Promise<void> {
  const spawn = vi.fn(async () => ({ pid: 4242, recording: true, castTruncated: false, paused: false, hookSourced: true, shell: '/bin/zsh' }))
  bridge({
    terminal: {
      list: async () => [], shells: async () => [], spawn, write: noop, resize: noop, kill: noop,
      onData: () => noop, onExit: () => noop, onCastState: () => noop
    },
    ui: { contextMenu: noop }
  })
  const { default: TerminalView } = await import('../src/renderer/src/components/TerminalView')
  wrap(<TerminalView />)
  await waitFor(() => expect(spawn).toHaveBeenCalled())
  said['pane.hook'] = text(await screen.findByTestId('terminal-meta-hook'))
}

describe('what each surface says about one machine (Spec 075 T005)', () => {
  it('1 dashboard card: a problem headline, commands "ready" but unfinished, HTTPS not verified, screenshot failing, AI row not listed', async () => {
    await card()
    expect(said['card.headline']).toBe('▲Some sources report problems')
    expect(said['card.commands']).toBe('CommandsHook installed (shell)RunningShell hook installed · open a new terminal and run a command to finish setupready')
    expect(said['card.ownShell']).toBe('Shell hook installed · open a new terminal and run a command to finish setup')
    expect(said['card.https']).toBe('HTTPS not verified with a client')
    expect(said['card.screenshot']).toBe('failing')
    expect(said['card.claudeCodeRow']).toBe('not listed')
  })

  it('2 status bar: dot partial, label still "Waiting for events…", tooltip names a failing source', async () => {
    await statusBar()
    expect(said['statusBar.dot']).toBe('partial')
    expect(said['statusBar.label']).toBe('Waiting for events…0:00')
    expect(said['statusBar.aria']).toBe('A capture source is failing — the dashboard says which\nNo events received yet')
  })

  it('3 commands & terminal (hooks page): the zsh adapter is "Installed"', async () => {
    await hooksPanel()
    expect(said['hooks.zsh']).toBe('Installed')
  })

  it('4 HTTP: HTTPS "Not verified"', async () => {
    await httpStep()
    expect(said['http.checks']).toBe('HTTPS○ Not verified')
  })

  it('5 capture control: the screenshot row says "Nothing received yet" (no failure); the AI row has recording on and says its folder was not found', async () => {
    await controlPage()
    expect(said['control.screenshot']).toBe('Nothing received yet')
    expect(said['control.claudeCode.record']).toBe('on')
    expect(said['control.claudeCode.folder']).toBe('Transcript folder not found')
  })

  it('6 plugin detail: the project axis says "Enabled for this project." and health "Nothing received yet"', async () => {
    await pluginDetail()
    expect(said['plugin.project']).toBe('Enabled for this project.')
    expect(said['plugin.health']).toBe('Nothing received yet')
  })

  it('7 first run: commands and HTTPS both "○ Not verified"', async () => {
    await firstRun()
    expect(said['firstRun.commands']).toBe('○ Not verified')
    expect(said['firstRun.http']).toBe('HTTPS○ Not verified')
  })

  it('8 HUD: says REC and reads no capture status at all', async () => {
    const health = vi.fn(async () => PAYLOAD)
    bridge({ capture: { health } })
    await hud()
    expect(said['hud.rec']).toBe('REC')
    expect(health).not.toHaveBeenCalled()
  })

  it('9 pane badge: the hook line reads "events connected" from the pane, not from the snapshot', async () => {
    await paneBadge()
    expect(said['pane.hook']).toBe('Commandsevents connected')
  })
})

// Where surfaces that speak about the same source agree today, and where they
// do not. The three `it.fails` are the disagreements; each names what the
// correct reading is, and which phase makes it so.
describe('do the surfaces agree about the same source? (Spec 075 T005, US2)', () => {
  it('the commands source is unfinished everywhere it is named', async () => {
    await card(); cleanup(); await firstRun(); cleanup(); await paneBadge()
    expect(said['card.ownShell']).toContain('run a command to finish setup')
    expect(said['firstRun.commands']).toBe('○ Not verified')
  })

  it('HTTPS is unverified everywhere it is named', async () => {
    await card(); cleanup(); await httpStep(); cleanup(); await firstRun()
    expect(said['card.https']).toContain('not verified')
    expect(said['http.checks']).toContain('Not verified')
    expect(said['firstRun.http']).toContain('Not verified')
  })

  // Dashboard: "failing". Capture control, the page that configures it: "Nothing
  // received yet". Phase 4/5 (T040, T054): both read the source's own status.
  it.fails('a failing screenshot source is failing on the card AND on its own row in capture control', async () => {
    await card(); cleanup(); await controlPage()
    expect(said['card.screenshot']).toBe('failing')
    expect(said['control.screenshot']).toMatch(/fail|error|empty/i)
  })

  // 04-U4. The capture row is off and the AI row itself says the folder was not
  // found; the plugin page says the integration is enabled for this project.
  // Phase 5 (T051) takes officialProjectLevel/officialHealth off the page.
  it.fails('an AI source whose folder is not found is not "enabled for this project" on the plugin page', async () => {
    await controlPage(); cleanup(); await pluginDetail()
    expect(said['control.claudeCode.folder']).toBe('Transcript folder not found')
    expect(said['plugin.project']).not.toMatch(/enabled for this project/i)
  })

  // The dot is "partial" and the tooltip says a source is failing; the label
  // beside the dot reads as if nothing were wrong yet. Phase 3 (T031): dot,
  // label and tooltip read one overall state.
  it.fails('the status bar label does not say "waiting" while a source is failing', async () => {
    await statusBar()
    expect(said['statusBar.aria']).toContain('failing')
    expect(said['statusBar.label']).not.toMatch(/waiting/i)
  })
})
