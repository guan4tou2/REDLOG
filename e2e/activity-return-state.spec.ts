import { test, expect } from '@playwright/test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { launchWithTempHome, openTestProject, openView } from './helpers'

// #589: leaving the activity list for the timeline and coming back must put the
// operator where they were — query, filters, which row was open and how far
// down the list they had scrolled — not at the top of a fresh list.
test('returning from the timeline keeps the activity list where it was', async () => {
  test.setTimeout(120_000)
  const { app, page, tmpHome } = await launchWithTempHome()
  try {
    await page.waitForLoadState('domcontentloaded')
    await page.evaluate(() => localStorage.setItem('redlog-locale', 'en'))
    await openTestProject(page, 'return-state')
    const base = `http://127.0.0.1:${readFileSync(join(tmpHome, '.redlog', 'api-port'), 'utf8').trim()}`
    const token = readFileSync(join(tmpHome, '.redlog', 'api-token'), 'utf8').trim()
    for (let i = 0; i < 80; i++) {
      const r = await fetch(`${base}/api/events/seed`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({ agent_type: 'shell', data: { subtype: 'command_start', command: `echo marker-${String(i).padStart(3, '0')}` } })
      })
      expect(r.ok).toBe(true)
    }

    await openView(page, 'search')
    await page.getByTestId('search-input').fill('marker')
    await expect(page.getByTestId('activity-row').nth(40)).toBeAttached()
    const results = page.getByTestId('search-results')
    await page.getByTestId('activity-row').first().click()
    await expect(page.getByTestId('activity-row').first()).toHaveAttribute('aria-expanded', 'true')
    await results.evaluate((el) => { el.scrollTop = 900 })
    const before = await results.evaluate((el) => el.scrollTop)
    expect(before).toBeGreaterThan(300)

    await page.getByTestId('workspace-open-timeline').click()
    await expect(page.locator('[data-testid="view-root"]')).toHaveAttribute('data-view', 'timeline')
    await page.getByRole('button', { name: /^← / }).click()
    await expect(page.locator('[data-testid="view-root"]')).toHaveAttribute('data-view', 'search')

    await expect(page.getByTestId('search-input')).toHaveValue('marker')
    await expect(page.getByTestId('activity-row').first()).toHaveAttribute('aria-expanded', 'true')
    const after = await results.evaluate((el) => el.scrollTop)
    expect(Math.abs(after - before), `scrollTop ${before} → ${after}`).toBeLessThan(4)
  } finally {
    await app.close()
  }
})

async function seedShell(base: string, token: string, prefix: string, n: number): Promise<void> {
  for (let i = 0; i < n; i++) {
    const r = await fetch(`${base}/api/events/seed`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ agent_type: 'shell', data: { subtype: 'command_start', command: `echo ${prefix}-${i}` } })
    })
    expect(r.ok).toBe(true)
  }
}

// The open Reader is part of "where the operator was": locating from it and
// coming back must reopen it on the same query with the same row expanded, and
// the timeline must have selected the event the Reader was showing.
test('locating from the Reader and returning restores the Reader, query and open row', async () => {
  test.setTimeout(120_000)
  const { app, page, tmpHome } = await launchWithTempHome()
  try {
    await page.waitForLoadState('domcontentloaded')
    await page.evaluate(() => localStorage.setItem('redlog-locale', 'en'))
    await openTestProject(page, 'reader-return')
    const base = `http://127.0.0.1:${readFileSync(join(tmpHome, '.redlog', 'api-port'), 'utf8').trim()}`
    const token = readFileSync(join(tmpHome, '.redlog', 'api-token'), 'utf8').trim()
    await seedShell(base, token, 'marker', 12)

    await openView(page, 'search')
    await page.getByTestId('search-input').fill('marker')
    await page.getByTestId('activity-row').nth(3).click()
    await page.getByTestId('activity-read').first().click()
    await expect(page.getByTestId('activity-reader')).toBeVisible()

    await page.getByTestId('reader-locate').click()
    await expect(page.locator('[data-testid="view-root"]')).toHaveAttribute('data-view', 'timeline')
    await expect(page.getByTestId('timeline-detail-panel')).toHaveCount(1)
    const selected = await page.evaluate(() => localStorage.getItem('redlog-timeline-focus-event'))
    expect(selected, 'the timeline selected a concrete event').toBeTruthy()

    await page.getByRole('button', { name: /^← / }).click()
    await expect(page.locator('[data-testid="view-root"]')).toHaveAttribute('data-view', 'search')
    await expect(page.getByTestId('activity-reader')).toBeVisible()
    await expect(page.getByTestId('search-input')).toHaveValue('marker')
    await expect(page.locator('[data-testid="activity-row"][aria-expanded="true"]')).toHaveCount(1)
    expect(await page.evaluate(() => localStorage.getItem('redlog-timeline-focus-event'))).toBe(selected)
  } finally {
    await app.close()
  }
})

// The selected-event id is one global key, so what protects project B from
// project A's selection is that the id simply matches nothing there. Pin that:
// after switching, B's timeline opens no detail pane, the Activity page starts
// with no query and no Reader.
test('switching project does not carry the selected event or the reading context over', async () => {
  test.setTimeout(120_000)
  const { app, page, tmpHome } = await launchWithTempHome()
  try {
    await page.waitForLoadState('domcontentloaded')
    await page.evaluate(() => localStorage.setItem('redlog-locale', 'en'))
    await openTestProject(page, 'switch-a')
    const base = `http://127.0.0.1:${readFileSync(join(tmpHome, '.redlog', 'api-port'), 'utf8').trim()}`
    const token = readFileSync(join(tmpHome, '.redlog', 'api-token'), 'utf8').trim()
    await seedShell(base, token, 'marker', 8)

    await openView(page, 'search')
    await page.getByTestId('search-input').fill('marker')
    await page.getByTestId('activity-row').first().click()
    await page.getByTestId('activity-read').first().click()
    await page.getByTestId('reader-locate').click()
    await expect(page.getByTestId('timeline-detail-panel')).toHaveCount(1)

    await page.evaluate(async () => {
      const bridge = (window as unknown as { redlog: { project: { create: (n: string) => Promise<{ id: string }>; open: (id: string) => Promise<unknown> } } }).redlog
      const created = await bridge.project.create('switch-b')
      await bridge.project.open(created.id)
    })
    await page.reload()
    await page.waitForSelector('[data-testid="view-root"]')
    // The API's port and token belong to the open project; read them again.
    const baseB = `http://127.0.0.1:${readFileSync(join(tmpHome, '.redlog', 'api-port'), 'utf8').trim()}`
    const tokenB = readFileSync(join(tmpHome, '.redlog', 'api-token'), 'utf8').trim()
    await seedShell(baseB, tokenB, 'other', 5)

    await openView(page, 'timeline')
    await expect(page.getByTestId('timeline-range-status')).toBeVisible()
    await expect(page.getByTestId('timeline-detail-panel')).toHaveCount(0)
    await openView(page, 'search')
    await expect(page.getByTestId('activity-reader')).toHaveCount(0)
    await expect(page.getByTestId('search-input')).toHaveValue('')
    // B really has events (this is not an empty-project pass).
    await page.getByTestId('search-input').fill('other')
    await expect(page.getByTestId('activity-row').first()).toBeVisible()

  } finally {
    await app.close()
  }
})

// Stitch 06: the route runs both ways. Opening a Timeline event in the activity
// log must leave a way back, and that way back must land on the same event —
// the Timeline is not kept mounted, so it is re-focused, not merely re-shown.
test('opening a timeline event in the activity log returns to the same event', async () => {
  test.setTimeout(120_000)
  const { app, page, tmpHome } = await launchWithTempHome()
  try {
    await page.waitForLoadState('domcontentloaded')
    await page.evaluate(() => localStorage.setItem('redlog-locale', 'en'))
    await openTestProject(page, 'timeline-to-activity')
    const base = `http://127.0.0.1:${readFileSync(join(tmpHome, '.redlog', 'api-port'), 'utf8').trim()}`
    const token = readFileSync(join(tmpHome, '.redlog', 'api-token'), 'utf8').trim()
    await seedShell(base, token, 'roundtrip', 6)

    await openView(page, 'timeline')
    await page.getByRole('button', { name: /roundtrip-3/ }).first().click()
    await expect(page.getByTestId('timeline-detail-panel')).toContainText('roundtrip-3')
    const selected = await page.evaluate(() => localStorage.getItem('redlog-timeline-focus-event'))
    expect(selected, 'the timeline selected a concrete event').toBeTruthy()

    await page.getByTestId('detail-open-activity').click()
    await expect(page.locator('[data-testid="view-root"]')).toHaveAttribute('data-view', 'search')
    await expect(page.getByTestId('search-input')).toHaveValue(`event:${selected}`)
    await expect(page.getByTestId('activity-row').first()).toBeVisible()

    await page.getByTestId('activity-return').getByRole('button').click()
    await expect(page.locator('[data-testid="view-root"]')).toHaveAttribute('data-view', 'timeline')
    await expect(page.getByTestId('timeline-detail-panel')).toContainText('roundtrip-3')
    expect(await page.evaluate(() => localStorage.getItem('redlog-timeline-focus-event'))).toBe(selected)
    await expect(page.getByTestId('activity-return')).toHaveCount(0)
  } catch (e) {
    console.log(`[DBG] ${(e as Error).message.split('\n').slice(0, 5).join(' | ')}`)
    throw e
  } finally {
    await app.close()
  }
})
