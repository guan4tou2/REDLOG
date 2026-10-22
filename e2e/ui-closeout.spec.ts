import { test, expect, type ElectronApplication, type Page } from '@playwright/test'
import { launchWithTempHome, openView, resizeMainWindow } from './helpers'

// #298, on the real app. The unit tests hold each state with a mocked bridge;
// what they cannot show is that a rejection made in the MAIN process survives
// ipcRenderer.invoke and reaches the screen as the right state, and that the
// settings the operator needs are reachable in a small window at a large zoom.
//
// Faults are injected the way they happen: the main-process handler for the
// channel throws. The "healthy again" answer is a stand-in value for the retry
// — the point of the retry is the renderer's, not the database's.

interface Bridge {
  config: { get: () => Promise<{ scope: { targets: string[] } }> }
}

test.describe.serial('read failures and a small window (#298)', () => {
  let app: ElectronApplication
  let page: Page

  test.beforeAll(async () => {
    const launched = await launchWithTempHome()
    app = launched.app
    page = launched.page
    await page.evaluate(() => localStorage.setItem('redlog-locale', 'en'))
    await page.reload()
  })
  test.afterAll(async () => { if (app) await app.close() })

  async function failChannel(channel: string, message: string): Promise<void> {
    await app.evaluate(({ ipcMain }, a) => {
      ipcMain.removeHandler(a.channel)
      ipcMain.handle(a.channel, () => { throw new Error(a.message) })
    }, { channel, message })
  }
  async function answerChannel(channel: string, value: unknown): Promise<void> {
    await app.evaluate(({ ipcMain }, a) => {
      ipcMain.removeHandler(a.channel)
      ipcMain.handle(a.channel, () => a.value)
    }, { channel, value })
  }

  test('the project list: empty, failed, and retried are three different screens', async () => {
    const status = page.getByTestId('project-list-status')
    await expect(status).toHaveAttribute('data-state', 'empty')
    await expect(status).toContainText('No projects yet')

    await failChannel('project:list', 'database is locked')
    await page.reload()
    await expect(status).toHaveAttribute('data-state', 'failed')
    await expect(status).toHaveAttribute('role', 'alert')
    // Says the listing failed — not that there is nothing, and not that the
    // evidence is gone.
    await expect(status).toContainText('Your projects are still on disk')
    await expect(status).toContainText('database is locked')
    await expect(page.getByText('No projects yet')).toHaveCount(0)

    await answerChannel('project:list', [])
    await status.getByRole('button', { name: 'Retry' }).click()
    await expect(status).toHaveAttribute('data-state', 'empty')
  })

  test('search: an index that cannot be read is not reported as fully indexed', async () => {
    await page.getByPlaceholder('e.g. Client-Pentest-Q3').fill('Closeout')
    await page.getByRole('button', { name: 'Create' }).click()
    await expect(page.getByTestId('view-root')).toHaveAttribute('data-view', 'dashboard')

    await failChannel('casts:status', 'casts db locked')
    await failChannel('events:distinctAgentTypes', 'facet query failed')
    await openView(page, 'search')
    await page.getByTestId('search-input').fill('nothing-matches-this')

    const index = page.getByTestId('search-index-status')
    await expect(index).toHaveAttribute('data-kind', 'failed')
    await expect(index).toContainText('Could not check whether terminal recordings are indexed')
    await expect(index).toContainText('no match does not mean there is none')
    await expect(index).toContainText('casts db locked')

    const types = page.getByTestId('search-types-failed')
    await expect(types).toBeVisible()
    await expect(types).toContainText('Could not load the event-type filters')

    // Retry with the index answering: the warning goes, the filter note stays
    // until its own retry.
    await answerChannel('casts:status', { total: 0, indexed: 0, pending: 0 })
    await index.getByRole('button', { name: 'Retry' }).click()
    await expect(page.getByTestId('search-index-status')).toHaveCount(0)
    await expect(types).toBeVisible()

    await answerChannel('events:distinctAgentTypes', [])
    await types.getByRole('button', { name: 'Retry' }).click()
    await expect(types).toHaveCount(0)
  })

  async function openScope(): Promise<void> {
    const mod = process.platform === 'darwin' ? 'Meta' : 'Control'
    await page.keyboard.press(`${mod}+9`)
    await page.click('[data-settings-page="scope"]')
  }

  test('the scope list fields have names, take the keyboard, and say when text is only a draft', async () => {
    await openScope()
    const targets = page.getByRole('textbox', { name: /^Targets/ })
    await expect(targets).toBeVisible()

    // Keyboard only from here: focus, type, commit with Ctrl/⌘+Enter.
    await targets.focus()
    await page.keyboard.type('10.0.0.0/8')
    // A draft: said so, and tied to the field by aria-describedby.
    const draft = page.getByTestId('list-field-draft')
    await expect(draft).toContainText('Not saved yet')
    const draftId = await draft.getAttribute('id')
    expect(draftId).toBeTruthy()
    expect((await targets.getAttribute('aria-describedby'))?.split(' ')).toContain(draftId)
    // …and it is NOT in the saved config yet.
    const saved = (): Promise<string[]> =>
      page.evaluate(async () => (await (window as unknown as { redlog: Bridge }).redlog.config.get()).scope.targets)
    await page.waitForTimeout(1500) // longer than the autosave debounce
    expect(await saved()).toEqual([])

    const mod = process.platform === 'darwin' ? 'Meta' : 'Control'
    await page.keyboard.press(`${mod}+Enter`)
    await expect(page.getByRole('button', { name: /10\.0\.0\.0\/8/ })).toBeVisible()
    await expect.poll(saved).toEqual(['10.0.0.0/8'])
    await expect(draft).toHaveCount(0)

    // A rejected entry: invalid, described by the message, announced.
    await targets.focus()
    await page.keyboard.type('host:8080')
    await page.keyboard.press(`${mod}+Enter`)
    await expect(targets).toHaveAttribute('aria-invalid', 'true')
    await expect(page.getByTestId('list-field-rejected')).toContainText('host:8080')
    await expect(page.getByTestId('list-field-rejected')).toHaveAttribute('role', 'alert')
    expect(await saved()).toEqual(['10.0.0.0/8'])

    // Remove it again with the keyboard.
    const remove = page.getByRole('button', { name: /10\.0\.0\.0\/8/ })
    await remove.focus()
    await page.keyboard.press('Enter')
    await expect.poll(saved).toEqual([])
    await targets.fill('')
  })

  async function setViewport(w: number, h: number, zoom: number): Promise<void> {
    await resizeMainWindow(app, w, h)
    await app.evaluate(({ BrowserWindow }, z) => {
      const main = BrowserWindow.getAllWindows().find((x) => !x.isDestroyed() && !x.webContents.getURL().includes('overlay'))
      main?.webContents.setZoomFactor(z)
    }, zoom)
    await page.waitForTimeout(400)
  }

  // #298, the rest of the app. The per-page check below covers Settings; every
  // other view has its own toolbar, and the transcript's was the one that
  // actually clipped — its kind filters and the order/copy buttons ran off the
  // right edge at 800×600 and 150%, with no way to scroll to them.
  //
  // "Cut" here means a control the operator must reach whose box leaves the
  // viewport and which is NOT inside a horizontally scrollable region: the
  // timeline canvas is deliberately wider than the window and scrolls, so its
  // markers are reachable by scrolling and are not a defect.
  const VIEWS = ['dashboard', 'timeline', 'search', 'transcript', 'http_history', 'terminal', 'screenshots', 'targets', 'scope', 'loot', 'bookmarks']
  const VIEW_SIZES: Array<[number, number, number]> = [
    [1280, 800, 1], [800, 600, 1], [800, 600, 1.5], [800, 600, 2], [1280, 800, 2]
  ]
  for (const [w, h, zoom] of VIEW_SIZES) {
    test(`every view's controls stay inside the window at ${w}×${h}, zoom ${zoom * 100}%`, async () => {
      await setViewport(w, h, zoom)
      const cut: string[] = []
      for (const view of VIEWS) {
        const opened = await page.evaluate((v) => {
          const b = document.querySelector(`[data-view-btn="${v}"]`) as HTMLElement | null
          if (!b) return false
          b.click()
          return true
        }, view)
        if (!opened) continue
        await page.waitForTimeout(250)
        const found = await page.evaluate(() => {
          // Layout pixels, consistently.
          //
          // Three coordinate spaces are in play and they disagree: the body
          // carries `zoom: 0.9`, the shell sets its own zoomFactor, and
          // innerWidth / getBoundingClientRect / scrollWidth each report in a
          // different one. `documentElement.clientWidth` is the viewport in the
          // SAME space as getBoundingClientRect, which is the only comparison
          // that means anything. Using innerWidth understated the overflow by
          // 11% at 100% and by 100% at 200%, and using the app root's own rect
          // was worse: the root grows to fit the overflow, so everything inside
          // it looked contained.
          const vw = document.documentElement.clientWidth
          const inHorizontalScroller = (el: Element): boolean => {
            let p = el.parentElement
            while (p) {
              const ox = getComputedStyle(p).overflowX
              if (ox === 'auto' || ox === 'scroll') return true
              p = p.parentElement
            }
            return false
          }
          return [...document.querySelectorAll('button, input, select, textarea, [contenteditable]')]
            .filter((el) => {
              const r = el.getBoundingClientRect()
              if (r.width === 0 || r.height === 0) return false
              if (r.left >= -1 && r.right <= vw + 1) return false
              return !inHorizontalScroller(el)
            })
            .map((el) => `${(el.textContent || el.getAttribute('placeholder') || el.getAttribute('aria-label') || el.tagName).trim().slice(0, 24)} @${Math.round(el.getBoundingClientRect().right)} of ${vw}`)
        })
        if (found.length) cut.push(`${view}: ${found.join(', ')}`)
      }
      expect(cut, 'controls cut by the window edge').toEqual([])

      // The status bar is outside the view root and outside every view's
      // scroll container, so the loop above never measured it. At 800×600 with
      // the shell at 200% its HUD toggle sat at 405..421 in a 400px bar and was
      // swallowed by the bar's own `overflow-hidden`.
      const barCut = await page.evaluate(() => {
        const vw = document.documentElement.clientWidth
        const bar = document.querySelector('[data-testid="status-bar"]')
        if (!bar) return [`status bar missing`]
        return [...bar.querySelectorAll('button')]
          .filter((el) => {
            const r = el.getBoundingClientRect()
            return r.width > 0 && (r.left < -1 || r.right > vw + 1)
          })
          .map((el) => `${el.dataset.testid ?? el.getAttribute('aria-label') ?? 'button'} @${Math.round(el.getBoundingClientRect().right)} of ${vw}`)
      })
      expect(barCut, 'status-bar controls cut by the window edge').toEqual([])
    })
  }

  // The window sizes and zooms the issue names. "Reachable" means: scrolled
  // into view it is inside the window and nothing is drawn over its middle.
  const SIZES: Array<[number, number]> = [[1280, 800], [800, 600]]
  const ZOOMS = [1, 1.5, 2]
  for (const [w, h] of SIZES) {
    for (const zoom of ZOOMS) {
      test(`settings ▸ scope at ${w}×${h}, zoom ${zoom * 100}%: the page, and what it needs, can be reached`, async () => {
        // Open the page at the normal size — the category list is a menu when
        // the window is small, and reaching it there is not what is measured —
        // then shrink.
        await setViewport(1280, 800, 1)
        await openScope()
        await setViewport(w, h, zoom)

        const targets = page.getByRole('textbox', { name: /^Targets/ })
        await targets.scrollIntoViewIfNeeded()
        const measured = await targets.evaluate((el) => {
          const r = el.getBoundingClientRect()
          const vw = window.innerWidth
          const vh = window.innerHeight
          const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)
          return {
            vw, vh,
            left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width,
            covered: !(hit === el || (hit && el.contains(hit)))
          }
        })
        // eslint-disable-next-line no-console
        console.log(`[viewport] ${w}×${h} @${zoom * 100}%: effective ${measured.vw}×${measured.vh}, targets field ${Math.round(measured.left)}..${Math.round(measured.right)} × ${Math.round(measured.top)}..${Math.round(measured.bottom)}`)
        expect(measured.left, 'left edge').toBeGreaterThanOrEqual(0)
        expect(measured.right, 'right edge').toBeLessThanOrEqual(measured.vw + 1)
        expect(measured.top, 'top edge').toBeGreaterThanOrEqual(0)
        expect(measured.bottom, 'bottom edge').toBeLessThanOrEqual(measured.vh + 1)
        // 200px: an address like 192.168.100.0/24 and room to see it. Without
        // the narrow layout this is 145px at 800×600/150% and 15px at 200%.
        expect(measured.width, 'wide enough to type in').toBeGreaterThan(200)
        expect(measured.covered, 'something is drawn over the field').toBe(false)

        // The title bar's own actions stay inside the window: a control cut off
        // by the edge cannot be reached by scrolling.
        const cut = await page.evaluate(() => {
          const out: string[] = []
          for (const el of document.querySelectorAll<HTMLElement>('[data-testid^="titlebar-"]')) {
            const r = el.getBoundingClientRect()
            if (r.width === 0 || r.height === 0) continue
            if (r.left < 0 || r.right > window.innerWidth + 1) out.push(`${el.dataset.testid} ${Math.round(r.left)}..${Math.round(r.right)} of ${window.innerWidth}`)
          }
          return out
        })
        expect(cut, 'title bar actions cut by the window edge').toEqual([])
      })
    }
  }

})
