import { test, expect, type ElectronApplication, type Page } from '@playwright/test'
import { existsSync, mkdirSync, readFileSync, openSync, readSync, closeSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { launchWithTempHome, openTestProject } from './helpers'

const SCREENSHOT_DIR = join(__dirname, 'screenshots')

// Preload bridge slice for the cloud-share endpoints. Only the fields the
// tests actually read need to be named — the rest of the surface lives in
// src/renderer/src/env.d.ts.
interface CloudShareBridge {
  preview: () => Promise<{
    ok: boolean
    preview?: {
      eventCount: number
      sanitizedEventCount: number
      sanitizedEventCountTotal: number
      approxSizeBytes: number
      screenshotCount: number
      castCount: number
      chainHead: { hash: string; eventCount: number } | null
    }
    error?: string
  }>
  prepare: (
    engagementId: string,
    reviewedByOperator: boolean
  ) => Promise<{ ok: boolean; zipPath?: string; error?: string }>
}

// Read the first N bytes of a file synchronously — used to sniff the ZIP
// local-file-header magic (`PK\x03\x04`) so we prove the on-disk artefact is a
// real archive, not just an empty placeholder.
function readMagic(path: string, n: number): Buffer {
  const fd = openSync(path, 'r')
  try {
    const buf = Buffer.alloc(n)
    readSync(fd, buf, 0, n, 0)
    return buf
  } finally {
    closeSync(fd)
  }
}

// Shared electronApp across the four tests — one launch, one project, and
// Test 2 depends on Test 1's UI state (Data tab already open, panel visible).
// Same pattern as marketplace-flow.spec.ts.
test.describe.serial('cloud share', () => {
  let app: ElectronApplication
  let page: Page
  let tmpHome: string

  test.beforeAll(async () => {
    const launched = await launchWithTempHome()
    app = launched.app
    page = launched.page
    tmpHome = launched.tmpHome
    // Force English so we can target Data-tab label / preview counts by text.
    await page.evaluate(() => localStorage.setItem('redlog-locale', 'en'))
    await openTestProject(page, 'e2e-cloud-share')
  })

  test.afterAll(async () => {
    if (app) await app.close()
  })

  test('preview shows counts + review gate disables Share until checked', async () => {
    // Settings is ⌘9 (dashboard=1..settings=9 order from project-flow.spec.ts).
    const mod = process.platform === 'darwin' ? 'Meta' : 'Control'
    await page.keyboard.press(`${mod}+9`)
    const viewRoot = page.locator('[data-testid="view-root"]')
    await expect(viewRoot).toHaveAttribute('data-view', 'settings', { timeout: 2_000 })

    // The Data tab hosts the Cloud share panel. The tab bar is a row of
    // <button>s — click by exact "Data" text so we don't collide with any
    // other data-labeled buttons on the page.
    await page.getByRole('button', { name: /^data$/i }).first().click()

    // Wait for the Cloud share panel title to appear — the group heading
    // comes from t('cloudShare.title') = "Cloud share (bundle)".
    await page.waitForSelector('text=Cloud share (bundle)', { timeout: 5_000 })

    // Scroll it into view so the screenshot at the end frames the whole panel.
    await page.locator('text=Cloud share (bundle)').scrollIntoViewIfNeeded()

    // Preview counts row. The panel renders after refreshPreview() resolves;
    // wait on one of the labels rather than a fixed timeout.
    await page.waitForSelector('text=Review — this content will leave your machine:', { timeout: 5_000 })
    for (const label of [
      'Events',
      'Sanitized events',
      'Screenshots',
      'Terminal .cast files',
      'Approx. size',
      'Chain head'
    ]) {
      await expect(page.locator(`text=${label}`).first()).toBeVisible()
    }

    // Share button is disabled before the review gate is checked.
    const shareBtn = page.locator('[data-testid="cloud-share-button"]')
    await expect(shareBtn).toBeVisible()
    await expect(shareBtn).toBeDisabled()

    mkdirSync(SCREENSHOT_DIR, { recursive: true })
    await page.screenshot({ path: join(SCREENSHOT_DIR, 'cloud-share-preview.png') })
  })

  test('ticking the review gate enables Share; clicking uploads to file://', async () => {
    // Same session — the Data tab is already open from Test 1.
    const shareBtn = page.locator('[data-testid="cloud-share-button"]')
    const reviewed = page.locator('[data-testid="cloud-share-reviewed"]')

    await reviewed.check()
    await expect(shareBtn).toBeEnabled()

    // Kick the upload. This runs prepare() → uploadStub() end-to-end, which
    // exports the bundle, zips it, and copies the .zip into
    // ~/.redlog/shares/<sha8>/ under our temp HOME.
    await shareBtn.click()

    // Result panel only mounts after shareUrl is set — that's the signal the
    // whole flow succeeded. Give it generous time because prepare() spawns
    // the system `zip` binary.
    await page.waitForSelector('[data-testid="cloud-share-result"]', { timeout: 20_000 })

    const shareUrl = (await page
      .locator('[data-testid="cloud-share-url"]')
      .innerText()).trim()

    // URL points inside our temp HOME shares dir and uses the 8-char sha8
    // bucket documented in cloud-share-uploader.ts.
    // pathToFileURL normalises to forward slashes even on Windows, so a
    // single-shape regex works everywhere.
    expect(shareUrl).toMatch(/^file:\/\/\/.*\/\.redlog\/shares\/[a-f0-9]{8}\//)

    // Resolve file:// → filesystem path and verify the artefact.
    const zipPath = fileURLToPath(shareUrl)
    expect(existsSync(zipPath)).toBe(true)

    // Confirm the sha8 bucket in the URL lives under our tmpHome, so we know
    // HOME isolation held.
    expect(zipPath.startsWith(tmpHome)).toBe(true)

    // Real ZIP: first 4 bytes = PK\x03\x04 (local file header signature).
    const magic = readMagic(zipPath, 4)
    expect(magic[0]).toBe(0x50) // 'P'
    expect(magic[1]).toBe(0x4b) // 'K'
    expect(magic[2]).toBe(0x03)
    expect(magic[3]).toBe(0x04)

    // Manifest sidecar exists and points back at the same URL.
    const manifestPath = `${zipPath}.manifest.json`
    expect(existsSync(manifestPath)).toBe(true)
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8')) as {
      upload?: { shareUrl?: string }
    }
    expect(manifest.upload?.shareUrl).toBe(shareUrl)

    await page.screenshot({ path: join(SCREENSHOT_DIR, 'cloud-share-uploaded.png') })
  })

  test('previewRedaction() reports non-zero events on a fresh project', async () => {
    const result = await page.evaluate(async () => {
      const api = (window as unknown as { redlog: { cloudShare: CloudShareBridge } }).redlog.cloudShare
      return api.preview()
    })
    // eslint-disable-next-line no-console
    console.log('cloud-share preview:', JSON.stringify(result))
    expect(result.ok).toBe(true)
    expect(result.preview).toBeTruthy()
    // Fresh project already has system.session_start / api_started events, so
    // the preview count is >= 1 — this catches "we accidentally sanitized
    // everything" regressions in the redaction pass.
    expect(result.preview!.eventCount).toBeGreaterThanOrEqual(1)
  })

  test('prepare() without the review gate surfaces RedactionGateError', async () => {
    const result = await page.evaluate(async () => {
      const api = (window as unknown as { redlog: { cloudShare: CloudShareBridge } }).redlog.cloudShare
      return api.prepare('default', false)
    })
    expect(result.ok).toBe(false)
    // RedactionGateError message contains "review" — matches the client-facing
    // string from src/core/cloud-share.ts. Case-insensitive so a copy edit
    // doesn't break the test.
    expect(result.error ?? '').toMatch(/review|gate/i)
  })
})
