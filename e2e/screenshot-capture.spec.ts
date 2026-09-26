import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { MAIN_ENTRY, REPO_ROOT, openTestProject, makeTempHome } from './helpers'

// #116. `desktopCapturer.getSources({ types: ['screen'] })` came back empty on
// Windows 11 / Chromium 152 in a single-display session — `types: ['window']`
// returned six at the same moment — and the screenshot agent treated the empty
// list as "nothing to capture": no event, no error, capture-health still
// reading `state: "idle"`, which is also what it says before the first
// screenshot of a fresh project.
//
// The environment-level symptom did not reproduce once a second display was
// attached, so what is pinned here is the part that is RedLog's either way:
// an empty source list is a failure and has to reach capture-health. The
// condition is staged by replacing `getSources` in the main process, so the
// test does not depend on the display configuration it originally showed up in.
test('an empty screen-source list is reported, not swallowed', async () => {
  test.setTimeout(300_000)
  const tmpHome = makeTempHome('redlog-shoterr-')
  const app: ElectronApplication = await electron.launch({
    args: [MAIN_ENTRY], cwd: REPO_ROOT,
    env: { ...process.env, NODE_ENV: 'test', HOME: tmpHome, USERPROFILE: tmpHome, REDLOG_E2E: '1' }
  })
  const page: Page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  await openTestProject(page, 'shoterr')
  await page.waitForTimeout(2500)

  const base = `http://127.0.0.1:${readFileSync(join(tmpHome, '.redlog', 'api-port'), 'utf-8').trim()}`
  const token = readFileSync(join(tmpHome, '.redlog', 'api-token'), 'utf-8').trim()
  const hdr = { 'content-type': 'application/json', authorization: `Bearer ${token}` }
  const health = async (): Promise<Record<string, unknown>> =>
    fetch(`${base}/api/capture`, { headers: hdr }).then((r) => r.json())

  const before = await health()
  console.log('BEFORE lastDbError=' + JSON.stringify(before.lastDbError ?? null))

  // Stage the condition: screen enumeration comes back empty.
  await app.evaluate(async ({ desktopCapturer }) => {
    ;(desktopCapturer as unknown as { getSources: unknown }).getSources = async () => []
  })

  const r = await fetch(`${base}/api/screenshot`, { method: 'POST', headers: hdr, body: '{}' })
    .then((x) => x.json())
  console.log('API_SHOT ' + JSON.stringify(r))

  const after = await health()
  const shot = (after.sources as Array<{ id: string; state: string; lastError?: { message: string } }>)
    .find((s) => s.id === 'screenshot')
  console.log('AFTER screenshot source=' + JSON.stringify(shot))
  console.log('AFTER lastDbError=' + JSON.stringify(after.lastDbError ?? null))

  expect(r.captured).toBe(false)
  // The endpoint says why, rather than a bare `captured: false` that an
  // operator could not tell from "the screen had not changed".
  expect(String(r.error)).toContain('no screen sources')
  // The failure is marked on the source that failed, and it tips the verdict
  // amber rather than dark: a camera that cannot see the screen is not a dark
  // log, and spending that signal here teaches operators to ignore it.
  expect(shot?.state).toBe('error')
  expect(String(shot?.lastError?.message)).toContain('no screen sources')
  expect(after.verdict).not.toBe('dark')
  // `lastDbError` means evidence cannot be written at all. This is not that.
  expect(after.lastDbError).toBeUndefined()
  await app.close()
})
