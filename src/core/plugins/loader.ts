import { existsSync, readFileSync, readdirSync, statSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'
import { validateManifest, tierOf, computeContentHash } from './manifest'
import { isTrusted } from './trust'
import { isDisabled } from './state'
import type { LoadedPlugin, PluginStatus } from './types'

// Discovery roots, in precedence order. A user plugin with the same id as a
// bundled one wins (lets operators override a shipped plugin).
function bundledRoot(): string {
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
  if (p.tier === 'declarative') return 'active'
  // privileged: gated on trust
  const requested = p.manifest.capabilities ?? []
  if (isTrusted(p.manifest.id, p.contentHash, requested)) return 'active'
  return 'needs-consent'
}

function loadOne(dir: string, source: 'bundled' | 'user'): LoadedPlugin {
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
  const contentHash = computeContentHash(manifest, dir)
  const base: Omit<LoadedPlugin, 'status'> = { manifest, dir, source, tier, contentHash }
  return { ...base, status: statusFor(base) }
}

function errorPlugin(dir: string, source: 'bundled' | 'user', error: string): LoadedPlugin {
  const id = dir.split(/[\\/]/).pop() ?? 'unknown'
  return {
    manifest: { id, name: id, version: '0.0.0', redlogApi: 0, contributes: {} },
    dir, source, tier: 'declarative', status: 'error', contentHash: '', error
  }
}

/**
 * Discover and validate every plugin. User plugins override bundled ones by id.
 * Pure w.r.t. side effects — it reads disk + trust/state stores but changes
 * nothing; callers decide what to do with each plugin based on its status.
 */
export function loadPlugins(): LoadedPlugin[] {
  const byId = new Map<string, LoadedPlugin>()
  for (const dir of listPluginDirs(bundledRoot())) {
    const p = loadOne(dir, 'bundled')
    byId.set(p.manifest.id, p)
  }
  for (const dir of listPluginDirs(userRoot())) {
    const p = loadOne(dir, 'user')
    byId.set(p.manifest.id, p) // user wins
  }
  return [...byId.values()]
}
