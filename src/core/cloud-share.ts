import fs from 'fs'
import path from 'path'
import crypto from 'crypto'
import { homedir } from 'os'
import { spawnSync } from 'child_process'
import { exportBundle, type EvidenceBundle } from './bundle-export'
import { countSanitizedEvents } from './sanitize'
import { computeChainHead } from './chain-anchor'
import { getEventCount } from './db/events'

// Cloud-share bundle wraps the existing local exportBundle() with a .zip
// archive plus an outer bundle.json manifest — the "wire format" the backend
// gates on before it returns a share URL. See docs/CLOUD_SHARE_BUNDLE.md §4.
//
// The upload flow itself lives in cloud-share-uploader.ts; this module just
// builds the artefact. Splitting them keeps the redaction gate testable
// without shelling out to any backend.

/** Hard cap on bundle size the backend will accept. Matches spec §4 default. */
export const DEFAULT_MAX_BUNDLE_BYTES = 100 * 1024 * 1024

export interface BundleManifest {
  /** wire-format version; bump on breaking changes to the outer envelope */
  bundleFormat: number
  /** ISO ts the bundle was built (not uploaded) */
  createdAt: string
  engagement: {
    id: string
    /** human name if the operator set one; null otherwise */
    name?: string
  }
  /** sha256 of the .zip that carries the inner exportBundle payload */
  zipSha256: string
  zipBytes: number
  /** convenience: what's inside so the backend can decide + show counts on the download page */
  contents: {
    eventCount: number
    /** count of events whose bytes were replaced by sanitize before write */
    sanitizedEventCount: number
    /** total sanitize entries in the DB, incl. events not in this bundle */
    sanitizedEventCountTotal: number
    chainHead: { hash: string; eventCount: number } | null
  }
  /** everything below is filled by uploader after the PUT */
  upload?: {
    shareUrl: string
    uploadedAt: string
    expiresAt?: string
  }
}

export interface PreparedBundle {
  /** the local .zip on disk, ready to PUT to the backend */
  zipPath: string
  manifest: BundleManifest
  /** original exportBundle() output dir, kept so operators can re-open it locally */
  localBundle: EvidenceBundle
}

export interface RedactionPreview {
  /** total events the bundle will contain */
  eventCount: number
  /** how many carry sanitize replacements */
  sanitizedEventCount: number
  /** how many carry sanitize replacements anywhere in the DB (may exceed eventCount) */
  sanitizedEventCountTotal: number
  /** loose upper bound on final .zip size in bytes (from the file list before compression) */
  approxSizeBytes: number
  /** number of screenshot files that will be included */
  screenshotCount: number
  /** number of asciinema .cast files that will be included */
  castCount: number
  chainHead: { hash: string; eventCount: number } | null
}

/**
 * Preview counts + sizes WITHOUT building the bundle. Cheap enough to run
 * every time the operator opens the share dialog so the review copy stays
 * in sync with the DB.
 */
export function previewRedaction(): RedactionPreview {
  const eventCount = getEventCount()
  const sanitizedTotal = countSanitizedEvents()
  const chainHead = computeChainHead()
  const shotsDir = path.join(projectDirSafe(), 'screenshots')
  const castsDir = path.join(projectDirSafe(), 'casts')
  let approx = 0
  let screenshotCount = 0
  let castCount = 0
  if (fs.existsSync(shotsDir)) {
    for (const n of fs.readdirSync(shotsDir)) {
      try { approx += fs.statSync(path.join(shotsDir, n)).size; screenshotCount++ } catch { /* skip */ }
    }
  }
  if (fs.existsSync(castsDir)) {
    for (const n of fs.readdirSync(castsDir)) {
      try { approx += fs.statSync(path.join(castsDir, n)).size; castCount++ } catch { /* skip */ }
    }
  }
  // Rough event bytes: 512b avg per row is a wild guess but keeps the UI from
  // showing "0 bytes" when a small engagement has almost no screenshots.
  approx += eventCount * 512
  return {
    eventCount,
    sanitizedEventCount: 0,   // filled in after actual build; preview can't tell without walking rows
    sanitizedEventCountTotal: sanitizedTotal,
    approxSizeBytes: approx,
    screenshotCount,
    castCount,
    chainHead
  }
}

export interface PrepareBundleOptions {
  engagementId: string
  /** operator MUST tick the review checkbox in UI before we accept a build.
   *  Server-side backends should re-check that the manifest carries this flag
   *  before minting a share URL. */
  reviewedByOperator: boolean
  /** max bytes; fail early if the .zip exceeds this. Defaults to the spec cap. */
  maxBytes?: number
  /** override the exports root — mainly useful in tests. */
  outRoot?: string
}

export class RedactionGateError extends Error {
  constructor() { super('operator has not confirmed the redaction preview review — cannot build a cloud-share bundle') }
}

export class BundleTooLargeError extends Error {
  constructor(actual: number, cap: number) {
    super(`bundle is ${actual} bytes, exceeds cap of ${cap}. Split the engagement or raise cloudShare.maxBundleBytes.`)
  }
}

/**
 * Build a share-ready .zip + bundle.json manifest. Throws if:
 *  - the operator has not confirmed the review checkbox (hard gate)
 *  - the resulting .zip exceeds `maxBytes`
 *  - platform lacks a working `zip` binary
 *
 * The .zip's sha256 is committed to `manifest.zipSha256`; a backend that
 * refuses uploads where the received bytes don't hash to what the manifest
 * claims can bounce a modified bundle before it lands.
 */
export function prepareCloudShareBundle(opts: PrepareBundleOptions): PreparedBundle {
  if (!opts.reviewedByOperator) throw new RedactionGateError()
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BUNDLE_BYTES

  const local = exportBundle(opts.engagementId, opts.outRoot)
  const zipPath = local.outDir + '.zip'
  runZip(local.outDir, zipPath)

  const stat = fs.statSync(zipPath)
  if (stat.size > maxBytes) {
    // Leave the local export dir in place — the operator may still want it —
    // but drop the oversized .zip so a re-run doesn't accumulate garbage.
    try { fs.unlinkSync(zipPath) } catch { /* ignore */ }
    throw new BundleTooLargeError(stat.size, maxBytes)
  }

  const zipSha256 = crypto.createHash('sha256').update(fs.readFileSync(zipPath)).digest('hex')

  const manifest: BundleManifest = {
    bundleFormat: 1,
    createdAt: new Date().toISOString(),
    engagement: { id: opts.engagementId },
    zipSha256,
    zipBytes: stat.size,
    contents: {
      eventCount: local.manifest.chainHead?.eventCount ?? 0,
      sanitizedEventCount: local.manifest.sanitized.events,
      sanitizedEventCountTotal: local.manifest.sanitized.totalInDb,
      chainHead: local.manifest.chainHead
    }
  }

  // Write the manifest next to the .zip so the local record is complete even
  // if the upload step fails.
  fs.writeFileSync(zipPath + '.manifest.json', JSON.stringify(manifest, null, 2))

  return { zipPath, manifest, localBundle: local }
}

/**
 * Shell out to the system `zip` — on macOS and Linux it's part of the base
 * install; Windows 10+ ships `tar` but not `zip`, so we detect and fall
 * back to `powershell Compress-Archive`.
 */
function runZip(srcDir: string, destZip: string): void {
  if (process.platform === 'win32') {
    // Compress-Archive doesn't overwrite by default; drop any prior first.
    try { fs.unlinkSync(destZip) } catch { /* ignore */ }
    const r = spawnSync('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-Command',
      // -LiteralPath keeps paths with brackets/quotes intact.
      `Compress-Archive -LiteralPath '${srcDir}\\*' -DestinationPath '${destZip}' -Force`
    ], { stdio: ['ignore', 'pipe', 'pipe'], timeout: 60_000 })
    if (r.status !== 0) throw new Error(`Compress-Archive exit ${r.status}: ${r.stderr?.toString() ?? ''}`)
    return
  }
  // POSIX: zip -r <dest> . inside the source dir so archive paths are relative
  const r = spawnSync('zip', ['-qr', destZip, '.'], {
    stdio: ['ignore', 'pipe', 'pipe'],
    cwd: srcDir,
    timeout: 60_000
  })
  if (r.status !== 0) {
    const err = r.stderr?.toString() ?? ''
    if (r.error && (r.error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error('`zip` binary not found — install zip (macOS: preinstalled; Debian/Ubuntu: apt install zip)')
    }
    throw new Error(`zip exit ${r.status}: ${err}`)
  }
}

// Fallback for previewRedaction — avoids the getProjectDir() throw when no
// project is active so the UI can still open the dialog and show zero counts.
function projectDirSafe(): string {
  try {
    // Late-bind to sidestep circular init in tests.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    return (require('./db/index') as { getProjectDir: () => string }).getProjectDir()
  } catch {
    return path.join(homedir(), '.redlog', 'no-project')
  }
}
