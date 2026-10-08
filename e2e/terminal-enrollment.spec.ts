import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { MAIN_ENTRY, REPO_ROOT, makeTempHome, openTestProject, resizeMainWindow } from './helpers'

// Spec 052 T043. The install journey, in the real app: the card names the gap,
// one action closes it, and the card does not call it done until a command
// from the operator's own terminal has arrived.
//
// That last step is the whole point of this file and it is not pedantry.
// Everything before it proves a file was copied and a line was appended —
// which is a setup flow reporting on itself. The rc still has to be re-read,
// the adapter still has to load, and the transport still has to reach RedLog.
// Until a row shows up from a terminal that is NOT one of RedLog's own panes,
// the only thing the card can honestly say is "not finished" (FR-015).
//
// The shell is not driven here. `test/zsh-auto-capture.pty.test.ts` does that
// against a real interactive zsh, and repeating it through Electron would buy
// a slower copy of the same evidence. What only the app can settle is the
// card's three states and the one action between them.

// POSIX only: `shell-source` install refuses outright on win32 and tells the
// operator to use the PowerShell $PROFILE path instead, so there is nothing
// here for a Windows runner to assert. CI runs e2e on ubuntu.
test.skip(process.platform === 'win32', 'shell-source install is POSIX-only; see docs/windows-setup.md')

let app: ElectronApplication
let page: Page
let tmpHome: string

const api = (): { base: string; token: string } => ({
  base: `http://127.0.0.1:${readFileSync(join(tmpHome, '.redlog', 'api-port'), 'utf-8').trim()}`,
  token: readFileSync(join(tmpHome, '.redlog', 'api-token'), 'utf-8').trim()
})

/** A command as the operator's own enrolled terminal would send it. `source`
 *  is what tells it apart from one of RedLog's panes, and that distinction is
 *  the entire difference between "installed" and "working".
 *
 *  The status is checked, and the row is read back. Without that, a refused
 *  POST and a card that failed to update are the same symptom — an assertion
 *  on the card's text that names neither. The first run of this file lost a
 *  round to exactly that.
 */
const postCommand = async (source: string, command: string): Promise<void> => {
  const { base, token } = api()
  const res = await fetch(`${base}/api/events/seed`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({
      agent_type: 'shell',
      data: { subtype: 'command_end', command, exit_code: 0, cwd: '/root', source }
    })
  })
  expect(res.status, `seeding "${command}" failed: ${await res.text()}`).toBeLessThan(300)

  // And it is in the record, with the `source` that was sent. The card is a
  // reader; if the row is not there, the card is not what is wrong.
  await expect.poll(async () => {
    const events = await fetch(`${base}/api/events?limit=200`, {
      headers: { authorization: `Bearer ${token}` }
    }).then((r) => r.json()) as { events: Array<{ data?: Record<string, unknown> }> }
    return events.events.filter((e) =>
      String(e.data?.command ?? '') === command && e.data?.source === source).length
  }, { timeout: 15_000, message: `no row for "${command}" with source "${source}"` })
    .toBeGreaterThan(0)
}

const terminalRow = (): ReturnType<Page['locator']> =>
  page.locator('[data-testid="capture-row-terminal"]')

const openAllSources = async (): Promise<void> => {
  const toggle = page.getByRole('button', { name: /all sources/ })
  if (await toggle.isVisible()) await toggle.click()
}

test.describe.serial('enrolling this machine’s terminals', () => {
  test.beforeAll(async () => {
    tmpHome = makeTempHome('redlog-enrol-')
    app = await electron.launch({
      args: [MAIN_ENTRY], cwd: REPO_ROOT,
      env: { ...process.env, NODE_ENV: 'test', HOME: tmpHome, USERPROFILE: tmpHome, REDLOG_E2E: '1' }
    })
    page = await app.firstWindow()
    await page.waitForLoadState('domcontentloaded')
    await page.evaluate(() => localStorage.setItem('redlog-locale', 'en'))
    await openTestProject(page, 'terminal-enrollment')
    await page.waitForTimeout(2000)
    await resizeMainWindow(app, 1500, 1000)
  })

  test.afterAll(async () => { if (app) await app.close() })

  test('says this machine’s terminals are not in the record', async () => {
    await page.click('[data-testid="first-run-more-sources"]')
    await openAllSources()
    await expect(terminalRow()).toBeVisible()
    await expect(terminalRow()).toContainText(/not in the record/i)
  })

  test('asks for a first command before it asks for an install', async () => {
    // Ordering, and it is deliberate. With nothing recorded at all the card
    // has a bigger problem than enrolment, and the shortest route out of dark
    // is a command — RedLog's own pane records with nothing installed. The
    // install only becomes the card's one action once there IS a record.
    await expect(page.getByRole('button', { name: /install the shell hook/i }))
      .toHaveCount(0)

    await postCommand('builtin-terminal', 'id')
    await expect.poll(async () => {
      await openAllSources()
      return page.getByRole('button', { name: /install the shell hook/i }).count()
    }, { timeout: 20_000 }).toBe(1)

    // …and that pane command changed nothing about the operator's own shell.
    await expect(terminalRow()).toContainText(/not in the record/i)
  })

  test('offers the install as the card’s own action, not a trip to Settings', async () => {
    // FR-014. The row named the gap and then asked the operator to go and
    // find the control, behind "manage sources"; the action and the sentence
    // belong together.
    const cta = page.getByRole('button', { name: /install the shell hook/i })
    await expect(cta).toBeVisible()
    await cta.click()

    // What one action actually puts on disk: the adapter, the shared
    // transport, the relay and the class policy. A missing support file is
    // the quiet failure — the adapter loads and silently records nothing.
    for (const file of ['shell-common.sh', 'redlog-relay.py', 'command-class.json']) {
      await expect.poll(() => existsSync(join(tmpHome, '.redlog', file)), { timeout: 15_000 })
        .toBe(true)
    }
    const adapter = existsSync(join(tmpHome, '.redlog', 'shell-hook.zsh')) ||
      existsSync(join(tmpHome, '.redlog', 'shell-bash-hook.sh'))
    expect(adapter, 'no shell adapter was installed').toBe(true)
  })

  test('does not call it done just because the files are there', async () => {
    // FR-015, and the reason this journey is an e2e rather than a unit test.
    // Everything up to here is a setup flow reporting on its own success: a
    // file was copied, a line was appended. The rc still has to be re-read,
    // the adapter still has to load, the transport still has to arrive — and
    // the pane command from two tests ago proves none of that, because
    // RedLog's panes never needed the adapter.
    await expect.poll(async () => {
      await openAllSources()
      return (await terminalRow().textContent()) ?? ''
    }, { timeout: 20_000 }).toMatch(/open a new terminal/i)
    await expect(terminalRow()).not.toContainText(/is included/i)
  })

  test('a command from the operator’s own terminal is', async () => {
    // A command with nothing in it to detect. `nmap -sV 10.0.0.1` would send
    // target extraction and a possible scope violation down the same path,
    // and this test is about one field: `source`.
    await postCommand('auto-relay', 'echo from-my-own-terminal')
    // The payload, before the text. `postCommand` has already proved the row
    // is in the record; this proves main computed it; the text assertion
    // below then proves the card was told.
    //
    // That third step is the one that failed in CI, and splitting the three
    // apart is how it was found. The card does not poll — it re-reads health
    // once per batch of new events — and main's 750ms cache could hand that
    // one read a value computed just before the event landed. The card then
    // stayed wrong until the next event, which in this journey never comes.
    // Fixed in capture-health.ts (the cache is cleared on every publish) and
    // pinned by a unit test there; it passed on a quiet machine and failed on
    // a busy runner because whether something else had filled the cache in
    // the previous 750ms is a property of the load, not of the code.
    await expect.poll(async () => page.evaluate(async () => {
      const health = await (window as unknown as {
        redlog: { capture: { health: () => Promise<{ sources: Array<Record<string, unknown>> } | null> } }
      }).redlog.capture.health()
      const row = health?.sources.find((s) => s.id === 'terminal')
      return {
        ownShellLastEventAt: row?.ownShellLastEventAt ?? null,
        lastEventAt: row?.lastEventAt ?? null,
        installed: row?.installed ?? null
      }
    }), { timeout: 20_000 }).toMatchObject({ ownShellLastEventAt: expect.any(Number) })

    await expect.poll(async () => {
      await openAllSources()
      return (await terminalRow().textContent()) ?? ''
    }, { timeout: 20_000 }).toMatch(/is included/i)

    // And it says what it now records, which is more than it used to: the
    // banner that said "commands only" stopped being true when the relay
    // landed.
    await expect(terminalRow()).toContainText(/output/i)
  })
})
