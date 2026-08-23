import { test, expect, _electron as electron, type ElectronApplication } from '@playwright/test'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MAIN_ENTRY, REPO_ROOT, openTestProject } from './helpers'

// docs/DESIGN-core-and-capture.md §4d, verified end to end: a command with a
// password flag produces a credential_use companion event, and the secret is
// never in it. The detection logic is unit-tested in credential-detector.test.ts;
// this proves the wiring in the api-server ingest path fires and masks.

test('a -p flag on a command produces a masked credential_use event', async () => {
  const tmpHome = mkdtempSync(join(tmpdir(), 'redlog-cred-'))
  let app: ElectronApplication | undefined
  try {
    app = await electron.launch({ args: [MAIN_ENTRY], cwd: REPO_ROOT,
      env: { ...process.env, NODE_ENV: 'test', HOME: tmpHome, USERPROFILE: tmpHome, REDLOG_E2E: '1' } })
    const page = await app.firstWindow()
    await page.waitForLoadState('domcontentloaded')
    await openTestProject(page, 'credential-use')
    await page.waitForTimeout(1200)
    const base = `http://127.0.0.1:${readFileSync(join(tmpHome, '.redlog', 'api-port'), 'utf-8').trim()}`
    const token = readFileSync(join(tmpHome, '.redlog', 'api-token'), 'utf-8').trim()

    const SECRET = 'PLACEHOLDERsecret'
    await fetch(`${base}/api/events`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({
        agent_type: 'shell',
        data: { subtype: 'command_end', command: `smbclient //10.10.11.24/share -U admin -p ${SECRET}`, exit_code: 0 }
      })
    })
    await page.waitForTimeout(500)

    const creds = await page.evaluate(async () =>
      (await (window as unknown as { redlog: { events: { query: (o: unknown) => Promise<Array<{ agentType: string; data: Record<string, unknown> }>> } } })
        .redlog.events.query({ limit: 200 }))
        .filter((e) => e.agentType === 'credential_use'))

    expect(creds.length, 'no credential_use event was produced').toBeGreaterThan(0)
    const cred = creds.find((c) => c.data.subtype === 'password_flag')
    expect(cred, 'expected a password_flag credential_use').toBeTruthy()
    // The non-negotiable property: the secret is nowhere in the event.
    expect(JSON.stringify(cred)).not.toContain(SECRET)
  } finally {
    await app?.close()
  }
})
