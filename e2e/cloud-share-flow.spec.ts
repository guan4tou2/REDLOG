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
    // Panel labels — the size row was split into raw + approx-zipped in v0.6.76
    // so "Approx. size" is no longer a label; assert on the new pair.
    for (const label of [
      'Events',
      'Sanitized events',
      'Screenshots',
      'Terminal .cast files',
      'Raw size (pre-zip)',
      'Approx. zipped',
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

  test('HTTPS backend radio + credentials persist across reload', async () => {
    // Advanced accordion holds endpoint + token inputs + a stub/https radio.
    // All three values persist to ~/.redlog/config.yaml via config.save; a
    // reload should re-hydrate them into the panel state.
    const endpointValue = 'https://redlog-share.test.workers.dev'
    const tokenValue = 'test-token'

    // Test 2 already opened the Data tab; expand Advanced if it isn't open
    // yet. Attribute-only test — resilient if we ever change the default.
    const advToggle = page.locator('[data-testid="cloud-share-advanced-toggle"]')
    await advToggle.click()

    const endpointInput = page.locator('[data-testid="cloud-share-endpoint"]')
    const tokenInput = page.locator('[data-testid="cloud-share-authtoken"]')
    const httpsRadio = page.locator('[data-testid="cloud-share-mode-https"]')

    await expect(endpointInput).toBeVisible({ timeout: 3_000 })
    await endpointInput.fill(endpointValue)
    await tokenInput.fill(tokenValue)
    await httpsRadio.check()
    await expect(httpsRadio).toBeChecked()

    // persistBackend debounces at 350 ms; wait a bit past that for the save
    // then read config.yaml through the IPC to prove it landed on disk.
    await expect
      .poll(
        async () => {
          const cfg = await page.evaluate(async () => {
            const w = window as unknown as { redlog: { config: { get: () => Promise<unknown> } } }
            return w.redlog.config.get()
          })
          const cs = (cfg as { cloudShare?: { endpoint?: string } })?.cloudShare
          return cs?.endpoint
        },
        { timeout: 3_000 }
      )
      .toBe(endpointValue)

    // Now reload — App re-mounts, project.active re-fetches, Settings panel
    // re-runs its config.get() effect, which should set endpoint/token/mode.
    await page.reload()
    await page.waitForLoadState('domcontentloaded')
    await page.waitForSelector('[data-testid="view-root"][data-view="dashboard"]', {
      timeout: 10_000
    })

    // Navigate back to Settings ▸ Data. The panel opens Advanced automatically
    // on load when endpoint is non-empty (see useEffect in CloudSharePanel).
    const mod = process.platform === 'darwin' ? 'Meta' : 'Control'
    await page.keyboard.press(`${mod}+9`)
    await expect(page.locator('[data-testid="view-root"]')).toHaveAttribute('data-view', 'settings', { timeout: 2_000 })
    await page.getByRole('button', { name: /^data$/i }).first().click()

    // Re-hydrated values. The inputs live inside the Advanced fold, which
    // opens itself when an endpoint is stored — no manual click needed.
    const endpointAfter = page.locator('[data-testid="cloud-share-endpoint"]')
    const tokenAfter = page.locator('[data-testid="cloud-share-authtoken"]')
    const httpsAfter = page.locator('[data-testid="cloud-share-mode-https"]')
    await expect(endpointAfter).toBeVisible({ timeout: 5_000 })
    await expect(endpointAfter).toHaveValue(endpointValue)
    // Token input is password-type but the .value round-trips regardless.
    await expect(tokenAfter).toHaveValue(tokenValue)
    await expect(httpsAfter).toBeChecked()

    // The Share button label must reflect the mode swap. English strings:
    //   stub  → "Share (stub upload)"
    //   https → "Share via HTTPS backend"
    // We intentionally do NOT click it — a real POST to a .workers.dev URL
    // would either fail or, worse, actually upload. Just verify the label.
    const shareBtn = page.locator('[data-testid="cloud-share-button"]')
    await expect(shareBtn).toContainText(/HTTPS/i)
    await expect(shareBtn).not.toContainText(/stub/i)
    // Intentionally NOT clearing the fields — the persistBackend debounce
    // (350 ms) would race against the next test's config.save and wipe its
    // maxBundleBytes override. The next test tolerates either mode.
  })

  test('inline error box surfaces prepare failures + dismiss ✕ clears it', async () => {
    // Force any prepare() call to fail by shrinking cloudShare.maxBundleBytes
    // to 1 — every real bundle exceeds that cap and prepareCloudShareBundle
    // throws BundleTooLargeError. The persistent inline error box (v0.6.79
    // pattern) must render the message so the operator can read it after the
    // toast fades.
    // 1) shrink the cap via config.save
    await page.evaluate(async () => {
      const w = window as unknown as {
        redlog: {
          config: { get: () => Promise<unknown>; save: (c: unknown) => Promise<unknown> }
        }
      }
      const cfg = (await w.redlog.config.get()) as Record<string, unknown> & {
        cloudShare?: Record<string, unknown>
      }
      const cs = { ...(cfg.cloudShare ?? {}), maxBundleBytes: 1 }
      await w.redlog.config.save({ ...cfg, cloudShare: cs })
    })

    // Tick the review gate — the previous test unchecked HTTPS, so we're back
    // in stub mode. Share button becomes enabled once reviewed.
    const reviewed = page.locator('[data-testid="cloud-share-reviewed"]')
    if (!(await reviewed.isChecked())) await reviewed.check()
    const shareBtn = page.locator('[data-testid="cloud-share-button"]')
    await expect(shareBtn).toBeEnabled()

    // Click Share → prepare() throws BundleTooLargeError → inline error box.
    await shareBtn.click()

    const inlineErr = page.locator('[data-testid="cloud-share-inline-error"]')
    await expect(inlineErr).toBeVisible({ timeout: 10_000 })
    // Error message from BundleTooLargeError:
    //   "bundle is <N> bytes, exceeds cap of 1. Split the engagement or raise cloudShare.maxBundleBytes."
    // The panel prefixes it with t('cloudShare.prepareFailed') = "Prepare failed".
    await expect(inlineErr).toContainText(/exceeds cap|BundleTooLarge/i)

    // ✕ button hides the box again — v0.6.79 dismiss behaviour.
    await page.locator('[data-testid="cloud-share-inline-error-dismiss"]').click()
    await expect(inlineErr).toHaveCount(0, { timeout: 3_000 })

    // Reset maxBundleBytes back to undefined so we don't poison any follow-up
    // spec or a re-run under the same tmpHome.
    await page.evaluate(async () => {
      const w = window as unknown as {
        redlog: {
          config: { get: () => Promise<unknown>; save: (c: unknown) => Promise<unknown> }
        }
      }
      const cfg = (await w.redlog.config.get()) as Record<string, unknown> & {
        cloudShare?: Record<string, unknown>
      }
      const cs = { ...(cfg.cloudShare ?? {}) }
      delete cs.maxBundleBytes
      await w.redlog.config.save({ ...cfg, cloudShare: cs })
    })
  })
})
