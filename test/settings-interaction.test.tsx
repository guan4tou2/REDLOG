// @vitest-environment jsdom
//
// Settings is 2,700 lines and, until now, had exactly one assertion against it:
// "it mounts" (`renderer-smoke`). Every option in `config.yaml` is reachable
// only through this component, so an option whose control writes the wrong key —
// or coerces a value differently from the engine that consumes it — is invisible
// to the rest of the suite.
//
// Each test here drives a real control and reads what `config.save` was handed.
// Auto-save is debounced 350 ms; the Save button is the documented "flush now"
// escape hatch, so it is what these tests press.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, cleanup, screen, fireEvent, waitFor } from '@testing-library/react'
import { I18nProvider } from '../src/renderer/src/i18n'

// Settings resolves `isMacOS` at module scope, so the platform has to be on the
// bridge BEFORE the import — otherwise the macOS-only controls (Dock icon,
// Wi-Fi SSID) never render and their tests silently pass on an empty DOM.
;(window as unknown as { redlog: unknown }).redlog = { platform: 'darwin' }
const { default: Settings } = await import('../src/renderer/src/components/Settings')

const unsub = (): void => {}
const saved: Array<Record<string, unknown>> = []

const BASE_CONFIG = {
  engagement: { id: 'eng', name: 'Engagement' },
  operator: { id: 'op-1', name: 'Operator' },
  network: {
    whitelist: ['10.8.0.0/24'], blacklist: ['1.2.3.4'], checkInterval: 60,
    providers: [], confirmations: 3, ipMode: 'auto', showWifiName: false, vpnAdapters: []
  },
  scope: { warnOnViolation: true, targets: ['*.app.example.com'], excludeTargets: [], proximityBits: 24, scopeFile: '' },
  screenshot: { quality: 85, intervalSec: 0 },
  overlay: {
    showMarkButton: true, showInDock: true, flashOnExposed: true,
    scale: 1.0, emphasizeExternalIp: false, passThrough: false, passThroughOpacity: 0.4
  },
  terminal: { maxCastBytes: 52428800 },
  clipboard: { enabled: false, pollMs: 1500, storePreview: false },
  browser: { binary: '', proxy: 'http://127.0.0.1:8080', cdpPort: 9222, isolateProfile: true, ignoreCertErrors: true, startUrl: '', extraArgs: [] },
  redaction: { allowlist: [], denylist: [], entropyThreshold: 4.5, minLength: 20 },
  deconfliction: { enabled: false, url: '', secret: '', events: [], subtypes: [], includeData: false },
  fileWatcher: { enabled: false, watchPaths: [], ignorePatterns: [] },
  processMonitor: { enabled: false, pollMs: 500, ignoreCommands: [] },
  agentTailer: { enabled: true, emitThinking: false },
  marketplace: { defaultRegistryUrl: 'https://example.test/index.json' },
  cloudShare: { endpoint: '', authToken: '' }
}

function installBridge(): void {
  ;(window as unknown as { redlog: unknown }).redlog = {
    platform: 'darwin',
    config: {
      get: async () => structuredClone(BASE_CONFIG),
      save: async (c: Record<string, unknown>) => { saved.push(structuredClone(c)); return true },
      exportProfile: async () => null,
      importProfile: async () => null
    },
    hooks: { detect: async () => [], install: async () => ({ success: true, message: '' }), uninstall: async () => ({ success: true, message: '' }) },
    hookConfig: { get: async () => ({ excludedPaths: [], watchPaths: [] }), save: async () => true },
    operators: { list: async () => [{ id: 'op-1', name: 'Operator', isPrimary: true, createdAt: 1, revokedAt: null }] },
    chain: { length: async () => 1, anchors: async () => [], verify: async () => ({ ok: true, anchor: null, currentHead: null }), upgrade: async () => ({ upgraded: 0, scanned: 0 }) },
    mcp: { info: async () => ({ port: 6660, endpoint: 'http://127.0.0.1:6660/mcp', stdioPath: '/x.js', hasToken: false }) },
    cdp: { getTab: async () => ({ url: null, title: null, connected: false }), setPort: async () => true },
    browser: { detect: async () => '/Applications/Chrome', status: async () => ({ running: false }) },
    deconfliction: { get: async () => BASE_CONFIG.deconfliction, test: async () => ({ ok: true, status: 200 }) },
    data: { exportJson: async () => '/tmp/x.json', exportScopeFiltered: async () => '/tmp/y.json', exportBundle: async () => null },
    plugins: { list: async () => [], setEnabled: async () => true, install: async () => ({ ok: true }), uninstall: async () => true },
    marketplace: { fetchRegistry: async () => ({ plugins: [] }), install: async () => ({ ok: true }) },
    cloudShare: { upload: async () => null },
    updater: { check: async () => null, onStatus: () => unsub },
    events: { onNew: () => unsub },
    project: { active: async () => ({ id: 'p1', name: 'Proj', path: '/tmp/p1', createdAt: 1 }) },
    ip: { getStatus: async () => null, onStatus: () => unsub }
  }
}

/** Render Settings, wait for the config fetch, and open a tab. */
async function open(tab: 'Capture' | 'Scope' | 'Evidence' | 'OPSEC' | 'Advanced'): Promise<void> {
  installBridge()
  render(<I18nProvider><Settings /></I18nProvider>)
  fireEvent.click(await screen.findByText(tab))
}

/** Flush the debounce and return the config handed to `config.save`. */
async function save(): Promise<Record<string, never>> {
  fireEvent.click(screen.getByText('Save'))
  await waitFor(() => expect(saved.length).toBeGreaterThan(0))
  return saved[saved.length - 1] as Record<string, never>
}

/** The checkbox belonging to a label, found by the label's text. */
function toggle(text: string | RegExp): HTMLInputElement {
  const label = screen.getByText(text).closest('label') as HTMLElement
  return label.querySelector('input[type="checkbox"]') as HTMLInputElement
}

/** The text input belonging to a `<Field label=…>`. */
function field(text: string | RegExp): HTMLInputElement {
  const wrapper = screen.getByText(text).parentElement as HTMLElement
  return wrapper.querySelector('input') as HTMLInputElement
}

beforeEach(() => { saved.length = 0 })
afterEach(() => { cleanup(); vi.restoreAllMocks() })

describe('Scope tab', () => {
  it('the warn toggle writes scope.warnOnViolation', async () => {
    await open('Scope')
    fireEvent.click(await screen.findByText('Warn on out-of-scope targets'))
    expect((await save()).scope.warnOnViolation).toBe(false)
  })

  it('turning warnings off hides the adjacency width — it has nothing to widen', async () => {
    await open('Scope')
    expect(await screen.findByText(/Adjacent zone width/)).toBeTruthy()
    fireEvent.click(screen.getByText('Warn on out-of-scope targets'))
    await waitFor(() => expect(screen.queryByText(/Adjacent zone width/)).toBeNull())
  })

  it('proximityBits writes the value the ScopeMonitor consumes', async () => {
    await open('Scope')
    fireEvent.change(field(/Adjacent zone width/), { target: { value: '16' } })
    expect((await save()).scope.proximityBits).toBe(16)
  })

  it('proximityBits clamps to the 1–32 CIDR range', async () => {
    await open('Scope')
    const input = field(/Adjacent zone width/)
    fireEvent.change(input, { target: { value: '99' } })
    expect((await save()).scope.proximityBits).toBe(32)
    fireEvent.change(input, { target: { value: '0' } })
    expect((await save()).scope.proximityBits).toBe(24)   // 0 is junk → default
    fireEvent.change(input, { target: { value: '-8' } })
    expect((await save()).scope.proximityBits).toBe(1)
  })

  it('non-numeric input falls back to the default rather than NaN', async () => {
    await open('Scope')
    fireEvent.change(field(/Adjacent zone width/), { target: { value: 'wide' } })
    expect((await save()).scope.proximityBits).toBe(24)
  })

  it('adding a target appends to scope.targets', async () => {
    await open('Scope')
    const list = (await screen.findByText(/^Targets/)).parentElement as HTMLElement
    fireEvent.change(list.querySelector('input') as HTMLElement, { target: { value: '10.0.0.0/24' } })
    fireEvent.click(list.querySelector('button') as HTMLElement)
    expect((await save()).scope.targets).toEqual(['*.app.example.com', '10.0.0.0/24'])
  })

  it('adding an exclusion appends to scope.excludeTargets, not to targets', async () => {
    await open('Scope')
    const list = (await screen.findByText('Exclude from scope')).parentElement as HTMLElement
    fireEvent.change(list.querySelector('input') as HTMLElement, { target: { value: 'dc01.app.example.com' } })
    fireEvent.click(list.querySelector('button') as HTMLElement)
    const cfg = await save()
    expect(cfg.scope.excludeTargets).toEqual(['dc01.app.example.com'])
    expect(cfg.scope.targets).toEqual(['*.app.example.com'])
  })

  it('the scope file path is written verbatim', async () => {
    await open('Scope')
    fireEvent.change(field(/Load targets from file/), { target: { value: '/eng/scope.txt' } })
    expect((await save()).scope.scopeFile).toBe('/eng/scope.txt')
  })
})

describe('OPSEC tab — IP polling', () => {
  it('each ipMode button writes its own value', async () => {
    await open('OPSEC')
    fireEvent.click(await screen.findByText('DNS'))
    expect((await save()).network.ipMode).toBe('dns')
    fireEvent.click(screen.getByText('HTTP'))
    expect((await save()).network.ipMode).toBe('http')
    fireEvent.click(screen.getByText(/^Auto/))
    expect((await save()).network.ipMode).toBe('auto')
  })

  it('checkInterval writes a number, not the raw string', async () => {
    await open('OPSEC')
    fireEvent.change(field('Check interval (seconds)'), { target: { value: '15' } })
    expect((await save()).network.checkInterval).toBe(15)
  })

  it('a non-numeric interval falls back to 60 rather than NaN', async () => {
    await open('OPSEC')
    fireEvent.change(field('Check interval (seconds)'), { target: { value: 'soon' } })
    expect((await save()).network.checkInterval).toBe(60)
  })

  it('confirmations is floored at 1 — 0 would mean "never confirm"', async () => {
    await open('OPSEC')
    const input = field(/Readings required/)
    fireEvent.change(input, { target: { value: '5' } })
    expect((await save()).network.confirmations).toBe(5)
    fireEvent.change(input, { target: { value: '0' } })
    expect((await save()).network.confirmations).toBe(3)
    fireEvent.change(input, { target: { value: '-2' } })
    expect((await save()).network.confirmations).toBe(1)
  })

  it('the safe/exposed lists write to whitelist and blacklist respectively', async () => {
    await open('OPSEC')
    // Located by the entry placeholder: the two labels are long prose sentences,
    // the placeholders are the stable handle.
    const input = await screen.findByPlaceholderText('e.g. 10.8.0.0/24')
    const safe = input.parentElement as HTMLElement
    fireEvent.change(input, { target: { value: '203.0.113.0/24' } })
    fireEvent.click(safe.querySelector('button') as HTMLElement)
    const cfg = await save()
    expect(cfg.network.whitelist).toEqual(['10.8.0.0/24', '203.0.113.0/24'])
    expect(cfg.network.blacklist).toEqual(['1.2.3.4'])
  })

  it('removing an entry drops only that one', async () => {
    await open('OPSEC')
    const exposed = (await screen.findByPlaceholderText('e.g. 114.24.97.0/24'))
      .parentElement?.parentElement as HTMLElement
    fireEvent.click(exposed.querySelector('span button') as HTMLElement)
    const cfg = await save()
    expect(cfg.network.blacklist).toEqual([])
    expect(cfg.network.whitelist).toEqual(['10.8.0.0/24'])
  })
})

describe('OPSEC tab — HUD appearance', () => {
  it('the flash toggle writes overlay.flashOnExposed', async () => {
    await open('OPSEC')
    fireEvent.click(toggle('Flash HUD when IP exposed'))
    expect((await save()).overlay.flashOnExposed).toBe(false)
  })

  it('each scale button writes its documented value', async () => {
    await open('OPSEC')
    fireEvent.click(await screen.findByText('Small'))
    expect((await save()).overlay.scale).toBe(0.85)
    fireEvent.click(screen.getByText('Large'))
    expect((await save()).overlay.scale).toBe(1.25)
  })

  it('the emphasis toggle writes overlay.emphasizeExternalIp', async () => {
    await open('OPSEC')
    fireEvent.click(toggle('Emphasize external IP'))
    expect((await save()).overlay.emphasizeExternalIp).toBe(true)
  })

  it('the opacity slider only appears once click-through is on', async () => {
    await open('OPSEC')
    expect(screen.queryByText(/Opacity while click-through/)).toBeNull()
    fireEvent.click(toggle(/Click-through mode/))
    expect(await screen.findByText(/Opacity while click-through/)).toBeTruthy()
    expect((await save()).overlay.passThrough).toBe(true)
  })

  it('the opacity slider writes a float and shows it as a percentage', async () => {
    await open('OPSEC')
    fireEvent.click(toggle(/Click-through mode/))
    const row = (await screen.findByText(/Opacity while click-through/)).parentElement as HTMLElement
    fireEvent.change(row.querySelector('input[type="range"]') as HTMLElement, { target: { value: '0.25' } })
    expect((await save()).overlay.passThroughOpacity).toBe(0.25)
    expect(row.textContent).toContain('25%')
  })

  it('the mark-button and Dock toggles write their own keys', async () => {
    await open('OPSEC')
    fireEvent.click(toggle(/Show Mark button/))
    fireEvent.click(toggle(/Keep Dock icon/))
    const cfg = await save()
    expect(cfg.overlay.showMarkButton).toBe(false)
    expect(cfg.overlay.showInDock).toBe(false)
  })
})

describe('Capture tab', () => {
  it('JPEG quality writes a number', async () => {
    await open('Capture')
    fireEvent.change(field(/JPEG quality/), { target: { value: '60' } })
    expect((await save()).screenshot.quality).toBe(60)
  })
})

describe('cross-cutting', () => {
  it('changing one option leaves every other block untouched', async () => {
    await open('Scope')
    fireEvent.click(await screen.findByText('Warn on out-of-scope targets'))
    const cfg = await save()
    expect(cfg.network).toEqual(BASE_CONFIG.network)
    expect(cfg.overlay).toEqual(BASE_CONFIG.overlay)
    expect(cfg.redaction).toEqual(BASE_CONFIG.redaction)
    expect(cfg.deconfliction).toEqual(BASE_CONFIG.deconfliction)
  })

  // F3: a filter hit is a jump button carrying its owning tab, not the control
  // itself — clicking it switches tab and clears the filter so the real controls
  // show. The new proximityBits label has to be in that index to be findable.
  it('the search box finds a setting by name from another tab, and jumps to it', async () => {
    await open('Capture')
    fireEvent.change(await screen.findByPlaceholderText(/filter settings/i), { target: { value: 'adjacent' } })
    const hit = await screen.findByText('Scope Warnings')
    expect((hit.parentElement as HTMLElement).textContent).toContain('Scope')
    fireEvent.click(hit)
    expect(await screen.findByText(/Adjacent zone width/)).toBeTruthy()
  })
})
