import { existsSync, readFileSync, readdirSync, statSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'
import { validateManifest, tierOf, requiresApproval, computeContentHash } from './manifest'
import { grantedHash, isTrusted } from './trust'
import { isDisabled } from './state'
import { PLUGIN_API_VERSION } from './types'
import type { LoadedPlugin, PluginStatus } from './types'

// Discovery roots. A bundled id is reserved: a user plugin that declares one
// is listed as failed and not loaded (see `loadPlugins`).
export function bundledRoot(): string {
  // packaged: <resources>/plugins ; dev: repo/plugins
  const packaged = join(process.resourcesPath ?? '', 'plugins')
  if (process.resourcesPath && existsSync(packaged)) return packaged
  // __dirname in dev/build: out/main or src/core/plugins → climb to repo root
  const devA = join(__dirname, '../../../plugins')
  const devB = join(__dirname, '../../plugins')
  return existsSync(devA) ? devA : devB
}

function userRoot(): string {
  return join(homedir(), '.redlog', 'plugins')
}

function listPluginDirs(root: string): string[] {
  if (!root || !existsSync(root)) return []
  const out: string[] = []
  for (const name of readdirSync(root)) {
    const dir = join(root, name)
    try {
      if (statSync(dir).isDirectory() && existsSync(join(dir, 'plugin.json'))) out.push(dir)
    } catch { /* unreadable entry */ }
  }
  return out
}

function statusFor(p: Omit<LoadedPlugin, 'status'>): PluginStatus {
  if (isDisabled(p.manifest.id)) return 'disabled'
  if (!requiresApproval(p.manifest, p.source)) return 'active'
  // privileged code, a terminal profile, a hook, or a command to show: gated
  // on the operator's approval of this exact content
  const requested = p.manifest.capabilities ?? []
  if (isTrusted(p.manifest.id, p.contentHash, requested)) return 'active'
  const approved = grantedHash(p.manifest.id)
  return approved !== undefined && approved !== p.contentHash ? 'hash-changed' : 'needs-consent'
}

/** Whether a loaded plugin's files are still the content it was loaded with,
 *  and, where approval is needed, still the content the operator approved.
 *  Read again at the moment a command from it is about to be shown: the
 *  status was decided at load, and the file can change after that. */
export function contentStillApproved(p: LoadedPlugin): boolean {
  const now = computeContentHash(p.manifest, p.dir)
  if (now !== p.contentHash) return false
  if (!requiresApproval(p.manifest, p.source)) return true
  return isTrusted(p.manifest.id, now, p.manifest.capabilities ?? [])
}

/** One plugin, whatever is in its folder. A manifest that makes validation
 *  itself throw is that plugin's error and not the loss of every other plugin. */
function loadOne(dir: string, source: 'bundled' | 'user'): LoadedPlugin {
  try {
    return loadChecked(dir, source)
  } catch (e) {
    return errorPlugin(dir, source, `plugin could not be read: ${(e as Error)?.message ?? String(e)}`)
  }
}

function loadChecked(dir: string, source: 'bundled' | 'user'): LoadedPlugin {
  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(join(dir, 'plugin.json'), 'utf-8'))
  } catch (e) {
    return errorPlugin(dir, source, `plugin.json is not valid JSON: ${(e as Error).message}`)
  }
  const parsed = validateManifest(raw, dir)
  if (!parsed.ok || !parsed.manifest) return errorPlugin(dir, source, parsed.error ?? 'invalid manifest')

  const manifest = parsed.manifest
  const tier = tierOf(manifest)
  // §8-4 forward-compat: a manifest one API version ahead is read declaratively,
  // but a code (privileged) plugin one version ahead is refused entirely — we
  // will not run code written against an API this RedLog doesn't implement.
  const apiAhead = manifest.redlogApi > PLUGIN_API_VERSION
  if (apiAhead && tier === 'privileged') {
    return errorPlugin(dir, source,
      `plugin targets API v${manifest.redlogApi} and contributes code; this RedLog (v${PLUGIN_API_VERSION}) reads a newer manifest's declarative parts but will not run its code`)
  }
  const contentHash = computeContentHash(manifest, dir)
  const base: Omit<LoadedPlugin, 'status'> = { manifest, dir, source, tier, contentHash, apiAhead: apiAhead || undefined }
  return { ...base, status: statusFor(base) }
}

function errorPlugin(dir: string, source: 'bundled' | 'user', error: string): LoadedPlugin {
  const id = dir.split(/[\\/]/).pop() ?? 'unknown'
  return {
    manifest: { id, name: id, version: '0.0.0', redlogApi: 0, contributes: {} },
    dir, source, tier: 'declarative', status: 'error', contentHash: '', error
  }
}

/** A user plugin folder that names a bundled plugin's id. It is listed, so the
 *  operator can find and remove it, under an id no manifest can have (`@` is
 *  outside the id pattern): every store and list keyed by id — trust grants,
 *  the disable flag, contribution registries, the Plugins page — keeps seeing
 *  the bundled plugin under its own id and this folder under another. */
function reservedIdPlugin(dir: string, loaded: LoadedPlugin): LoadedPlugin {
  const folder = dir.split(/[\\/]/).pop() ?? 'unknown'
  const error = loaded.status === 'error'
    ? `${loaded.error ?? 'invalid manifest'}; the folder name is reserved by a built-in plugin`
    : `id "${loaded.manifest.id}" is reserved by a built-in plugin; this plugin is not loaded`
  const id = `${folder}@user`
  return {
    manifest: { id, name: folder, version: '0.0.0', redlogApi: 0, contributes: {} },
    dir, source: 'user', tier: 'declarative', status: 'error', contentHash: '', error
  }
}

/**
 * Discover and validate every plugin. A bundled plugin always loads: a user
 * plugin that declares a bundled id, or sits in a folder named after one
 * without a readable manifest, is listed as an error under an id of its own
 * and contributes nothing (08-plugin-system F4). Pure w.r.t. side effects — it
 * reads disk + trust/state stores but changes nothing; callers decide what to
 * do with each plugin based on its status.
 */
export function loadPlugins(): LoadedPlugin[] {
  const byId = new Map<string, LoadedPlugin>()
  for (const dir of listPluginDirs(bundledRoot())) {
    const p = loadOne(dir, 'bundled')
    byId.set(p.manifest.id, p)
  }
  const reserved = new Set(byId.keys())
  for (const dir of listPluginDirs(userRoot())) {
    const p = loadOne(dir, 'user')
    const entry = reserved.has(p.manifest.id) ? reservedIdPlugin(dir, p) : p
    byId.set(entry.manifest.id, entry)
  }
  return [...byId.values()]
}
