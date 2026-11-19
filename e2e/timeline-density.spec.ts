import { test, expect, type Page } from '@playwright/test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { launchWithTempHome, openTestProject, openView, resizeMainWindow, timelineMode } from './helpers'

// The Timeline's control density (owner, 2026-11-14). At the smallest window
// the app allows (800x500, windows.ts) ten strips used to stand above the
// event list and leave it about three rows. One toolbar row replaced two, the
// caption, legend and hint rows went, and the attribution warning became a
// toolbar status. What is asserted here is what a person sees:
//   1. at 800x500 the rail and at least three event cards are fully on screen
//      without scrolling;
//   2. at 1280x800 the toolbar is one row of controls;
//   3. at both, the attribution status shows while its condition holds.
//
// Geometry: the card check compares bounding rects with bounding rects, the
// row check offsetHeight with offsetHeight. The body renders at zoom 0.9, and
// mixing the two families scales one side by it (CLAUDE.md).

/** Cards whose whole box lies inside the rail's scroller and the view, with
 *  nothing scrolled. Bounding rects on both sides of every comparison. */
async function cardsFullyVisible(page: Page): Promise<{ visible: number; cards: number; scrolled: number }> {
  return page.evaluate(() => {
    const cards = Array.from(document.querySelectorAll('[data-testid="rail-card"]')) as HTMLElement[]
    const root = document.querySelector('[data-testid="view-root"]') as HTMLElement
    let scroller: HTMLElement | null = cards[0]?.parentElement ?? null
    while (scroller && !/(auto|scroll)/.test(getComputedStyle(scroller).overflowY)) scroller = scroller.parentElement
    if (!scroller || !root) return { visible: 0, cards: cards.length, scrolled: -1 }
    const box = scroller.getBoundingClientRect()
    const view = root.getBoundingClientRect()
    const visible = cards.filter((c) => {
      const r = c.getBoundingClientRect()
      return r.height > 0 && r.top >= box.top - 0.5 && r.bottom <= box.bottom + 0.5 && r.bottom <= view.bottom + 0.5
    }).length
    return { visible, cards: cards.length, scrolled: scroller.scrollTop + (document.scrollingElement?.scrollTop ?? 0) }
  })
}

/** The toolbar row's height and one control's, both offsetHeight (CSS px). */
async function toolbarRow(page: Page): Promise<{ row: number; control: number }> {
  return page.evaluate(() => {
    const row = document.querySelector('[data-testid="timeline-toolbar-row"]') as HTMLElement
    const control = row.querySelector('[role="group"]') as HTMLElement
    return { row: row.offsetHeight, control: control.offsetHeight }
  })
}

function eventSeeder(tmpHome: string): (agent_type: string, data: Record<string, unknown>) => Promise<void> {
  const base = `http://127.0.0.1:${readFileSync(join(tmpHome, '.redlog', 'api-port'), 'utf-8').trim()}`
  const token = readFileSync(join(tmpHome, '.redlog', 'api-token'), 'utf-8').trim()
  return async (agent_type, data) => {
    const r = await fetch(`${base}/api/events/seed`, {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ agent_type, data }) })
    expect(r.ok, `${agent_type} ${String(data.subtype ?? '')}`).toBe(true)
  }
}

test('timeline-density: the list keeps its rows at 800x500, the toolbar is one row, the attribution status shows', async () => {
  test.setTimeout(180_000)
  const { app, page, tmpHome } = await launchWithTempHome()
  try {
    await page.evaluate(() => localStorage.setItem('redlog-locale', 'zh-TW'))
    await page.reload()
    await openTestProject(page, 'timeline-density')
    await page.waitForTimeout(1200)

    const post = eventSeeder(tmpHome)
    const at = (minutesAgo: number): number => Date.now() - minutesAgo * 60_000
    // Fourteen rows over half an hour, several types.
    await post('shell', { subtype: 'command_start', command: 'nmap -sV 10.0.0.5', source_timestamp: at(30) })
    await post('shell', { subtype: 'command_end', command: 'nmap -sV 10.0.0.5', exit_code: 0, duration_sec: 42, source_timestamp: at(29) })
    await post('shell', { subtype: 'command_end', command: 'whoami', exit_code: 0, source_timestamp: at(26) })
    await post('shell', { subtype: 'command_end', command: 'id', exit_code: 0, source_timestamp: at(24) })
    await post('agent', { subtype: 'user_message', agent: 'claude-code', session_id: 'density', full: 'enumerate the web app', source_timestamp: at(22) })
    await post('agent', { subtype: 'assistant_message', agent: 'claude-code', session_id: 'density', full: 'Starting with the login form.', source_timestamp: at(21) })
    await post('marker', { title: 'foothold', severity: 'info', source_timestamp: at(19) })
    await post('shell', { subtype: 'command_end', command: 'curl -s https://app.example/', exit_code: 0, source_timestamp: at(17) })
    await post('dns', { subtype: 'query', query: 'app.example', source_timestamp: at(15) })
    await post('marker', { title: 'creds found', severity: 'high', source_timestamp: at(12) })
    await post('shell', { subtype: 'command_end', command: 'ls -la /var/www', exit_code: 0, source_timestamp: at(9) })
    await post('shell', { subtype: 'command_end', command: 'cat config.php', exit_code: 1, source_timestamp: at(6) })
    await post('marker', { title: 'wrap', severity: 'info', source_timestamp: at(3) })
    // One traffic event with no pid and no source address: the join is asked
    // and answers nothing (attempted > 0, resolved === 0), which is the
    // condition the attribution status shows under. Nothing in an e2e run
    // records a hooked command_start for it to resolve against.
    await post('scanner', { subtype: 'connection', proto: 'tcp', remote_addr: '10.10.11.24', remote_port: 445, detectedTarget: '10.10.11.24' })
    await page.waitForTimeout(1500)

    await openView(page, 'timeline')
    expect(await timelineMode(page)).toBe('standard')
    await expect(page.getByTestId('rail-card').first()).toBeVisible()

    // (1) + (3) at the minimum window.
    await resizeMainWindow(app, 800, 500)
    await page.waitForTimeout(600)
    await expect(page.getByTestId('timeline-standard-track')).toBeInViewport()
    const small = await cardsFullyVisible(page)
    expect(small.scrolled, 'nothing may be scrolled to reach the rows').toBe(0)
    expect(small.visible, `cards fully visible at 800x500: ${small.visible} of ${small.cards}`).toBeGreaterThanOrEqual(3)
    const status = page.getByTestId('timeline-attribution-status')
    await expect(status).toBeVisible()
    await expect(status).toBeInViewport()
    await expect(status).toHaveAttribute('role', 'status')

    // (2) + (3) at a common laptop size.
    await resizeMainWindow(app, 1280, 800)
    await page.waitForTimeout(600)
    const row = await toolbarRow(page)
    // One row is one control tall; a second line would add at least another
    // control and the row gap.
    expect(row.row, `toolbar row ${row.row}px for a ${row.control}px control`).toBeLessThan(row.control * 1.5)
    await expect(status).toBeVisible()
    await expect(status).toBeInViewport()
  } catch (e) {
    console.log(`[DBG] ${(e as Error).message.split('\n').slice(0, 5).join(' | ')}`)
    throw e
  } finally {
    await app.close()
  }
})

test('timeline-density: bottom detail fits at 900x600 and 800x500 before and after a drag', async () => {
  test.setTimeout(180_000)
  const { app, page, tmpHome } = await launchWithTempHome()
  try {
    await page.evaluate(() => localStorage.setItem('redlog-locale', 'zh-TW'))
    await page.reload()
    await openTestProject(page, 'timeline-detail-density')
    const post = eventSeeder(tmpHome)
    const start = Date.now() - 30 * 60_000
    // Keep a short card above the command, whose selected preview grows.
    await post('marker', { title: 'Layout fixture', severity: 'info', source_timestamp: start - 60_000 })
    await post('shell', {
      subtype: 'command_end', command: 'printf "detail fixture"', exit_code: 0, duration_sec: 1,
      stdout: 'Timeline detail fixture\n'.repeat(24), source_timestamp: start
    })
    const command = { command: 'printf "terminal row"', command_id: 'detail-row', terminalId: 'detail-terminal', shell: 'zsh' }
    await post('shell', { ...command, subtype: 'command_start', source_timestamp: start + 60_000 })
    await post('shell', { ...command, subtype: 'command_end', exit_code: 0, source_timestamp: start + 61_000 })
    await openView(page, 'timeline')
    expect(await timelineMode(page)).toBe('standard')

    const win = await app.browserWindow(page)
    const resize = async (width: number, height: number): Promise<void> => {
      await resizeMainWindow(app, width, height)
      const contentSize = await win.evaluate((w) => w.getContentSize())
      await expect.poll(() => page.evaluate(() => [innerWidth, innerHeight])).toEqual(contentSize)
    }
    const detail = page.getByTestId('timeline-detail-body')
    const bar = page.getByTestId('timeline-detail-panel')
    const handle = page.getByTestId('timeline-detail-resize')
    const check = async (width: number, height: number, mode: string): Promise<void> => {
      const label = `${mode} at ${width}x${height}`
      await resize(width, height)
      await expect(page.getByTestId('timeline-split')).toHaveAttribute('data-layout', 'bottom')
      await expect(bar, label).toBeVisible()
      await expect(bar, label).toBeInViewport({ ratio: 1 })
      await expect.poll(() => page.evaluate(() => {
        const rect = (id: string): DOMRect =>
          document.querySelector(`[data-testid="${id}"]`)!.getBoundingClientRect()
        const offsets = {
          barBelowHandle: rect('timeline-detail-panel').bottom - rect('timeline-detail-resize').top,
          listBelowBar: rect('timeline-event-list').bottom - rect('timeline-detail-panel').top,
          bodyBelowSplit: rect('timeline-detail-body').bottom - rect('timeline-split').bottom,
          headerBelowBody: rect('timeline-detail-header').bottom - rect('timeline-detail-body').bottom
        }
        return Object.entries(offsets).filter(([, overlap]) => overlap > 0.5)
      }), label).toEqual([])
      await expect.poll(async () => (await cardsFullyVisible(page)).visible, label).toBeGreaterThanOrEqual(1)
    }

    await resize(900, 600)
    await page.getByTestId('rail-card').nth(1).click()
    await page.getByTestId('detail-toggle-body').click()
    await expect(detail).toBeVisible()
    await check(900, 600, 'default height')
    await check(800, 500, 'default height')

    await resize(1440, 900)
    const before = (await detail.boundingBox())!.height
    const strip = (await handle.boundingBox())!
    await page.mouse.move(strip.x + strip.width / 2, strip.y + strip.height / 2)
    await page.mouse.down()
    await page.mouse.move(strip.x + strip.width / 2, strip.y - 240, { steps: 8 })
    await page.mouse.up()
    await expect.poll(async () => (await detail.boundingBox())!.height).toBeGreaterThan(before)
    await expect.poll(() => page.evaluate(() => localStorage.getItem('redlog-timeline-detail-h'))).not.toBeNull()
    await check(900, 600, 'dragged height')
    await check(800, 500, 'dragged height')
  } catch (e) {
    console.log(`[DBG] timeline bottom detail: ${(e as Error).message.split('\n').slice(0, 5).join(' | ')}`)
    throw e
  } finally {
    await app.close()
  }
})
