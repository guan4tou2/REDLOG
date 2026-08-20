import { test, expect, _electron as electron } from '@playwright/test'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MAIN_ENTRY, REPO_ROOT, openTestProject, openView } from './helpers'

// v0.11.1: the track renders only the clusters near the viewport.
//
// Every cluster across the whole track used to be in the DOM regardless of
// where the operator was looking — at max zoom that is a 12000px track behind
// a ~1200px window, so roughly 90% of the nodes existed only to be scrolled
// past. Measured here: 400 nodes before, 50 after, for the same 13200px track.
//
// Verified discriminating: disabling the filter puts all 400 back and this
// test fails.
test('the track renders only the clusters near the viewport', async () => {
  test.setTimeout(300_000)
  const tmpHome = mkdtempSync(join(tmpdir(), 'redlog-virt-'))
  const app = await electron.launch({ args: [MAIN_ENTRY], cwd: REPO_ROOT,
    env: { ...process.env, NODE_ENV: 'test', HOME: tmpHome, USERPROFILE: tmpHome, REDLOG_E2E: '1' } })
  const page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  await page.evaluate(() => localStorage.setItem('redlog-locale', 'en'))
  await openTestProject(page, 'virt')
  await page.waitForTimeout(1500)
  const base = `http://127.0.0.1:${readFileSync(join(tmpHome, '.redlog', 'api-port'), 'utf-8').trim()}`
  const token = readFileSync(join(tmpHome, '.redlog', 'api-token'), 'utf-8').trim()

  // Spread over an hour so clusters do not all collapse into one bucket.
  const now = Date.now()
  for (let i = 0; i < 600; i++) {
    await fetch(`${base}/api/events`, { method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      // markers, because displayTs honours `atTimestamp` only for them —
      // shell events all land at server Date.now() and collapse into one bucket
      body: JSON.stringify({ agent_type: 'marker',
        data: { title: `m${i}`, severity: 'info', atTimestamp: now - (600 - i) * 6000 } }) })
  }
  await page.waitForTimeout(2500)
  await app.evaluate(async ({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0]?.setSize(1400, 950) })
  await openView(page, 'timeline')
  await page.waitForTimeout(1500)
  // Zoom in hard so the track is far wider than the window.
  // Zoom is persisted; set it and reload rather than synthesising 40 wheel
  // events and hoping the anchor handshake settles where we want.
  await page.evaluate(() => localStorage.setItem('redlog-timeline-zoom', '6'))
  await page.reload()
  await page.waitForTimeout(2500)
  await openView(page, 'timeline')
  await page.waitForTimeout(1800)

  const m = await page.evaluate(() => {
    const scroll = document.querySelector('div.cursor-grab') as HTMLElement
    const track = scroll.firstElementChild as HTMLElement
    return {
      trackW: Math.round(track.getBoundingClientRect().width),
      viewportW: scroll.clientWidth,
      domDots: document.querySelectorAll('[data-timeline-event]').length,
      scrollLeft: scroll.scrollLeft
    }
  })
  console.log('VIRT:', JSON.stringify(m))
  expect(m.trackW, 'zoom did not widen the track').toBeGreaterThan(m.viewportW * 2)
  // With the track several screens wide, only the on-screen window plus one
  // screen either side should be in the DOM.
  const maxExpected = Math.ceil((m.viewportW * 3) / 14) + 20
  expect(m.domDots, `${m.domDots} dots in the DOM for a ${m.trackW}px track`).toBeLessThan(maxExpected)
  await app.close()
})
