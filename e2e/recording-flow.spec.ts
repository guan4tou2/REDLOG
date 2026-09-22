import { test, expect, type ElectronApplication, type Page } from '@playwright/test'
import { launchWithTempHome, openTestProject } from './helpers'

// Preload bridge slice for the recording endpoints. Full surface lives in
// src/renderer/src/env.d.ts — only the fields the tests actually call need
// names here.
interface RecordingBridge {
  get: () => Promise<boolean>
  toggle: () => Promise<boolean>
}

// Shared electronApp across the three assertions: one launch, one project,
// same pattern as the other flow specs.
test.describe.serial('recording pause / resume', () => {
  let app: ElectronApplication
  let page: Page

  test.beforeAll(async () => {
    const launched = await launchWithTempHome()
    app = launched.app
    page = launched.page
    // Force English so the status-bar label ("REC" / "PAUSED") is
    // deterministic — matches the pattern in the other spec files.
    await page.evaluate(() => localStorage.setItem('redlog-locale', 'en'))
    // App.tsx's ⌘. shortcut early-returns when no project is active; open
    // one so the shortcut path fires. openTestProject reloads → locale
    // change takes effect.
    await openTestProject(page, 'e2e-recording')
  })

  test.afterAll(async () => {
    if (app) await app.close()
  })

  test('recording.get is true on a fresh project', async () => {
    const initial = await page.evaluate(async () => {
      const api = (window as unknown as { redlog: { recording: RecordingBridge } }).redlog.recording
      return api.get()
    })
    expect(initial).toBe(true)

    // Status bar reflects the same state. The attribute is the recording
    // state and stays 'on' — but the LABEL is not "REC" here, and that is the
    // point of the test's own premise: on a fresh project nothing has been
    // captured yet, and the status bar now says so rather than claiming to be
    // recording something.
    //
    //   !recording                         → PAUSED
    //   recording && no event ever         → "Waiting for events…"
    //   recording && capture flowing       → REC
    //
    // "REC" on an engagement that has captured nothing is exactly the
    // reassuring lie the capture-health work exists to remove, so the
    // assertion follows the product rather than the other way round.
    const rec = page.locator('[data-testid="status-bar-recording"]')
    await expect(rec).toHaveAttribute('data-recording', 'on', { timeout: 2_000 })
    await expect(rec).toContainText('Waiting for events')
  })

  test('recording.toggle flips state and the status bar', async () => {
    const next = await page.evaluate(async () => {
      const api = (window as unknown as { redlog: { recording: RecordingBridge } }).redlog.recording
      return api.toggle()
    })
    expect(next).toBe(false)

    // recording.get must agree with toggle's return value.
    const confirmed = await page.evaluate(async () => {
      const api = (window as unknown as { redlog: { recording: RecordingBridge } }).redlog.recording
      return api.get()
    })
    expect(confirmed).toBe(false)

    // StatusBar subscribes to recording.onChange in its useEffect, so the
    // data-recording attribute + label flip on the next tick. No sleep —
    // let toHaveAttribute poll.
    const rec = page.locator('[data-testid="status-bar-recording"]')
    await expect(rec).toHaveAttribute('data-recording', 'off', { timeout: 2_000 })
    await expect(rec).toContainText('PAUSED')
  })

  test('⌘. (Ctrl+. on non-mac) flips recording back on', async () => {
    // App.tsx wires cmd+. to window.redlog.recording.toggle(). We're paused
    // from the previous test, so this press should flip to true.
    const mod = process.platform === 'darwin' ? 'Meta' : 'Control'
    await page.keyboard.press(`${mod}+.`)

    const rec = page.locator('[data-testid="status-bar-recording"]')
    await expect(rec).toHaveAttribute('data-recording', 'on', { timeout: 2_000 })
    // Same project, still nothing captured — so "Waiting for events…", not
    // "REC". What this test is about is the attribute flipping back to 'on';
    // see the first test for why the label reads the way it does.
    await expect(rec).toContainText('Waiting for events')

    // Double-check via IPC in case the DOM update raced somehow.
    const finalState = await page.evaluate(async () => {
      const api = (window as unknown as { redlog: { recording: RecordingBridge } }).redlog.recording
      return api.get()
    })
    expect(finalState).toBe(true)
  })
})
