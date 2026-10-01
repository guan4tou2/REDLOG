import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { MAIN_ENTRY, REPO_ROOT, makeTempHome, openTestProject, openView } from './helpers'

// The "nothing folded under a command" warning names a remedy, and the remedy
// is not the same on the three platforms. It shipped naming only two of them:
// a Windows operator was told to go install `ss` or `lsof` — neither of which
// Windows uses, and neither of which was the problem, because `netstat -no`
// is always present and the missing half there is pid → command.
//
// What this spec can pin and what it cannot:
//
// A run happens on ONE host, so it cannot see all three strings at once —
// `blindCauseKey` is chosen at module scope from the preload's `platform`, and
// nothing a test can do from the renderer changes what the OS reports. So it
// pins the two halves that actually broke, on whichever host is running:
//
//   - this platform's remedy IS the one on screen, and
//   - no other platform's remedy is, which is the bug as it was reported.
//
// CI runs e2e on ubuntu, so the linux branch is the one that gets checked
// there; the win32 branch is checked by whoever runs this on Windows, which
// is where it was found. Both locales are asserted, because `t()` falls back
// to English on a missing key — a zh-TW translation could go missing and the
// line would still read fine in an English-locale test.

let app: ElectronApplication
let page: Page
let tmpHome: string

type Locale = 'en' | 'zh-TW'

const PLATFORM_KEYS = {
  win32: 'timeline.fold.blind.win32',
  darwin: 'timeline.fold.blind.darwin',
  linux: 'timeline.fold.blind.linux'
} as const

type PlatformKey = keyof typeof PLATFORM_KEYS

/** The platform this host is, as the renderer's `lib/platform` decides it:
 *  only `darwin` is a Mac, only `win32` is Windows, everything else is the
 *  linux branch (a BSD gets the `ss` line; that is the existing contract). */
const hostPlatform: PlatformKey =
  process.platform === 'win32' ? 'win32' : process.platform === 'darwin' ? 'darwin' : 'linux'

function strings(locale: Locale): Record<string, string> {
  const file = join(REPO_ROOT, 'src', 'renderer', 'src', 'i18n', `${locale}.json`)
  const parsed = JSON.parse(readFileSync(file, 'utf-8')) as Record<string, string>
  // Read from the catalogue rather than copied into the spec: the wording is
  // allowed to change, naming the wrong platform is not. A missing key would
  // otherwise assert `undefined` against the line and pass.
  for (const key of ['timeline.fold.blind', ...Object.values(PLATFORM_KEYS)]) {
    expect(parsed[key], `${locale}.json is missing ${key}`).toBeTruthy()
  }
  return parsed
}

/** Set the locale and get back to a mounted Timeline: `detectLocale()` reads
 *  localStorage once on mount, so the switch needs a reload, and a reload
 *  lands on the dashboard.
 *
 *  The settle after `reload()` is not padding. The dashboard mounts the
 *  built-in terminal, so a reload tears a pty down and spawns another; on
 *  Windows, clicking into the sidebar while that is in flight took the whole
 *  app down with it — reported here as `page.click: Target page, context or
 *  browser has been closed` and an exit code of 0, which names nothing. */
async function showTimelineIn(locale: Locale): Promise<void> {
  await page.evaluate((l) => localStorage.setItem('redlog-locale', l), locale)
  await page.reload()
  await page.waitForLoadState('domcontentloaded')
  await page.waitForTimeout(1500)
  await openView(page, 'timeline')
}

test.describe.serial('attribution-blind copy names this platform', () => {
  test.beforeAll(async () => {
    tmpHome = makeTempHome('redlog-blind-copy-')
    app = await electron.launch({ args: [MAIN_ENTRY], cwd: REPO_ROOT,
      env: { ...process.env, NODE_ENV: 'test', HOME: tmpHome, USERPROFILE: tmpHome, REDLOG_E2E: '1' } })
    page = await app.firstWindow()
    await page.waitForLoadState('domcontentloaded')
    await page.evaluate(() => localStorage.setItem('redlog-locale', 'en'))
    await openTestProject(page, 'blind-copy')
    await page.waitForTimeout(1500)

    // The line appears only when the join has been ASKED and has never once
    // answered (`attempted > 0 && resolved === 0`). One traffic event with no
    // pid and no source address is exactly that: socket-attribution counts the
    // attempt and resolves nothing, and nothing in an E2E run ever records a
    // hooked command_start to resolve against.
    const base = `http://127.0.0.1:${readFileSync(join(tmpHome, '.redlog', 'api-port'), 'utf-8').trim()}`
    const token = readFileSync(join(tmpHome, '.redlog', 'api-token'), 'utf-8').trim()
    const res = await fetch(`${base}/api/events/seed`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({
        agent_type: 'scanner',
        data: { subtype: 'connection', proto: 'tcp', remote_addr: '10.10.11.24', remote_port: 445, detectedTarget: '10.10.11.24' }
      })
    })
    expect(res.status).toBe(201)
    await page.waitForTimeout(1500)
  })

  test.afterAll(async () => { if (app) await app.close() })

  for (const locale of ['en', 'zh-TW'] as const) {
    test(`${locale}: the remedy is this host's, and no other platform's`, async () => {
      const t = strings(locale)
      await showTimelineIn(locale)

      const line = page.getByTestId('log-attribution-blind')
      await expect(line).toBeVisible()
      // The shared half: traffic arrived and the join answered nothing. It
      // must not go back to asserting a cause — "this host cannot read which
      // process owns a socket" is false on Windows, where it can.
      await expect(line).toContainText(t['timeline.fold.blind'])
      await expect(line).toContainText(t[PLATFORM_KEYS[hostPlatform]])

      for (const other of Object.keys(PLATFORM_KEYS) as PlatformKey[]) {
        if (other === hostPlatform) continue
        await expect(line, `${locale} line names ${other}'s remedy on ${hostPlatform}`)
          .not.toContainText(t[PLATFORM_KEYS[other]])
      }

      // A zh-TW key that goes missing renders the English string through
      // `t()`'s fallback, which reads as a correct line and is not one.
      if (locale === 'zh-TW') {
        await expect(line).not.toContainText(strings('en')[PLATFORM_KEYS[hostPlatform]])
      }
    })
  }
})
