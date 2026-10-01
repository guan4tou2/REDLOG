import { test, expect, type ElectronApplication, type Page } from '@playwright/test'
import { launchWithTempHome, openTestProject, openView, openSettingsPage } from './helpers'

// The "native desktop feel" work (PR #17) made the app's chrome behave like a
// desktop app rather than a web page: dragging across the sidebar, the status
// bar or the tab strip no longer paints everything blue, while content an
// operator needs to copy stays selectable.
//
// It shipped with the rule written down and never checked in a running app —
// the session that built it ended blocked on being able to launch one. This
// spec is the objective half of what that session listed as outstanding: the
// selection boundary is a computed style, so it can be measured rather than
// squinted at. (Native OS context menus, the other two items, are outside
// what Playwright can see and still need a human on each platform.)
//
// It also guards a boundary that moved afterwards. The export control (§10)
// now lives in the title bar, which is both `select-none` chrome and a
// `-webkit-app-region: drag` surface — and a button inside a drag region is
// decoration, because the OS takes the mousedown to move the window.

let app: ElectronApplication
let page: Page

test.beforeAll(async () => {
  const launched = await launchWithTempHome()
  app = launched.app
  page = launched.page
  await openTestProject(page, 'chrome-selection')
})

test.afterAll(async () => { await app?.close() })

/** Resolved `user-select` for the first element matching a selector. */
async function userSelect(sel: string): Promise<string | null> {
  return page.evaluate((s) => {
    const el = document.querySelector(s)
    if (!el) return null
    return getComputedStyle(el).userSelect || getComputedStyle(el).webkitUserSelect
  }, sel)
}

async function appRegion(sel: string): Promise<string | null> {
  return page.evaluate((s) => {
    const el = document.querySelector(s)
    if (!el) return null
    return getComputedStyle(el).getPropertyValue('-webkit-app-region').trim()
  }, sel)
}

test.describe('chrome is not selectable, content is', () => {
  test('dragging across the sidebar does not select its labels', async () => {
    expect(await userSelect('[data-view-btn="timeline"]')).toBe('none')
  })

  test('the title bar does not select', async () => {
    // It is a drag surface. Text that highlights while you are moving the
    // window is the single most obvious "this is a web page" tell.
    const region = await appRegion('.h-10')
    expect(region).toBe('drag')
    expect(await userSelect('.h-10')).toBe('none')
  })

  test('the version string stays copyable, wherever it lives', async () => {
    // It used to sit in the title bar, where staying selectable was a
    // deliberate exception to the chrome rule. It moved to Settings ▸ About:
    // read once, pressed never, and it was taking a slot on the strip that
    // holds the evidence verbs. The guarantee did not move with it — a bug
    // report still starts with somebody copying this — so it is asserted
    // where the version now is.
    await openView(page, 'settings')
    await openSettingsPage(page, 'about')
    const sel = await page.evaluate(() => {
      const el = [...document.querySelectorAll('p')].find((p) => /v\d/.test(p.textContent ?? ''))
      if (!el) return null
      return { text: el.textContent ?? '', userSelect: getComputedStyle(el).userSelect }
    })
    expect(sel, 'no version on the About page').not.toBeNull()
    expect(sel!.text).toMatch(/v\d/)
    expect(sel!.userSelect).toBe('text')
    // Leave the app where this test found it: the cases below are about the
    // chrome, and they should not inherit a settings view from this one.
    await openView(page, 'dashboard')
  })

  test('the export control is reachable, not decoration behind a drag region', async () => {
    // §10 put one export control in the title bar. Inside a drag region the
    // OS takes the mousedown to move the window and the click never lands —
    // the button would look right and do nothing.
    const btn = page.locator('[aria-haspopup="menu"]').first()
    await expect(btn).toBeVisible()

    // `-webkit-app-region` does not inherit — its initial value is `none`, and
    // the drag surface is resolved by hit-testing the region boxes, not by
    // reading the computed style of the element under the cursor. So the
    // question is which region the button sits inside, which means walking up.
    const region = await btn.evaluate((el) => {
      for (let n: HTMLElement | null = el as HTMLElement; n; n = n.parentElement) {
        const v = getComputedStyle(n).getPropertyValue('-webkit-app-region').trim()
        if (v === 'drag' || v === 'no-drag') return v
      }
      return 'none'
    })
    expect(region).toBe('no-drag')

    await btn.click()
    await expect(page.locator('[role="menu"]')).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(page.locator('[role="menu"]')).toHaveCount(0)
  })

  test('timeline content selects', async () => {
    await openView(page, 'timeline')
    expect(await userSelect('[data-testid="view-root"]')).toBe('text')
  })

  test('overlays outside the view root select too', async () => {
    // Toasts routinely carry the error message going into a report, and
    // confirm dialogs carry the exact path or session name. They render
    // outside the view root, so they needed the exception spelled out; the
    // failure mode is silent, because a dialog you cannot select looks
    // completely normal until you try.
    const containers = await page.evaluate(() =>
      [...document.querySelectorAll('.select-text')].length
    )
    expect(containers, 'no select-text opt-outs found at all').toBeGreaterThan(0)
  })
})
