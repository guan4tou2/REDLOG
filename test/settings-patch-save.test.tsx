// @vitest-environment jsdom
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import Settings, { type SettingsPage } from '../src/renderer/src/components/Settings'
import { I18nProvider } from '../src/renderer/src/i18n'

// Settings at its boundary with main, with main played by an in-memory file.
//
// Settings used to send the whole config on every autosave. A field another
// writer changed after the page loaded — the API, a plugin, the current-target
// switch, main itself — went back to what the page had loaded, unless that
// writer happened to announce itself. Now the page sends the fields it changed,
// each with the value it last saw, and keeps what the operator typed on screen
// until a save of it succeeds.
//
// The bridge answers both the whole-object `save` and the patch `patch`, the
// way main does, so these cases say the same thing about either kind of page.

type Op = { path: string[]; value?: unknown; unset?: true; base?: unknown; baseAbsent?: true }
let disk: Record<string, unknown>
let fail: null | 'throw' | 'refuse' = null
const writes: string[] = []

const at = (root: unknown, path: string[]): unknown =>
  path.reduce<unknown>((cur, k) => (cur && typeof cur === 'object' ? (cur as Record<string, unknown>)[k] : undefined), root)
const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b)

function mainPatch(p: { ops: Op[]; expectProjectId?: string }): unknown {
  if (p.expectProjectId && p.expectProjectId !== at(disk, ['engagement', 'id'])) return { ok: false, reason: 'wrong-project' }
  const conflicts = p.ops.filter((op) => {
    if (!('base' in op) && !op.baseAbsent) return false
    const cur = at(disk, op.path)
    return !same(cur, op.baseAbsent ? undefined : op.base) && !same(cur, op.unset ? undefined : op.value)
  }).map((op) => ({ path: op.path, current: at(disk, op.path) }))
  if (conflicts.length) return { ok: false, reason: 'conflict', conflicts, config: structuredClone(disk), revision: 'r' }
  const next = structuredClone(disk)
  for (const op of p.ops) {
    let cur = next as Record<string, unknown>
    for (const k of op.path.slice(0, -1)) cur = (cur[k] ??= {}) as Record<string, unknown>
    const last = op.path[op.path.length - 1]
    if (op.unset) delete cur[last]
    else cur[last] = structuredClone(op.value)
  }
  disk = next
  writes.push('patch')
  return { ok: true, config: structuredClone(disk), revision: String(writes.length) }
}

const initial = (): Record<string, unknown> => ({
  // A project of its own per case: an edit a case leaves unsaved is kept for
  // that project (by design), and must not turn up in the next case.
  engagement: { id: projectId, activeTarget: null },
  operator: { id: 'op', name: 'Op' },
  network: { whitelist: [], blacklist: [], checkInterval: 61, providers: [], confirmations: 3, ipMode: 'auto', vpnAdapters: [] },
  scope: { warnOnViolation: true, targets: ['in.test'], excludeTargets: [], personalDomains: [], scopeFile: '/scope/a.txt' },
  screenshot: { quality: 85 }, clipboard: {}, processMonitor: {}, connectionMonitor: {}, fileWatcher: {}, packs: {},
  browser: { binary: '/bin/chromium-x', proxy: '', cdpPort: 9222, isolateProfile: true, ignoreCertErrors: false, startUrl: '', extraArgs: [] },
  httpCapture: { port: 6661, listenHost: '127.0.0.1', routeTerminals: false },
  loot: { disabledRules: [] },
  retention: { loggedTier: { keepDays: 7, sweepIntervalHours: 24 } }
})

let projectSeq = 0
let projectId = 'proj-0'
beforeEach(() => {
  projectId = `proj-${++projectSeq}`
  disk = initial()
  fail = null
  writes.length = 0
  const fallback = (): unknown => new Proxy({}, {
    get: (_t, prop: string) => (prop.startsWith('on') ? () => () => {} : async () => null)
  })
  const known: Record<string, unknown> = {
    platform: 'linux',
    config: {
      get: async () => structuredClone(disk),
      save: async (c: Record<string, unknown>, opts?: { expectProjectId?: string }) => {
        if (fail === 'throw') throw new Error('disk full')
        if (fail === 'refuse') return false
        if (opts?.expectProjectId && opts.expectProjectId !== at(disk, ['engagement', 'id'])) return false
        // What main's whole-object save did: everything but the engagement.
        disk = { ...structuredClone(c), engagement: disk.engagement }
        writes.push('save')
        return true
      },
      patch: async (p: { ops: Op[]; expectProjectId?: string }) => {
        if (fail === 'throw') throw new Error('disk full')
        if (fail === 'refuse') return { ok: false, reason: 'invalid', error: 'refused' }
        return mainPatch(p)
      }
    },
    loot: { rules: async () => [{ id: 'aws_key', type: 'aws_key', confidence: 'high', description: 'AWS key' }] },
    project: { active: async () => ({ id: projectId, name: 'A' }), close: async () => true },
    hooks: { detect: async () => [], install: async () => ({ success: true, message: '' }) },
    plugins: { list: async () => [], eventTypes: async () => [] },
    operators: { list: async () => [] },
    browser: { detect: async () => null, status: async () => ({ running: false }) }
  }
  ;(window as unknown as { redlog: unknown }).redlog = new Proxy(known, {
    get: (target, prop: string) => (prop in target ? target[prop] : fallback())
  })
})
afterEach(() => cleanup())

const mount = (page: SettingsPage): ReturnType<typeof render> =>
  render(<I18nProvider><Settings request={{ page }} /></I18nProvider>)
const inputWithValue = (value: string): HTMLInputElement | undefined =>
  [...document.querySelectorAll<HTMLInputElement>('[data-testid="settings-content"] input')].find((i) => i.value === value)
const findInput = async (value: string): Promise<HTMLInputElement> =>
  await waitFor(() => { const el = inputWithValue(value); expect(el).toBeDefined(); return el! })
const failedShown = async (): Promise<void> => {
  await waitFor(() => expect(document.querySelector('[data-testid="settings-save-failed"]')).not.toBeNull(), { timeout: 3000 })
}
const settle = (ms = 600): Promise<void> => new Promise((r) => setTimeout(r, ms))

describe('a save writes only what the page changed', () => {
  it('keeps a field another writer changed after the page loaded', async () => {
    mount('network')
    const interval = await findInput('61')
    // The API, a plugin or main changes a field this page also holds, and
    // says nothing to the renderer.
    disk = { ...disk, scope: { ...(disk.scope as object), targets: ['in.test', 'added-elsewhere.test'] } }
    fireEvent.change(interval, { target: { value: '45' } })
    await waitFor(() => expect(writes).toHaveLength(1), { timeout: 3000 })
    expect(at(disk, ['network', 'checkInterval'])).toBe(45)
    expect(at(disk, ['scope', 'targets'])).toEqual(['in.test', 'added-elsewhere.test'])
  })

  it('refuses, and says so, when the same field changed elsewhere to something else', async () => {
    mount('network')
    const interval = await findInput('61')
    disk = { ...disk, network: { ...(disk.network as object), checkInterval: 90 } }
    fireEvent.change(interval, { target: { value: '45' } })
    await failedShown()
    expect(at(disk, ['network', 'checkInterval'])).toBe(90)
    expect(inputWithValue('45')).toBeDefined()
    // Retry is the operator choosing their value over the other one.
    fireEvent.click(document.querySelector('[data-testid="settings-save-failed"] button')!)
    await waitFor(() => expect(at(disk, ['network', 'checkInterval'])).toBe(45), { timeout: 3000 })
  })

  it('is not a conflict when the other writer wrote the same value', async () => {
    mount('network')
    const interval = await findInput('61')
    disk = { ...disk, network: { ...(disk.network as object), checkInterval: 45 } }
    fireEvent.change(interval, { target: { value: '45' } })
    await settle()
    expect(document.querySelector('[data-testid="settings-save-failed"]')).toBeNull()
    expect(at(disk, ['network', 'checkInterval'])).toBe(45)
  })

  it('a save for another project is refused and nothing is written', async () => {
    mount('network')
    const interval = await findInput('61')
    disk = { ...disk, engagement: { id: 'another-project' } }
    fireEvent.change(interval, { target: { value: '45' } })
    await failedShown()
    expect(at(disk, ['network', 'checkInterval'])).toBe(61)
  })
})

// Each page with a free-text or list input: a failed save keeps what was typed
// on screen, including after leaving Settings and coming back, until a save of
// it succeeds.
const PAGES: Array<{ page: SettingsPage; edit: () => Promise<void>; shows: () => boolean; saved: () => boolean }> = [
  {
    page: 'network',
    edit: async () => { fireEvent.change(await findInput('61'), { target: { value: '45' } }) },
    shows: () => inputWithValue('45') !== undefined,
    saved: () => at(disk, ['network', 'checkInterval']) === 45
  },
  {
    page: 'scope',
    edit: async () => { fireEvent.change(await findInput('/scope/a.txt'), { target: { value: '/scope/b.txt' } }) },
    shows: () => inputWithValue('/scope/b.txt') !== undefined,
    saved: () => at(disk, ['scope', 'scopeFile']) === '/scope/b.txt'
  },
  {
    page: 'browser',
    edit: async () => { fireEvent.change(await findInput('/bin/chromium-x'), { target: { value: '/opt/chrome' } }) },
    shows: () => inputWithValue('/opt/chrome') !== undefined,
    saved: () => at(disk, ['browser', 'binary']) === '/opt/chrome'
  },
  {
    page: 'retention',
    edit: async () => { fireEvent.change(await findInput('7'), { target: { value: '30' } }) },
    shows: () => inputWithValue('30') !== undefined,
    saved: () => same(at(disk, ['retention', 'loggedTier', 'keepDays']), 30)
  },
  {
    page: 'loot',
    edit: async () => {
      const box = await waitFor(() => { const b = document.querySelector<HTMLInputElement>('[data-testid="loot-rule-aws_key"]'); expect(b?.checked).toBe(true); return b! })
      fireEvent.click(box)
    },
    shows: () => document.querySelector<HTMLInputElement>('[data-testid="loot-rule-aws_key"]')?.checked === false,
    saved: () => same(at(disk, ['loot', 'disabledRules']), ['aws_key'])
  }
]

describe('a failed save keeps the draft', () => {
  for (const { page, edit, shows, saved } of PAGES) {
    for (const mode of ['throw', 'refuse'] as const) {
      it(`${page}: kept on screen, across leaving and coming back, until it saves (${mode})`, async () => {
        const first = mount(page)
        fail = mode
        await edit()
        await failedShown()
        expect(shows()).toBe(true)
        expect(saved()).toBe(false)

        // Leave Settings and come back while main still refuses.
        first.unmount()
        await settle(50)
        mount(page)
        await waitFor(() => expect(shows()).toBe(true), { timeout: 3000 })
        expect(saved()).toBe(false)

        // Main accepts again: the kept draft is what lands.
        await failedShown()
        fail = null
        fireEvent.click(document.querySelector('[data-testid="settings-save-failed"] button')!)
        await waitFor(() => expect(saved()).toBe(true), { timeout: 3000 })
      })
    }
  }
})
