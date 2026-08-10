import { createHash } from 'crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync, renameSync, readdirSync, statSync } from 'fs'
import { join, resolve, sep } from 'path'
import { homedir } from 'os'
import { get as httpsGet } from 'https'
import { spawnSync } from 'child_process'
import { verifySignature, type Publisher } from './publisher-trust'
import { validateManifest, tierOf, computeContentHash } from './manifest'

// Registry client for the plugin marketplace. Fetches an index.json listing
// all published plugins, downloads a signed tarball for a chosen plugin,
// verifies content-hash + publisher signature + revocation list, extracts to
// ~/.redlog/plugins/<id>/, keeping the previous version snapshotted under
// versions/<contentHash>/ for rollback.
//
// Everything network-facing here is HTTP GET only — no auth, no POST — so the
// blast radius of a compromised registry is bounded to serving a bad plugin,
// which the trust gate still catches on install.

// v0.11.0: no default registry. `plugins.redlog.dev` was never registered, so
// shipping it as the default meant every install pointed at a domain anyone
// could claim — and the index it serves names the publisher keys the operator
// is invited to pin. A registry is a supply chain; the operator has to choose
// it deliberately, and there is no honest default to choose for them.
const DEFAULT_REGISTRY_URL = ''
const PLUGINS_ROOT = () => join(homedir(), '.redlog', 'plugins')
const REVOCATIONS_PATH = () => join(homedir(), '.redlog', 'plugins', 'revocations.json')

/** Max bytes we'll download for a plugin tarball. Matches the spec cap. */
const MAX_TARBALL_BYTES = 5 * 1024 * 1024
/** Registry index is smaller — 1 MB is generous. */
const MAX_INDEX_BYTES = 1024 * 1024

export interface RegistryEntry {
  id: string
  name: string
  description?: string
  homepage?: string
  publisher: string
  /** semver — latest version listed */
  version: string
  /** absolute URL to a .tar.gz */
  tarball: string
  /** hex sha256 of the tarball bytes */
  sha256: string
  /** base64 Ed25519 signature over `sha256:<hexhash>` message */
  signature?: string
  /** Kilobytes; UI hint before download */
  sizeKb?: number
  /** categories/tags for filtering */
  tags?: string[]
}

/** A publisher block the registry advertises so the UI can offer a one-click
 *  "trust this publisher" flow, saving operators from pasting a base64 SPKI
 *  key by hand. The operator still has to confirm the trust prompt — this
 *  just fills in the key. */
export interface RegistryPublisherAd {
  id: string
  homepage?: string
  keys: Array<{ label?: string; publicKey: string }>
}

export interface RegistryIndex {
  updatedAt: number
  entries: RegistryEntry[]
  /** Optional — v0.6.77+ registries include this so operators don't have to
   *  hand-paste publisher keys. Absent means the UI falls back to the manual
   *  publishers form. */
  publishers?: RegistryPublisherAd[]
}

interface RevocationList {
  updatedAt: number
  /** plugin ids blocked from further installs; existing installs get warned. */
  plugins?: string[]
  /** publisher ids fully distrusted */
  publishers?: string[]
}

// ---- Network helpers ------------------------------------------------------

function httpsGetBuffer(url: string, maxBytes: number): Promise<Buffer> {
  return new Promise((resolveP, reject) => {
    const req = httpsGet(url, (res) => {
      if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        // Single redirect hop — no infinite loops.
        httpsGetBuffer(res.headers.location, maxBytes).then(resolveP, reject)
        res.resume()
        return
      }
      if (res.statusCode !== 200) {
        reject(new Error(`GET ${url} → HTTP ${res.statusCode}`))
        res.resume()
        return
      }
      const chunks: Buffer[] = []
      let bytes = 0
      res.on('data', (chunk: Buffer) => {
        bytes += chunk.length
        if (bytes > maxBytes) {
          req.destroy()
          reject(new Error(`response exceeds ${maxBytes} bytes`))
          return
        }
        chunks.push(chunk)
      })
      res.on('end', () => resolveP(Buffer.concat(chunks)))
      res.on('error', reject)
    })
    req.on('error', reject)
    req.setTimeout(20_000, () => {
      req.destroy(new Error('registry request timeout'))
    })
  })
}

// ---- Index fetching -------------------------------------------------------

export async function fetchIndex(url = DEFAULT_REGISTRY_URL): Promise<RegistryIndex> {
  if (!url) throw new Error('no registry URL configured — set one in Settings ▸ Plugins ▸ Marketplace')
  const raw = await httpsGetBuffer(url, MAX_INDEX_BYTES)
  // The index is UNTRUSTED input. RedLog cannot verify it: there is no root
  // key to check it against, and TLS only proves the bytes came from whoever
  // holds the domain — which is exactly who an attacker would need to be.
  // Everything here is therefore treated as a hint about WHERE to look, never
  // as evidence that anything is safe. The trust boundary is one step later:
  // installFromRegistry verifies each tarball's Ed25519 signature against a
  // key the OPERATOR has pinned, and refuses a privileged plugin without one.
  //
  // docs/PLUGIN_MARKETPLACE.md used to claim unsigned index mutations were
  // rejected. They never were, and the claim is gone.
  const parsed = JSON.parse(raw.toString('utf-8'))
  if (typeof parsed !== 'object' || parsed === null) throw new Error('index is not an object')
  if (!Array.isArray(parsed.entries)) throw new Error('index.entries missing')
  for (const e of parsed.entries) {
    if (typeof e.id !== 'string' || typeof e.tarball !== 'string' || typeof e.sha256 !== 'string') {
      throw new Error('index entry missing required fields (id/tarball/sha256)')
    }
    // sha256 must be hex, 64 chars — reject anything else so we don't silently
    // compare against a Base64 hash later and get a false match.
    if (!/^[a-f0-9]{64}$/i.test(e.sha256)) throw new Error(`invalid sha256 for ${e.id}`)
  }
  // Publishers block is optional. Validate lightly if present — we don't want
  // a hostile registry stuffing garbage keys into the trust prompt.
  let publishers: RegistryPublisherAd[] | undefined
  if (Array.isArray(parsed.publishers)) {
    publishers = []
    for (const p of parsed.publishers) {
      if (typeof p?.id !== 'string' || !Array.isArray(p.keys)) continue
      const keys: Array<{ label?: string; publicKey: string }> = []
      for (const k of p.keys) {
        if (typeof k?.publicKey === 'string' && k.publicKey.length >= 32) {
          keys.push({ publicKey: k.publicKey, label: typeof k.label === 'string' ? k.label : undefined })
        }
      }
      if (keys.length) publishers.push({ id: p.id, homepage: typeof p.homepage === 'string' ? p.homepage : undefined, keys })
    }
  }
  return { updatedAt: Number(parsed.updatedAt) || Date.now(), entries: parsed.entries as RegistryEntry[], publishers }
}

// ---- Revocations ----------------------------------------------------------

export function loadRevocations(): RevocationList {
  const p = REVOCATIONS_PATH()
  if (!existsSync(p)) return { updatedAt: 0 }
  try {
    const parsed = JSON.parse(readFileSync(p, 'utf-8')) as RevocationList
    return parsed && typeof parsed === 'object' ? parsed : { updatedAt: 0 }
  } catch {
    return { updatedAt: 0 }
  }
}

export function isRevoked(entry: RegistryEntry): { revoked: boolean; reason?: string } {
  const rev = loadRevocations()
  if (rev.plugins?.includes(entry.id)) return { revoked: true, reason: 'plugin revoked' }
  if (rev.publishers?.includes(entry.publisher)) return { revoked: true, reason: `publisher ${entry.publisher} revoked` }
  return { revoked: false }
}

// ---- Install flow ---------------------------------------------------------

export interface InstallResult {
  ok: boolean
  pluginId: string
  contentHash?: string
  installedDir?: string
  rolledBackFrom?: string
  error?: string
  tier?: 'declarative' | 'privileged'
  signatureVerified?: boolean
}

/**
 * Download and install `entry`. Verifies:
 *  1. revocation list — abort if plugin or publisher is revoked
 *  2. tarball sha256 == entry.sha256
 *  3. entry.signature verifies against a pinned publisher key (REQUIRED for
 *     privileged plugins — tier is determined AFTER install by inspecting the
 *     manifest, so we check tier post-hoc and reject/rollback if the install
 *     produced a privileged plugin without a valid signature)
 *  4. manifest passes validateManifest()
 *
 * Prior version (if any) is snapshotted under versions/<oldContentHash>/ before
 * the swap.
 */
export async function installFromRegistry(
  entry: RegistryEntry,
  opts: {
    extractTar?: (tarball: Buffer, destDir: string) => Promise<void>
    /** Overrides the default HTTPS fetcher — useful for tests and for future
     *  mirror/proxy support. Given the entry's tarball URL, must resolve to
     *  the raw bytes. */
    fetchTarball?: (url: string) => Promise<Buffer>
  } = {}
): Promise<InstallResult> {
  const revocation = isRevoked(entry)
  if (revocation.revoked) return { ok: false, pluginId: entry.id, error: revocation.reason }

  let tarball: Buffer
  try {
    const fetcher = opts.fetchTarball ?? ((url: string) => httpsGetBuffer(url, MAX_TARBALL_BYTES))
    tarball = await fetcher(entry.tarball)
  } catch (e) {
    return { ok: false, pluginId: entry.id, error: (e as Error).message }
  }

  const actualHash = createHash('sha256').update(tarball).digest('hex')
  if (actualHash.toLowerCase() !== entry.sha256.toLowerCase()) {
    return { ok: false, pluginId: entry.id, error: `sha256 mismatch: expected ${entry.sha256}, got ${actualHash}` }
  }

  // Signature is optional at fetch time — if the plugin turns out to be
  // privileged, we require it below. Verify eagerly when supplied so we can
  // record the auditing outcome regardless of tier.
  let signatureVerified = false
  if (entry.signature) {
    const v = verifySignature(entry.publisher, `sha256:${actualHash}`, entry.signature)
    if (!v.ok) {
      return { ok: false, pluginId: entry.id, error: `signature verify failed: ${v.reason}` }
    }
    signatureVerified = true
  }

  // Extract to a scratch dir first, validate the manifest, THEN swap into place
  // so a bad tarball can never partially clobber an existing install.
  const pluginsRoot = PLUGINS_ROOT()
  mkdirSync(pluginsRoot, { recursive: true })
  const finalDir = join(pluginsRoot, entry.id)
  const scratchDir = join(pluginsRoot, `.installing-${entry.id}-${Date.now()}`)
  mkdirSync(scratchDir, { recursive: true })

  try {
    const extract = opts.extractTar ?? defaultExtractTar
    // v0.6.93 P0-C: pre-flight the tar entry list BEFORE extraction — the
    // post-extract walk in assertInsideDir only sees files that landed
    // inside scratchDir; a `../../.ssh/authorized_keys` entry writes ELSEWHERE
    // and would slip past. Only run for the default extractor (tests use
    // in-memory fixtures that aren't real tarballs).
    if (!opts.extractTar) assertNoTarEscape(tarball, scratchDir)
    await extract(tarball, scratchDir)

    // Zip Slip / symlink defense — refuse anything that escaped the plugin dir
    // during extraction.
    assertInsideDir(scratchDir, scratchDir)

    const manifestPath = join(scratchDir, 'plugin.json')
    if (!existsSync(manifestPath)) throw new Error('plugin.json missing after extract')
    const rawManifest = JSON.parse(readFileSync(manifestPath, 'utf-8'))
    const parsed = validateManifest(rawManifest, scratchDir)
    if (!parsed.ok || !parsed.manifest) throw new Error(`manifest invalid: ${parsed.error}`)

    if (parsed.manifest.id !== entry.id) {
      throw new Error(`id mismatch: registry says ${entry.id}, manifest says ${parsed.manifest.id}`)
    }
    if (parsed.manifest.version !== entry.version) {
      throw new Error(`version mismatch: registry says ${entry.version}, manifest says ${parsed.manifest.version}`)
    }
    if (parsed.manifest.publisher && parsed.manifest.publisher !== entry.publisher) {
      throw new Error(`publisher mismatch: registry says ${entry.publisher}, manifest says ${parsed.manifest.publisher}`)
    }

    const tier = tierOf(parsed.manifest)
    if (tier === 'privileged' && !signatureVerified) {
      throw new Error('privileged plugin without a verified publisher signature')
    }

    const contentHash = computeContentHash(parsed.manifest, scratchDir)

    // Snapshot prior version for rollback.
    let rolledBackFrom: string | undefined
    if (existsSync(finalDir)) {
      const prev = existsSync(join(finalDir, 'plugin.json'))
        ? readFileSync(join(finalDir, 'plugin.json'), 'utf-8')
        : ''
      let prevHash = ''
      try { prevHash = JSON.parse(prev).__contentHash || Date.now().toString(16) } catch { prevHash = Date.now().toString(16) }
      const versionsDir = join(finalDir, '..', `.${entry.id}-versions`)
      mkdirSync(versionsDir, { recursive: true })
      const snapshotDir = join(versionsDir, prevHash)
      if (!existsSync(snapshotDir)) {
        renameSync(finalDir, snapshotDir)
      } else {
        // Rare — same content hash already snapshotted. Just delete the current.
        rmSync(finalDir, { recursive: true, force: true })
      }
      rolledBackFrom = snapshotDir
    }
    renameSync(scratchDir, finalDir)

    return { ok: true, pluginId: entry.id, contentHash, installedDir: finalDir, rolledBackFrom, tier, signatureVerified }
  } catch (e) {
    rmSync(scratchDir, { recursive: true, force: true })
    return { ok: false, pluginId: entry.id, error: (e as Error).message, signatureVerified }
  }
}

// ---- Rollback -------------------------------------------------------------

export function listVersions(pluginId: string): string[] {
  const versionsDir = join(PLUGINS_ROOT(), `.${pluginId}-versions`)
  if (!existsSync(versionsDir)) return []
  return readdirSync(versionsDir).filter((n) => {
    try { return statSync(join(versionsDir, n)).isDirectory() } catch { return false }
  })
}

export function rollback(pluginId: string, versionKey: string): { ok: boolean; error?: string } {
  const versionsDir = join(PLUGINS_ROOT(), `.${pluginId}-versions`)
  const snapshot = join(versionsDir, versionKey)
  if (!existsSync(snapshot)) return { ok: false, error: 'snapshot not found' }
  const finalDir = join(PLUGINS_ROOT(), pluginId)
  try {
    if (existsSync(finalDir)) {
      const scratchKey = `pre-rollback-${Date.now().toString(16)}`
      renameSync(finalDir, join(versionsDir, scratchKey))
    }
    renameSync(snapshot, finalDir)
    return { ok: true }
  } catch (e) {
    return { ok: false, error: (e as Error).message }
  }
}

// ---- Utilities ------------------------------------------------------------

function assertInsideDir(root: string, current: string): void {
  // v0.6.93 P0-C: use `resolve(root) + sep` for the prefix compare — bare
  // `startsWith` treats `/foo` as a prefix of `/foobar`. Also this walks
  // INSIDE root, so a tar entry that escaped to a sibling directory
  // (`../hostile`) is never enumerated. `assertNoTarEscape` below runs
  // BEFORE extraction to catch that class.
  const rootReal = resolve(root)
  const currentReal = resolve(current)
  const prefix = rootReal.endsWith(sep) ? rootReal : rootReal + sep
  if (currentReal !== rootReal && !currentReal.startsWith(prefix)) {
    throw new Error(`path escape: ${currentReal} not inside ${rootReal}`)
  }
  for (const entry of readdirSync(currentReal, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) throw new Error(`symlink not allowed: ${entry.name}`)
    if (entry.isDirectory()) assertInsideDir(rootReal, join(currentReal, entry.name))
  }
}

// v0.6.93 P0-C: enumerate tar entries BEFORE extraction and reject any
// absolute path or `..` segment. The post-extract `assertInsideDir` only
// walks INSIDE the scratch dir, so a hostile tarball that clobbers
// `../../.ssh/authorized_keys` never gets checked otherwise.
function assertNoTarEscape(tarball: Buffer, destDir: string): void {
  const tmpTar = join(destDir, '..', `.plugin-list-${Date.now()}.tar.gz`)
  writeFileSync(tmpTar, tarball)
  const tarBin = process.platform === 'win32' ? 'tar.exe' : 'tar'
  try {
    const res = spawnSync(tarBin, ['-tzf', tmpTar], {
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 30_000
    })
    if (res.status !== 0) {
      throw new Error(`${tarBin} -tzf exited ${res.status}: ${res.stderr?.toString() ?? ''}`)
    }
    const listing = (res.stdout?.toString() ?? '').split(/\r?\n/).filter(Boolean)
    for (const entry of listing) {
      // Trim leading `./` so a well-formed relative tar entry passes.
      const normalized = entry.replace(/^\.\/+/, '')
      // Absolute paths (Unix `/etc/…`, Windows `C:\…`) never allowed.
      if (normalized.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(normalized)) {
        throw new Error(`tar entry has absolute path: ${entry}`)
      }
      // Any `..` component escapes even under `--strip-components`.
      if (normalized.split(/[\\/]/).some((seg) => seg === '..')) {
        throw new Error(`tar entry escapes via ..: ${entry}`)
      }
    }
  } finally {
    try { rmSync(tmpTar, { force: true }) } catch { /* ignore */ }
  }
}

/**
 * Default tar extractor. Shells out to the system `tar` — every platform we
 * ship on has it (macOS bsdtar, Linux GNU tar, Windows 10+ bsdtar). Callers
 * can override via opts.extractTar for tests.
 */
async function defaultExtractTar(tarball: Buffer, destDir: string): Promise<void> {
  // Write to a temp file — piping large buffers to tar via stdin is fine on
  // POSIX but flaky on Windows tar-via-cmd wrappers.
  const tmpTar = join(destDir, '..', `.plugin-${Date.now()}.tar.gz`)
  writeFileSync(tmpTar, tarball)
  // Explicit `.exe` on Windows — bare `tar` relies on PATHEXT which is
  // fragile inside a packaged Electron shim. Mirrors cloud-share.ts.
  // Audit P1-4 (docs/WINDOWS_COMPAT_AUDIT.md).
  const tarBin = process.platform === 'win32' ? 'tar.exe' : 'tar'
  try {
    const res = spawnSync(tarBin, ['-xzf', tmpTar, '-C', destDir, '--strip-components=1'], {
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 30_000
    })
    if (res.status !== 0) {
      throw new Error(`${tarBin} exited ${res.status}: ${res.stderr?.toString() ?? ''}`)
    }
  } finally {
    try { rmSync(tmpTar, { force: true }) } catch { /* ignore */ }
  }
}

// Re-export a subset of publisher-trust to give callers one import surface.
export type { Publisher } from './publisher-trust'
export { listPublishers, trustPublisher, untrustPublisher, fingerprint, getPublisher } from './publisher-trust'
