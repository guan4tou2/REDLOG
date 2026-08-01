import { createHash } from 'crypto'
import { existsSync, readFileSync } from 'fs'
import { isAbsolute, join, normalize } from 'path'
import {
  PLUGIN_API_VERSION, ALL_CAPABILITIES,
  type PluginManifest, type PluginContributes, type PluginTier, type Capability
} from './types'

// Contributions that cause RedLog to execute plugin-supplied code in-process.
// Their presence makes a plugin 'privileged' and subject to the trust gate.
const PRIVILEGED_KEYS: Array<keyof PluginContributes> = ['mcpTools', 'exporters', 'monitors']

export function tierOf(manifest: PluginManifest): PluginTier {
  const c = manifest.contributes ?? {}
  return PRIVILEGED_KEYS.some((k) => typeof c[k] === 'string' && (c[k] as string).length > 0)
    ? 'privileged'
    : 'declarative'
}

/** Files that must be hashed so a code change invalidates a prior trust grant. */
export function codeFilesOf(manifest: PluginManifest): string[] {
  const c = manifest.contributes ?? {}
  return PRIVILEGED_KEYS
    .map((k) => c[k])
    .filter((v): v is string => typeof v === 'string' && v.length > 0)
}

const ID_RE = /^[a-z0-9][a-z0-9-]{1,63}$/
const SEMVER_RE = /^\d+\.\d+\.\d+/

export interface ManifestParse {
  ok: boolean
  manifest?: PluginManifest
  error?: string
}

/** Parse + validate a raw plugin.json object. Rejects anything malformed or unsafe. */
export function validateManifest(raw: unknown, dir: string): ManifestParse {
  if (typeof raw !== 'object' || raw === null) return { ok: false, error: 'manifest is not an object' }
  const m = raw as Record<string, unknown>

  if (typeof m.id !== 'string' || !ID_RE.test(m.id)) {
    return { ok: false, error: 'invalid id (expect lowercase kebab, 2-64 chars)' }
  }
  if (typeof m.name !== 'string' || !m.name.trim()) return { ok: false, error: 'missing name' }
  if (typeof m.version !== 'string' || !SEMVER_RE.test(m.version)) return { ok: false, error: 'invalid version (expect semver)' }
  if (typeof m.redlogApi !== 'number') return { ok: false, error: 'missing redlogApi' }
  if (m.redlogApi > PLUGIN_API_VERSION) {
    return { ok: false, error: `plugin targets API v${m.redlogApi}, this RedLog supports v${PLUGIN_API_VERSION}` }
  }
  if (typeof m.contributes !== 'object' || m.contributes === null) {
    return { ok: false, error: 'missing contributes block' }
  }

  const contributes = m.contributes as PluginContributes

  // Capabilities must be from the known set.
  let capabilities: Capability[] | undefined
  if (m.capabilities !== undefined) {
    if (!Array.isArray(m.capabilities)) return { ok: false, error: 'capabilities must be an array' }
    for (const cap of m.capabilities) {
      if (!ALL_CAPABILITIES.includes(cap as Capability)) return { ok: false, error: `unknown capability: ${cap}` }
    }
    capabilities = m.capabilities as Capability[]
  }

  // Every referenced file (hooks + code) must stay inside the plugin dir and exist.
  // Uses `path.isAbsolute` so `C:\foo`, `c:/foo`, `\\?\C:\`, `\foo\bar` are
  // caught on Windows — the old `rel.startsWith('/')` check missed them.
  // Audit P1-1 (docs/WINDOWS_COMPAT_AUDIT.md).
  for (const rel of collectFileRefs(contributes)) {
    if (isAbsolute(rel)) return { ok: false, error: `unsafe absolute path escapes plugin dir: ${rel}` }
    if (normalize(rel).split(/[\\/]/).includes('..')) {
      return { ok: false, error: `unsafe parent-dir escape in plugin path: ${rel}` }
    }
    if (!existsSync(join(dir, rel))) return { ok: false, error: `referenced file not found: ${rel}` }
  }

  const manifest: PluginManifest = {
    id: m.id,
    name: m.name,
    version: m.version,
    description: typeof m.description === 'string' ? m.description : undefined,
    author: typeof m.author === 'string' ? m.author : undefined,
    homepage: typeof m.homepage === 'string' ? m.homepage : undefined,
    redlogApi: m.redlogApi,
    contributes,
    capabilities,
    signature: typeof m.signature === 'string' ? m.signature : undefined,
    publisher: typeof m.publisher === 'string' ? m.publisher : undefined
  }
  return { ok: true, manifest }
}

/** All manifest-relative file paths a plugin references (hooks + code modules). */
export function collectFileRefs(c: PluginContributes): string[] {
  const refs: string[] = []
  for (const cap of c.capture ?? []) if (cap.hookFile) refs.push(cap.hookFile)
  for (const k of PRIVILEGED_KEYS) {
    const v = c[k]
    if (typeof v === 'string' && v) refs.push(v)
  }
  return refs
}

/**
 * Content hash = sha256 over the canonicalised manifest plus every code file it
 * references. Trust grants pin this hash, so ANY change to the manifest's
 * contributed code (or its capability requests) revokes the grant.
 */
export function computeContentHash(manifest: PluginManifest, dir: string): string {
  const h = createHash('sha256')
  h.update('manifest\0')
  h.update(JSON.stringify({
    id: manifest.id,
    version: manifest.version,
    redlogApi: manifest.redlogApi,
    contributes: manifest.contributes,
    capabilities: manifest.capabilities ?? []
  }))
  for (const rel of codeFilesOf(manifest).sort()) {
    const p = join(dir, rel)
    h.update(`\0file\0${rel}\0`)
    try { h.update(readFileSync(p)) } catch { h.update('MISSING') }
  }
  return h.digest('hex')
}
