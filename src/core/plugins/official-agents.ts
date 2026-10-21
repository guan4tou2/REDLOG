import fs from 'fs'
import * as path from 'path'
import { PLUGIN_API_VERSION, type PluginManifest } from './types'

export interface OfficialAgentPlugin {
  agentKind: 'claude-code' | 'codex' | 'opencode'
  pluginId: string
  name: string
  state: 'not-installed' | 'installed' | 'conflict' | 'error'
  error?: string
}
export type OfficialAgentMutation =
  | { ok: true; changed: boolean; pluginId: string }
  | { ok: false; error: string; changed?: boolean; pluginId?: string }

type Entry = Pick<OfficialAgentPlugin, 'agentKind' | 'pluginId' | 'name'>
const CATALOG: readonly Entry[] = [
  { agentKind: 'claude-code', pluginId: 'official-ai-claude-code', name: 'Claude Code capture' },
  { agentKind: 'codex', pluginId: 'official-ai-codex', name: 'Codex capture' },
  { agentKind: 'opencode', pluginId: 'official-ai-opencode', name: 'OpenCode capture' }
]

// Templates are not plugin directories and are never auto-discovered. This
// installation increment adds metadata only: activation and project-scoped
// transcript access must be wired separately before these can record anything.
function manifestBytes(entry: Entry): string {
  const manifest: PluginManifest = {
    id: entry.pluginId, name: entry.name, version: '1.0.0',
    redlogApi: PLUGIN_API_VERSION, kind: 'pack', author: 'RedLog',
    description: 'Optional RedLog capture integration, not the AI tool itself. Installation alone does not enable recording.',
    contributes: {}
  }
  return JSON.stringify(manifest, null, 2) + '\n'
}

function missing(error: unknown): boolean { return (error as NodeJS.ErrnoException)?.code === 'ENOENT' }
function errorText(error: unknown): string { return String((error as Error)?.message ?? error) }

/** Local, allowlisted integration installation. The main process supplies the
 * user plugin root; renderer input is only one of the three agent names. No
 * transcript paths, project files, network or package manager are involved. */
export function createOfficialAgentPluginManager(root: string): {
  list(): OfficialAgentPlugin[]
  install(agentKind: unknown): OfficialAgentMutation
  uninstall(agentKind: unknown): OfficialAgentMutation
} {
  const find = (id: unknown): Entry | undefined => CATALOG.find(entry => entry.agentKind === id)
  function inspect(entry: Entry): OfficialAgentPlugin {
    try {
      let parent: fs.Stats
      try { parent = fs.lstatSync(root) } catch (e) { if (missing(e)) return { ...entry, state: 'not-installed' }; throw e }
      if (!parent.isDirectory() || parent.isSymbolicLink()) return { ...entry, state: 'error', error: 'Plugin root is not a regular directory' }
      const dir = path.join(root, entry.pluginId)
      let stat: fs.Stats
      try { stat = fs.lstatSync(dir) } catch (e) { if (missing(e)) return { ...entry, state: 'not-installed' }; throw e }
      if (!stat.isDirectory() || stat.isSymbolicLink()) return { ...entry, state: 'conflict', error: 'Integration path is not a regular directory' }
      const files = fs.readdirSync(dir)
      if (files.length !== 1 || files[0] !== 'plugin.json') return { ...entry, state: 'conflict', error: 'Integration directory contains unrecognized files' }
      const file = path.join(dir, 'plugin.json')
      const manifest = fs.lstatSync(file)
      if (!manifest.isFile() || manifest.isSymbolicLink() || manifest.size !== Buffer.byteLength(manifestBytes(entry)) || fs.readFileSync(file, 'utf8') !== manifestBytes(entry)) {
        return { ...entry, state: 'conflict', error: 'Integration manifest is not the managed original' }
      }
      return { ...entry, state: 'installed' }
    } catch (e) { return { ...entry, state: 'error', error: errorText(e) } }
  }
  return {
    list: () => CATALOG.map(inspect),
    install(agentKind) {
      const entry = find(agentKind)
      if (!entry) return { ok: false, error: 'Unknown official AI capture integration' }
      const current = inspect(entry)
      if (current.state === 'installed') return { ok: true, changed: false, pluginId: entry.pluginId }
      if (current.state !== 'not-installed') return { ok: false, error: current.error! }
      const dir = path.join(root, entry.pluginId)
      let created = false
      const staging = path.join(dir, '.plugin.json.installing')
      try {
        fs.mkdirSync(root, { recursive: true })
        // No recursive create at the destination: even an empty foreign
        // directory is not ours to adopt or overwrite.
        fs.mkdirSync(dir)
        created = true
        fs.writeFileSync(staging, manifestBytes(entry), { flag: 'wx', mode: 0o600 })
        fs.renameSync(staging, path.join(dir, 'plugin.json'))
        return { ok: true, changed: true, pluginId: entry.pluginId }
      } catch (e) {
        if (created) {
          try { fs.unlinkSync(staging) } catch { /* only our staging file */ }
          try { fs.rmdirSync(dir) } catch { /* never recursively remove unknown files */ }
        }
        return { ok: false, error: errorText(e) }
      }
    },
    uninstall(agentKind) {
      const entry = find(agentKind)
      if (!entry) return { ok: false, error: 'Unknown official AI capture integration' }
      const current = inspect(entry)
      if (current.state === 'not-installed') return { ok: true, changed: false, pluginId: entry.pluginId }
      if (current.state !== 'installed') return { ok: false, error: current.error! }
      let removed = false
      try {
        const dir = path.join(root, entry.pluginId)
        fs.unlinkSync(path.join(dir, 'plugin.json'))
        removed = true
        fs.rmdirSync(dir)
        return { ok: true, changed: true, pluginId: entry.pluginId }
      } catch (e) {
        return { ok: false, error: errorText(e), ...(removed ? { changed: true, pluginId: entry.pluginId } : {}) }
      }
    }
  }
}
