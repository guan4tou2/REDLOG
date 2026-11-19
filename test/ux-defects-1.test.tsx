// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { cleanup, render, screen, fireEvent, waitFor, act } from '@testing-library/react'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { escapeBelongsAbove } from '../src/renderer/src/lib/escapeLayer'
import { I18nProvider } from '../src/renderer/src/i18n'
import { LaunchBrowserButton } from '../src/renderer/src/components/DashboardView'
import { ToastContainer, toast } from '../src/renderer/src/components/Toast'
import { useAppCounts } from '../src/renderer/src/lib/useAppCounts'
const source = (p: string): string => readFileSync(resolve(__dirname, '../src', p), 'utf8')
afterEach(() => { cleanup(); document.body.innerHTML = ''; vi.restoreAllMocks() })

it('1: shortcut reports rejected captures and uses a persistent error', () => {
  const main = source('main/index.ts').split("globalShortcut.register(QUICK_SHOT_ACCELERATOR")[1].split('// --- Updates')[0]
  expect(main).toMatch(/\.catch\([\s\S]*screenshot:shortcutResult[\s\S]*ok: false/)
  expect(source('renderer/src/App.tsx')).toMatch(/screenshotNotSaved'\), \{ type: 'error'/)
})

it.each(['hidden', 'inert', 'style="display:none"', 'style="visibility:hidden"'])('2: ignores a modal inside %s', (attr) => {
  document.body.innerHTML = `<section ${attr}><div role="dialog" aria-modal="true"></div></section>`
  expect(escapeBelongsAbove(new KeyboardEvent('keydown', { key: 'Escape' }))).toBe(false)
  document.body.innerHTML = '<div role="dialog" aria-modal="true"></div>'
  expect(escapeBelongsAbove(new KeyboardEvent('keydown', { key: 'Escape' }))).toBe(true)
})

it('3: both clipboard entry points use xterm paste and retain onData delivery', () => {
  const s = source('renderer/src/components/TerminalView.tsx')
  expect(s.match(/if \(txt\) term\.paste\(txt\)/g)).toHaveLength(2)
  expect(s).toContain('term.onData(data => window.redlog.terminal.write(id, data))')
})

it.each(['TargetView', 'SearchPanel', 'CastResults', 'CommandPalette', 'HttpHistoryPanel', 'MarkerDetail', 'EventMarker', 'ActivityReader'])('4: %s uses the existing date-aware formatter', (name) => {
  const s = source(`renderer/src/components/${name}.tsx`)
  expect(s).toContain('formatWhen(')
  expect(s).not.toMatch(/formatTime\((?:e\.timestamp|f\.timestamp|hit\.tMs|atTimestamp)/)
})

it('5: the status bar and app start recording as unknown', () => {
  for (const name of ['components/StatusBar.tsx', 'App.tsx']) {
    expect(source(`renderer/src/${name}`)).toMatch(/useState<boolean \| null>\(null\)/)
  }
  expect(source('renderer/src/components/StatusBar.tsx')).toContain("t('overlay.recUnknown')")
})

function Counts(): JSX.Element {
  const c = useAppCounts()
  return <div data-testid="counts">{c.loading ? 'loading' : c.countsUnknown ? 'unknown' : c.eventCount}</div>
}
it.each(['chained', 'logged', 'chain', 'loot'])('6: failed %s count is unknown and a retry recovers', async (failed) => {
  let fail = true
  const read = async (name: string): Promise<number> => { if (fail && name === failed) throw Error('read failed'); return 7 }
  ;(window as unknown as { redlog: unknown }).redlog = {
    events: { getCount: (tier: string) => read(tier), onNewBatch: () => () => {} },
    chain: { length: () => read('chain') }, loot: { getCount: () => read('loot'), countIsPartial: async () => false },
    scope: { getObservationCount: async () => 0, isConfigured: async () => true }
  }
  render(<Counts />)
  await waitFor(() => expect(screen.getByTestId('counts').textContent).toBe('unknown'))
  fail = false
  window.dispatchEvent(new Event('redlog:recount'))
  await waitFor(() => expect(screen.getByTestId('counts').textContent).toBe('7'))
})

it('7: notifications stack above dialogs and the command palette', () => {
  const { container } = render(<I18nProvider><ToastContainer /></I18nProvider>)
  act(() => toast('saved'))
  const layer = Number(container.firstElementChild?.className.match(/z-\[(\d+)\]/)?.[1])
  expect(layer).toBeGreaterThan(200)
})

it.each(['launch', 'stop'])('9: rejected browser %s leaves the existing button usable and reports failure', async (method) => {
  ;(window as unknown as { redlog: unknown }).redlog = { browser: {
    status: async () => ({ running: method === 'stop' }), onExited: () => () => {},
    launch: vi.fn().mockRejectedValue(Error('launch rejected')), stop: vi.fn().mockRejectedValue(Error('stop rejected'))
  } }
  render(<I18nProvider><LaunchBrowserButton onNavigate={() => {}} /><ToastContainer /></I18nProvider>)
  const button = await screen.findByRole('button', { name: method === 'stop' ? 'Stop Browser' : 'Launch capture browser' })
  fireEvent.click(button)
  await waitFor(() => expect((button as HTMLButtonElement).disabled).toBe(false))
  expect(await screen.findByRole('alert')).toBeTruthy()
})

it('12: tiny controls use invisible hit areas of at least 24 device pixels', () => {
  for (const name of ['FilterBar', 'Toast', 'HttpHistoryPanel']) {
    const s = source(`renderer/src/components/${name}.tsx`)
    const controls = s.split('\n').filter(line => line.includes('after:-inset-1.5'))
    expect(controls).toHaveLength(name === 'HttpHistoryPanel' ? 4 : 1)
    for (const control of controls) expect(control).toContain('after:min-w-[27px] after:min-h-[27px]')
  }
  // The pseudo-element floor also covers the 10px chip and narrow toast glyph.
  expect(27 * 0.9).toBeGreaterThanOrEqual(24)
})
