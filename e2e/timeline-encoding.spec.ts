import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MAIN_ENTRY, REPO_ROOT, openTestProject, openView } from './helpers'

// v0.11.4 (AUDIT V1/V2/V3): what the track says without being clicked.
//
// Severity and scope violations had no visual encoding at all. A `critical`
// marker rendered identically to an `info` one — severity was a text prefix
// inside the title — and a scope violation was distinguished only by its lane,
// in a red byte-identical to the marker lane's. Meanwhile chain integrity,
// which is rare and already announced by a banner, had a badge, a ring and a
// red band.
//
// Encoded as SHAPE rather than more colour: eighteen lane hues are past
// reliable discrimination, and shape survives a colour-blind operator and a
// glance at the far edge of the screen.
//
// The "no two lanes share a colour" invariant lives in
// test/lane-colours.test.ts — it is a property of a constant, and empty lanes
// auto-collapse so the DOM never shows all eighteen at once.

let app: ElectronApplication
let page: Page

const dots = (p: Page): Promise<Array<{ title: string; radius: string; rotated: boolean; filled: boolean; width: number }>> =>
  p.evaluate(() => Array.from(document.querySelectorAll('[data-timeline-event]')).map((el) => {
    const inner = el.firstElementChild as HTMLElement
    const cs = getComputedStyle(inner)
    return {
      title: (el as HTMLElement).title,
      radius: cs.borderRadius,
      rotated: cs.transform !== 'none',
      filled: cs.backgroundColor !== 'rgba(0, 0, 0, 0)',
      width: Math.round(parseFloat(cs.width))
    }
  }))

test.describe.serial('timeline visual encoding', () => {
  test.beforeAll(async () => {
    const tmpHome = mkdtempSync(join(tmpdir(), 'redlog-enc-'))
    app = await electron.launch({ args: [MAIN_ENTRY], cwd: REPO_ROOT,
      env: { ...process.env, NODE_ENV: 'test', HOME: tmpHome, USERPROFILE: tmpHome, REDLOG_E2E: '1' } })
    page = await app.firstWindow()
    await page.waitForLoadState('domcontentloaded')
    await page.evaluate(() => localStorage.setItem('redlog-locale', 'en'))
    await openTestProject(page, 'encoding')
    await page.waitForTimeout(1500)
    const base = `http://127.0.0.1:${readFileSync(join(tmpHome, '.redlog', 'api-port'), 'utf-8').trim()}`
    const token = readFileSync(join(tmpHome, '.redlog', 'api-token'), 'utf-8').trim()
    const post = (agent_type: string, data: Record<string, unknown>): Promise<Response> =>
      fetch(`${base}/api/events`, { method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({ agent_type, data }) })
    // Spread the markers in time. Posted back-to-back they land in the same
    // 14px cluster bucket and render as one counted node, which would test the
    // clustering rather than the severity encoding. `atTimestamp` is honoured
    // by displayTs for markers, and the domain follows displayTs since v0.9.4.
    const now = Date.now()
    await post('shell', { subtype: 'command_end', command: 'id', exit_code: 0 })
    await post('marker', { title: 'info mark', severity: 'info', atTimestamp: now - 40 * 60_000 })
    await post('marker', { title: 'important mark', severity: 'important', atTimestamp: now - 25 * 60_000 })
    await post('marker', { title: 'CRITICAL mark', severity: 'critical', atTimestamp: now - 10 * 60_000 })
    await post('system', { subtype: 'scope_violation', description: 'out of scope: evil.example' })
    await page.waitForTimeout(2000)
    await app.evaluate(async ({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0]?.setSize(1500, 1000) })
    // Zoom out so the whole span is on screen — the track only renders what is
    // near the viewport since v0.11.1.
    await page.evaluate(() => localStorage.setItem('redlog-timeline-zoom', '0.25'))
    await page.reload()
    await page.waitForTimeout(2500)
    await openView(page, 'timeline')
    await page.waitForTimeout(2000)
  })

  test.afterAll(async () => { if (app) await app.close() })

  test('a scope violation is a diamond, not another red circle', async () => {
    const d = (await dots(page)).find((x) => /scope violation/i.test(x.title))
    expect(d, 'the scope violation did not render').toBeTruthy()
    // Diamond = a slightly-rounded square, rotated 45°.
    expect(d!.rotated, 'must be rotated into a diamond').toBe(true)
    expect(d!.radius).not.toBe('50%')
    expect(d!.width, 'and drawn larger than an ordinary dot').toBeGreaterThan(9)
  })

  test('marker severity changes the mark; info stays an ordinary dot', async () => {
    const all = await dots(page)
    const info = all.find((x) => /info mark/.test(x.title))
    const important = all.find((x) => /important mark/.test(x.title))
    const critical = all.find((x) => /CRITICAL mark/.test(x.title))
    expect([info, important, critical].every(Boolean), 'all three markers should render').toBe(true)

    expect(info!.radius, 'info is a plain circle').toBe('50%')
    expect(info!.filled).toBe(true)
    expect(info!.width).toBe(9)

    expect(important!.width, 'important is larger than info').toBeGreaterThan(info!.width)
    expect(important!.filled).toBe(true)

    // Critical reads as an outline — the strongest signal available without
    // inventing another colour.
    expect(critical!.filled, 'critical is hollow').toBe(false)
    expect(critical!.width, 'critical is the largest').toBeGreaterThan(important!.width)
  })

  test('the tooltip names the emphasis, so shape is not the only channel', async () => {
    const all = await dots(page)
    expect(all.find((x) => /CRITICAL mark/.test(x.title))!.title).toMatch(/critical/i)
    expect(all.find((x) => /scope violation/i.test(x.title))!.title).toMatch(/out of scope/i)
  })

})
