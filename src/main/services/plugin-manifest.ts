import fs from 'fs'
import path from 'path'
import yaml from 'js-yaml'

export interface PluginManifest {
  name: string
  version: string
  description: string
  author?: string
  agents?: string[]
  ipcChannels?: string[]
  configSchema?: Record<string, unknown>
  enabled: boolean
}

export interface PluginRegistry {
  plugins: PluginManifest[]
  dir: string
}

export function loadPlugins(projectDir: string): PluginRegistry {
  const dir = path.join(projectDir, 'plugins')
  fs.mkdirSync(dir, { recursive: true })

  const plugins: PluginManifest[] = []

  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true })
    for (const entry of entries) {
      if (!entry.isDirectory()) continue

      const manifestPath = path.join(dir, entry.name, 'manifest.yaml')
      if (!fs.existsSync(manifestPath)) continue

      try {
        const raw = fs.readFileSync(manifestPath, 'utf-8')
        const manifest = yaml.load(raw) as Partial<PluginManifest>
        plugins.push({
          name: manifest.name || entry.name,
          version: manifest.version || '0.0.0',
          description: manifest.description || '',
          author: manifest.author,
          agents: manifest.agents || [],
          ipcChannels: manifest.ipcChannels || [],
          configSchema: manifest.configSchema,
          enabled: manifest.enabled !== false
        })
      } catch { /* skip malformed manifest */ }
    }
  } catch { /* no plugins dir */ }

  return { plugins, dir }
}

export function getEnabledPlugins(projectDir: string): PluginManifest[] {
  return loadPlugins(projectDir).plugins.filter((p) => p.enabled)
}

export function togglePlugin(projectDir: string, pluginName: string, enabled: boolean): boolean {
  const dir = path.join(projectDir, 'plugins', pluginName)
  const manifestPath = path.join(dir, 'manifest.yaml')

  if (!fs.existsSync(manifestPath)) return false

  try {
    const raw = fs.readFileSync(manifestPath, 'utf-8')
    const manifest = yaml.load(raw) as Record<string, unknown>
    manifest.enabled = enabled
    fs.writeFileSync(manifestPath, yaml.dump(manifest, { lineWidth: 120 }))
    return true
  } catch {
    return false
  }
}
