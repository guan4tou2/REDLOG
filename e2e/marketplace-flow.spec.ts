import { test, expect, type ElectronApplication, type Page } from '@playwright/test'
import { createHash, generateKeyPairSync } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { gzipSync } from 'node:zlib'
import { launchWithTempHome, openTestProject } from './helpers'

const SCREENSHOT_DIR = join(__dirname, 'screenshots')

// -----------------------------------------------------------------------------
// Test-scoped tarball builder — mirrors the shape src/core/plugins/marketplace
// installs via the default (system `tar`) extractor. Entries are prefixed with
// `plugin/` so `--strip-components=1` lands them at the plugin dir root. Copied
// from test/redlog-sign.test.ts on purpose: keeping it local means the E2E
// spec has no coupling to Vitest fixtures.
// -----------------------------------------------------------------------------

interface TarEntry {
  /** path INSIDE the tarball, e.g. 'plugin/plugin.json' */
  name: string
  body: Buffer
}

function tarHeader(name: string, size: number): Buffer {
  const header = Buffer.alloc(512, 0)
  Buffer.from(name).copy(header, 0)
  // Null bytes as \x00 rather than \0 — Playwright's strict-mode transpile
  // rejects '\000' as an octal escape, so we keep all null bytes hex-escaped
  // to be safe.
  Buffer.from('0000644\x00').copy(header, 100)
  Buffer.from('0000000\x00').copy(header, 108)
  Buffer.from('0000000\x00').copy(header, 116)
  Buffer.from(size.toString(8).padStart(11, '0') + '\x00').copy(header, 124)
  Buffer.from('00000000000\x00').copy(header, 136)
  Buffer.from('        ').copy(header, 148) // checksum placeholder
  header.write('0', 156)
  Buffer.from('ustar\x00').copy(header, 257)
  Buffer.from('00').copy(header, 263)
  let checksum = 0
  for (let i = 0; i < 512; i++) checksum += header[i]
  Buffer.from(checksum.toString(8).padStart(6, '0') + '\x00 ').copy(header, 148)
  return header
}

/** Build a real gzipped tar (POSIX ustar) from an array of entries. */
function buildTarGz(entries: TarEntry[]): Buffer {
  const blocks: Buffer[] = []
  for (const e of entries) {
    blocks.push(tarHeader(e.name, e.body.length))
    const padded = Buffer.alloc(Math.ceil(e.body.length / 512) * 512, 0)
    e.body.copy(padded, 0)
    blocks.push(padded)
  }
  blocks.push(Buffer.alloc(1024, 0)) // two zero blocks = EOF
  return gzipSync(Buffer.concat(blocks))
}

/**
 * Build a minimal declarative plugin tarball. Returns the gz bytes, their hex
 * sha256, and the manifest object (for anyone asserting on-disk shape later).
 */
function buildDeclarativeTarball(pluginId: string, version: string): {
  bytes: Buffer
  sha256: string
  manifest: Record<string, unknown>
} {
  const manifest = {
    id: pluginId,
    name: `${pluginId} test plugin`,
    version,
    redlogApi: 1,
    contributes: {
      lootPatterns: [
        {
          id: `${pluginId}-marker`,
          name: 'marketplace-e2e marker',
          // A regex we know won't fire on any real event — the pattern needs to
          // exist for the plugin to load, not to match anything.
          pattern: 'MARKETPLACE_E2E_FAKE_MATCH_XYZ',
          category: 'test'
        }
      ]
    }
  }
  const bytes = buildTarGz([
    { name: 'plugin/plugin.json', body: Buffer.from(JSON.stringify(manifest, null, 2)) }
  ])
  const sha256 = createHash('sha256').update(bytes).digest('hex')
  return { bytes, sha256, manifest }
}

/** Preload bridge slice for the endpoints this spec drives. */
interface MarketplaceBridge {
  install: (entryJson: string) => Promise<{ ok: boolean; error?: string }>
  testInstall: (entryJson: string, tarballBytesB64: string) => Promise<{
    ok: boolean
    tier?: 'declarative' | 'privileged'
    installedDir?: string
    error?: string
  }>
  testSetIndex: (indexJson: string) => Promise<{ ok: boolean; error?: string }>
  listPublishers: () => Promise<Array<{ id: string; keys: Array<{ publicKey: string; label?: string }> }>>
  listVersions: (pluginId: string) => Promise<string[]>
  rollback: (pluginId: string, versionKey: string) => Promise<{ ok: boolean; error?: string }>
}

function bridge(page: Page): Promise<MarketplaceBridge> {
  // Just a nudge to prove the preload is wired — the actual calls happen inside
  // page.evaluate blocks below, since the bridge lives in the renderer.
  return page.evaluate(async () => {
    const w = window as unknown as { redlog: { marketplace: unknown } }
    return w.redlog.marketplace as unknown as MarketplaceBridge
  })
}

// Shared electronApp across the three tests: same pattern as project-flow.
test.describe.serial('marketplace', () => {
  let app: ElectronApplication
  let page: Page
  let tmpHome: string

  test.beforeAll(async () => {
    const launched = await launchWithTempHome()
    app = launched.app
    page = launched.page
    tmpHome = launched.tmpHome
    // Sanity: preload wired the E2E-only endpoint.
    await bridge(page)
    // Force English locale so getByRole/getByPlaceholder can hit i18n strings
    // deterministically (default detectLocale() picks zh-TW under a Chinese
    // system locale, which breaks name-based selectors).
    await page.evaluate(() => localStorage.setItem('redlog-locale', 'en'))
    // Open a project so the main shell (with view-root + Settings) is mounted;
    // otherwise ProjectPicker owns the window and none of the UI locators used
    // by these tests can resolve. openTestProject reloads → the locale change
    // takes effect before we start clicking.
    await openTestProject(page, 'e2e-marketplace')
  })

  test.afterAll(async () => {
    if (app) await app.close()
  })

  test('installs a declarative plugin via the test IPC', async () => {
    const pluginId = 'mkt-e2e-plugin'
    const { bytes, sha256 } = buildDeclarativeTarball(pluginId, '1.0.0')

    const entry = {
      id: pluginId,
      name: 'marketplace e2e plugin',
      publisher: 'e2e-publisher',
      version: '1.0.0',
      tarball: 'https://example.invalid/mkt-e2e-plugin-1.0.0.tar.gz',
      sha256
    }

    const result = await page.evaluate(
      async ({ entryJson, tarballB64 }) => {
        const api = (window as unknown as { redlog: { marketplace: MarketplaceBridge } }).redlog.marketplace
        return api.testInstall(entryJson, tarballB64)
      },
      { entryJson: JSON.stringify(entry), tarballB64: bytes.toString('base64') }
    )

    expect(result.ok).toBe(true)
    expect(result.tier).toBe('declarative')

    // Assert the manifest actually landed on disk under the temp HOME.
    const installedManifest = join(tmpHome, '.redlog', 'plugins', pluginId, 'plugin.json')
    expect(existsSync(installedManifest)).toBe(true)
    const parsed = JSON.parse(readFileSync(installedManifest, 'utf-8'))
    expect(parsed.id).toBe(pluginId)
    expect(parsed.version).toBe('1.0.0')

    // Screenshot the marketplace tab so the deliverable also has visual proof.
    // Settings is ⌘9 (dashboard=1..settings=9 order from project-flow.spec.ts).
    const mod = process.platform === 'darwin' ? 'Meta' : 'Control'
    await page.keyboard.press(`${mod}+9`)
    const viewRoot = page.locator('[data-testid="view-root"]')
    await expect(viewRoot).toHaveAttribute('data-view', 'settings', { timeout: 2_000 })
    await page.getByRole('button', { name: /marketplace/i }).first().click()
    // The Plugins sub-tab is the default landing view — good enough for a
    // screenshot; we're not asserting on the DOM here.
    mkdirSync(SCREENSHOT_DIR, { recursive: true })
    await page.screenshot({ path: join(SCREENSHOT_DIR, 'marketplace-after-install.png') })
  })

  test('trusts a publisher via the Publishers tab UI', async () => {
    // Publisher key: real SPKI Ed25519 key so the marketplace publisher-trust
    // store accepts it (createPublicKey verifies the encoding on read).
    const { publicKey } = generateKeyPairSync('ed25519')
    const spkiB64 = publicKey.export({ format: 'der', type: 'spki' }).toString('base64')
    const publisherId = 'e2e-trusted-pub'

    // Should already be on the marketplace tab after test 1, but re-select
    // defensively — tests should be robust to running in isolation.
    const mod = process.platform === 'darwin' ? 'Meta' : 'Control'
    await page.keyboard.press(`${mod}+9`)
    await expect(page.locator('[data-testid="view-root"]')).toHaveAttribute('data-view', 'settings', { timeout: 2_000 })
    await page.getByRole('button', { name: /marketplace/i }).first().click()

    // Sub-tab: Publishers. MarketplacePanel renders the three sub-tabs from
    // i18n strings ("Plugins" / "Publishers" / "Revocations").
    await page.getByRole('button', { name: /^publishers$/i }).click()

    // Form: publisher id → key → Trust. Placeholders are the reliable hook —
    // there are no data-testids on the inputs.
    await page.getByPlaceholder(/publisher id|publisher slug|slug/i).first().fill(publisherId)
    await page.getByPlaceholder(/spki|public key|base64/i).first().fill(spkiB64)
    // i18n key 'marketplace.trustPublisher' → English label is just "Trust".
    // Scope by placeholder-adjacent form so we don't collide with a plausible
    // future "Trust" button elsewhere on the tab.
    await page.getByRole('button', { name: /^trust$/i }).click()

    // Confirm via the IPC — quicker + less flaky than reading the rendered list.
    const publishers = await page.evaluate(async () => {
      const api = (window as unknown as { redlog: { marketplace: MarketplaceBridge } }).redlog.marketplace
      return api.listPublishers()
    })
    const found = publishers.find((p) => p.id === publisherId)
    expect(found).toBeTruthy()
    expect(found!.keys.some((k) => k.publicKey === spkiB64)).toBe(true)

    await page.screenshot({ path: join(SCREENSHOT_DIR, 'marketplace-publisher-trusted.png') })
  })

  test('rollback restores the previous version snapshot', async () => {
    const pluginId = 'mkt-e2e-rollback'

    // --- v1.0.0 ------------------------------------------------------------
    const v1 = buildDeclarativeTarball(pluginId, '1.0.0')
    const entryV1 = {
      id: pluginId,
      name: 'rollback e2e plugin',
      publisher: 'e2e-publisher',
      version: '1.0.0',
      tarball: 'https://example.invalid/mkt-e2e-rollback-1.0.0.tar.gz',
      sha256: v1.sha256
    }
    const r1 = await page.evaluate(
      async ({ entryJson, tarballB64 }) => {
        const api = (window as unknown as { redlog: { marketplace: MarketplaceBridge } }).redlog.marketplace
        return api.testInstall(entryJson, tarballB64)
      },
      { entryJson: JSON.stringify(entryV1), tarballB64: v1.bytes.toString('base64') }
    )
    expect(r1.ok).toBe(true)

    // Drop a marker inside the installed dir so we can prove the swap moved
    // the *whole* directory (not just the manifest) into snapshots on next
    // install, and that rollback moves it back verbatim.
    const pluginDir = join(tmpHome, '.redlog', 'plugins', pluginId)
    const markerPath = join(pluginDir, 'VERSION_MARKER')
    mkdirSync(dirname(markerPath), { recursive: true })
    writeFileSync(markerPath, 'v1.0.0-marker')
    expect(existsSync(markerPath)).toBe(true)

    // --- v1.1.0 ------------------------------------------------------------
    const v2 = buildDeclarativeTarball(pluginId, '1.1.0')
    const entryV2 = {
      id: pluginId,
      name: 'rollback e2e plugin',
      publisher: 'e2e-publisher',
      version: '1.1.0',
      tarball: 'https://example.invalid/mkt-e2e-rollback-1.1.0.tar.gz',
      sha256: v2.sha256
    }
    const r2 = await page.evaluate(
      async ({ entryJson, tarballB64 }) => {
        const api = (window as unknown as { redlog: { marketplace: MarketplaceBridge } }).redlog.marketplace
        return api.testInstall(entryJson, tarballB64)
      },
      { entryJson: JSON.stringify(entryV2), tarballB64: v2.bytes.toString('base64') }
    )
    expect(r2.ok).toBe(true)

    // The v1 install (with marker) should have been snapshotted; the fresh
    // v1.1.0 directory has no marker.
    expect(existsSync(markerPath)).toBe(false)
    const newManifest = JSON.parse(readFileSync(join(pluginDir, 'plugin.json'), 'utf-8'))
    expect(newManifest.version).toBe('1.1.0')

    // --- listVersions ------------------------------------------------------
    const versions = await page.evaluate(async (id) => {
      const api = (window as unknown as { redlog: { marketplace: MarketplaceBridge } }).redlog.marketplace
      return api.listVersions(id)
    }, pluginId)
    expect(versions.length).toBe(1)
    const snapshotKey = versions[0]

    // --- rollback ----------------------------------------------------------
    const rr = await page.evaluate(
      async ({ id, key }) => {
        const api = (window as unknown as { redlog: { marketplace: MarketplaceBridge } }).redlog.marketplace
        return api.rollback(id, key)
      },
      { id: pluginId, key: snapshotKey }
    )
    expect(rr.ok).toBe(true)

    // Marker file must reappear because rollback renames the snapshot back
    // over the plugin dir — verifying the whole tree was preserved.
    expect(existsSync(markerPath)).toBe(true)
    expect(readFileSync(markerPath, 'utf-8')).toBe('v1.0.0-marker')
    const restoredManifest = JSON.parse(readFileSync(join(pluginDir, 'plugin.json'), 'utf-8'))
    expect(restoredManifest.version).toBe('1.0.0')
  })

  test('publisher auto-fill banner appears + Trust-all lands the key on disk', async () => {
    // v0.6.79 flow: fetchIndex() may return a `publishers[]` block; if any of
    // those publishers aren't yet in ~/.redlog/trusted-publishers.json the
    // panel shows an amber banner with a "Trust all" button. Inject a fake
    // index via the dev-only marketplace:testSetIndex IPC (gated on
    // REDLOG_E2E=1) so we don't need a live HTTPS registry.
    const { publicKey } = generateKeyPairSync('ed25519')
    const spkiB64 = publicKey.export({ format: 'der', type: 'spki' }).toString('base64')
    const publisherId = 'e2e-banner-pub'
    // Not the same id as the "trust via UI" test above so that publisher stays
    // in the store from test 2 and this one starts with a fresh untrusted id.
    const fakeIndex = {
      updatedAt: Date.now(),
      entries: [] as Array<Record<string, unknown>>,
      publishers: [
        { id: publisherId, homepage: 'https://example.invalid', keys: [{ publicKey: spkiB64, label: 'e2e' }] }
      ]
    }

    const setResult = await page.evaluate(async (indexJson) => {
      const api = (window as unknown as { redlog: { marketplace: MarketplaceBridge } }).redlog.marketplace
      return api.testSetIndex(indexJson)
    }, JSON.stringify(fakeIndex))
    expect(setResult.ok).toBe(true)

    // Ensure we're on Settings ▸ Marketplace ▸ Plugins.
    const mod = process.platform === 'darwin' ? 'Meta' : 'Control'
    await page.keyboard.press(`${mod}+9`)
    await expect(page.locator('[data-testid="view-root"]')).toHaveAttribute('data-view', 'settings', { timeout: 2_000 })
    await page.getByRole('button', { name: /marketplace/i }).first().click()
    // Sub-tab "Plugins" — test 2 above left us on Publishers; jump back.
    // Two buttons match /Plugins/ (Settings-level tab + Marketplace sub-tab);
    // `.last()` picks the sub-tab which is rendered after the top-level tabs.
    await page.getByRole('button', { name: /^plugins$/i }).last().click()

    // Trigger fetchIndex — the URL box is empty so it uses the default; main
    // short-circuits to the injected index because REDLOG_E2E is set.
    // English button label is "Fetch index" per i18n/en.json.
    await page.getByRole('button', { name: /fetch index/i }).click()

    // Banner appears with the injected publisher count. English string is
    // "This registry suggests trusting {n} publisher(s)".
    const banner = page.locator('[data-testid="marketplace-suggested-banner"]')
    await expect(banner).toBeVisible({ timeout: 5_000 })
    await expect(banner).toContainText(/trusting 1 publisher/i)
    await expect(banner).toContainText(publisherId)

    // Click Trust all → writes to trusted-publishers.json and banner unmounts.
    await page.locator('[data-testid="marketplace-trust-all-suggested"]').click()

    // Store on disk carries the injected id + key. reloadPublishers refreshes
    // React state from the IPC, which reads the store — so once the banner
    // is gone we know the file must have been written.
    await expect(banner).toHaveCount(0, { timeout: 5_000 })

    const storePath = join(tmpHome, '.redlog', 'trusted-publishers.json')
    expect(existsSync(storePath)).toBe(true)
    const store = JSON.parse(readFileSync(storePath, 'utf-8')) as Record<
      string,
      { id: string; keys: Array<{ publicKey: string }> }
    >
    expect(store[publisherId]).toBeTruthy()
    expect(store[publisherId].keys.some((k) => k.publicKey === spkiB64)).toBe(true)

    mkdirSync(SCREENSHOT_DIR, { recursive: true })
    await page.screenshot({ path: join(SCREENSHOT_DIR, 'marketplace-publishers-trusted.png') })

    // Clear the injected index so nothing leaks into later specs if the
    // Electron instance somehow gets reused.
    await page.evaluate(async () => {
      const api = (window as unknown as { redlog: { marketplace: MarketplaceBridge } }).redlog.marketplace
      await api.testSetIndex('')
    })
  })
})
