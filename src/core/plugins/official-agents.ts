import fs from 'node:fs'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { PLUGIN_API_VERSION } from './types'

export interface AgentSourceLocation {
  defaultPath: string
  configEnv?: string
  envSuffix?: string
}
export interface OfficialAgentPlugin {
  agentKind: string
  pluginId: string
  name: string
  source: AgentSourceLocation
  installationId?: string
  state: 'not-installed' | 'installed' | 'update-available' | 'conflict' | 'error'
  error?: string
}
export type OfficialAgentMutation =
  | { ok: true; changed: boolean; pluginId: string }
  | { ok: false; error: string; changed?: boolean; pluginId?: string }
interface Package {
  manifest: Record<string, unknown>
  agentKind: string
  pluginId: string
  name: string
  source: AgentSourceLocation
  order: number
  code: Buffer
}
const sha256 = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex')
const missing = (e: unknown): boolean => (e as NodeJS.ErrnoException)?.code === 'ENOENT'
const errorText = (e: unknown): string => String((e as Error)?.message ?? e)
const safeRelative = (p: unknown): p is string => typeof p === 'string' && !!p && !path.isAbsolute(p) && !p.split(/[\\/]/).includes('..')

/** Inert packages are outside the discoverable bundled plugin root. */
export function optionalAgentPackagesRoot(): string {
  const packaged = path.join(process.resourcesPath ?? '', 'optional-ai')
  if (process.resourcesPath && fs.existsSync(packaged)) return packaged
  const built = path.resolve(__dirname, '../optional-ai')
  return fs.existsSync(built) ? built : path.resolve(__dirname, '../../../out/optional-ai')
}

function packages(root: string): Package[] {
  const items = fs.readdirSync(root, { withFileTypes: true }).filter(e => e.isDirectory()).map(e => {
    const dir = path.join(root, e.name)
    const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'plugin.json'), 'utf8'))
    const a = manifest.redlogAgent
    if (manifest.redlogApi !== PLUGIN_API_VERSION || !/^[a-z0-9][a-z0-9-]{1,63}$/.test(manifest.id)
      || !a || !/^[a-z0-9][a-z0-9-]{1,63}$/.test(a.agentKind) || a.entry !== 'adapter.cjs'
      || !a.source || !safeRelative(a.source.defaultPath)
      || (a.source.configEnv !== undefined && !/^[A-Z][A-Z0-9_]*$/.test(a.source.configEnv))
      || (a.source.envSuffix !== undefined && !safeRelative(a.source.envSuffix))) throw new Error(`Invalid optional AI package: ${e.name}`)
    const codePath = path.join(dir, 'adapter.cjs')
    const stat = fs.lstatSync(codePath)
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4 * 1024 * 1024) throw new Error(`Invalid AI adapter: ${e.name}`)
    const code = fs.readFileSync(codePath)
    if (sha256(code) !== a.sha256) throw new Error(`AI package checksum mismatch: ${e.name}`)
    return { manifest, code, agentKind: a.agentKind, pluginId: manifest.id, name: manifest.name, source: a.source, order: Number(a.order) || 0 }
  })
  if (new Set(items.map(p => p.agentKind)).size !== items.length || new Set(items.map(p => p.pluginId)).size !== items.length) throw new Error('Duplicate optional AI package identity')
  return items.sort((a, b) => a.order - b.order || a.pluginId.localeCompare(b.pluginId))
}
function manifestBytes(p: Package, installationId: string): string {
  return JSON.stringify({ ...p.manifest, redlogInstallationId: installationId }, null, 2) + '\n'
}

/** Only app-supplied, checksum-matching packages may execute in this host.
 * Third-party executable tailers remain refused by the generic plugin system. */
export function createOfficialAgentPluginManager(root: string, packageRoot = optionalAgentPackagesRoot()): {
  list(): OfficialAgentPlugin[]
  install(agentKind: unknown): OfficialAgentMutation
  uninstall(agentKind: unknown): OfficialAgentMutation
  modulePath(agentKind: string): string | undefined
} {
  const available = (): Package[] => packages(packageRoot)
  type Receipt = { installationId: string; manifestHash: string; codeHash: string }
  const ledgerPath = path.join(root, '.official-ai-installations.json')
  function receipts(): Record<string, Receipt> {
    if (!fs.existsSync(ledgerPath)) return {}
    const st = fs.lstatSync(ledgerPath)
    if (!st.isFile() || st.isSymbolicLink() || st.size > 1024 * 1024) throw new Error('Invalid AI installation records')
    const value = JSON.parse(fs.readFileSync(ledgerPath, 'utf8'))
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid AI installation records')
    return value
  }
  function saveReceipt(p: Package, installationId?: string): void {
    const all = receipts()
    if (installationId) all[p.pluginId] = { installationId, manifestHash: sha256(Buffer.from(manifestBytes(p, installationId))), codeHash: sha256(p.code) }
    else delete all[p.pluginId]
    const tmp = ledgerPath + '.' + randomUUID() + '.tmp'
    try {
      fs.writeFileSync(tmp, JSON.stringify(all), { flag: 'wx', mode: 0o600 })
      fs.renameSync(tmp, ledgerPath)
    } finally { if (fs.existsSync(tmp)) fs.unlinkSync(tmp) }
  }
  function inspect(p: Package): OfficialAgentPlugin {
    const entry = { agentKind: p.agentKind, pluginId: p.pluginId, name: p.name, source: p.source }
    try {
      let parent: fs.Stats
      try { parent = fs.lstatSync(root) } catch (e) { if (missing(e)) return { ...entry, state: 'not-installed' }; throw e }
      if (!parent.isDirectory() || parent.isSymbolicLink()) return { ...entry, state: 'error', error: 'Plugin root is not a regular directory' }
      const dir = path.join(root, p.pluginId)
      let stat: fs.Stats
      try { stat = fs.lstatSync(dir) } catch (e) { if (missing(e)) return { ...entry, state: 'not-installed' }; throw e }
      if (!stat.isDirectory() || stat.isSymbolicLink()) return { ...entry, state: 'conflict', error: 'Integration path is not a regular directory' }
      const files = fs.readdirSync(dir).sort()
      if (files.join(',') !== 'adapter.cjs,plugin.json') return { ...entry, state: 'conflict', error: 'Integration directory contains unrecognized or missing files' }
      for (const file of files) {
        const st = fs.lstatSync(path.join(dir, file))
        if (!st.isFile() || st.isSymbolicLink() || st.size > 4 * 1024 * 1024) return { ...entry, state: 'conflict', error: 'Integration is not a managed file' }
      }
      const bytes = fs.readFileSync(path.join(dir, 'plugin.json'), 'utf8')
      let installationId: string
      try { installationId = JSON.parse(bytes).redlogInstallationId } catch { return { ...entry, state: 'conflict', error: 'Integration manifest is not valid JSON' } }
      const code = fs.readFileSync(path.join(dir, 'adapter.cjs'))
      const receipt = receipts()[p.pluginId]
      if (typeof installationId !== 'string' || !/^[0-9a-f-]{36}$/.test(installationId)
        || !receipt || receipt.installationId !== installationId
        || receipt.manifestHash !== sha256(Buffer.from(bytes)) || receipt.codeHash !== sha256(code)) {
        return { ...entry, state: 'conflict', error: 'Integration differs from its installation record' }
      }
      if (bytes !== manifestBytes(p, installationId) || !code.equals(p.code)) return { ...entry, state: 'update-available', installationId }
      return { ...entry, state: 'installed', installationId }
    } catch (e) { return { ...entry, state: 'error', error: errorText(e) } }
  }
  const find = (id: unknown): Package | undefined => available().find(p => p.agentKind === id)
  return {
    list: () => available().map(inspect),
    modulePath(kind) {
      const p = find(kind)
      return p && inspect(p).state === 'installed' ? path.join(root, p.pluginId, 'adapter.cjs') : undefined
    },
    install(kind) {
      const p = find(kind)
      if (!p) return { ok: false, error: 'Unknown official AI capture integration' }
      const current = inspect(p)
      if (current.state === 'installed') return { ok: true, changed: false, pluginId: p.pluginId }
      if (current.state === 'update-available') {
        const dir = path.join(root, p.pluginId)
        const staging = path.join(root, '.' + p.pluginId + '.' + randomUUID())
        const backup = staging + '.previous'
        let swapped = false
        try {
          fs.mkdirSync(staging)
          fs.writeFileSync(path.join(staging, 'adapter.cjs'), p.code, { flag: 'wx', mode: 0o600 })
          fs.writeFileSync(path.join(staging, 'plugin.json'), manifestBytes(p, current.installationId!), { flag: 'wx', mode: 0o600 })
          fs.renameSync(dir, backup)
          try { fs.renameSync(staging, dir) } catch (e) { fs.renameSync(backup, dir); throw e }
          swapped = true
          try { saveReceipt(p, current.installationId!) } catch (e) {
            fs.renameSync(dir, staging); fs.renameSync(backup, dir); swapped = false; throw e
          }
          for (const file of ['plugin.json', 'adapter.cjs']) fs.unlinkSync(path.join(backup, file))
          fs.rmdirSync(backup)
          return { ok: true, changed: true, pluginId: p.pluginId }
        } catch (e) { return { ok: false, error: errorText(e), changed: swapped || undefined, pluginId: p.pluginId } }
        finally {
          if (fs.existsSync(staging)) {
            for (const file of ['plugin.json', 'adapter.cjs']) if (fs.existsSync(path.join(staging, file))) fs.unlinkSync(path.join(staging, file))
            fs.rmdirSync(staging)
          }
        }
      }
      if (current.state !== 'not-installed') return { ok: false, error: current.error! }
      const dir = path.join(root, p.pluginId)
      let created = false
      const owned: string[] = []
      try {
        fs.mkdirSync(root, { recursive: true }); fs.mkdirSync(dir); created = true
        const code = path.join(dir, 'adapter.cjs')
        fs.writeFileSync(code, p.code, { flag: 'wx', mode: 0o600 }); owned.push(code)
        const staging = path.join(dir, '.plugin.json.installing')
        fs.writeFileSync(staging, manifestBytes(p, randomUUID()), { flag: 'wx', mode: 0o600 }); owned.push(staging)
        const manifestPath = path.join(dir, 'plugin.json')
        fs.renameSync(staging, manifestPath); owned.push(manifestPath)
        const installationId = JSON.parse(fs.readFileSync(manifestPath, 'utf8')).redlogInstallationId as string
        saveReceipt(p, installationId)
        return { ok: true, changed: true, pluginId: p.pluginId }
      } catch (e) {
        if (created) {
          for (const file of owned) try { fs.unlinkSync(file) } catch { /* only files created here */ }
          try { fs.rmdirSync(dir) } catch { /* preserve foreign files */ }
        }
        return { ok: false, error: errorText(e) }
      }
    },
    uninstall(kind) {
      const p = find(kind)
      if (!p) return { ok: false, error: 'Unknown official AI capture integration' }
      const current = inspect(p)
      if (current.state === 'not-installed') return { ok: true, changed: false, pluginId: p.pluginId }
      if (current.state !== 'installed' && current.state !== 'update-available') return { ok: false, error: current.error! }
      let removed = false
      try {
        const dir = path.join(root, p.pluginId)
        fs.unlinkSync(path.join(dir, 'plugin.json')); removed = true
        fs.unlinkSync(path.join(dir, 'adapter.cjs')); fs.rmdirSync(dir); saveReceipt(p)
        return { ok: true, changed: true, pluginId: p.pluginId }
      } catch (e) { return { ok: false, error: errorText(e), changed: removed || undefined, pluginId: removed ? p.pluginId : undefined } }
    }
  }
}
