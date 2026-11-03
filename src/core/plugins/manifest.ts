import { createHash } from 'crypto'
import { existsSync, readFileSync } from 'fs'
import { isAbsolute, join, normalize } from 'path'
import {
  PLUGIN_API_VERSION, ALL_CAPABILITIES,
  type PluginManifest, type PluginContributes, type PluginTier, type Capability
} from './types'

// Contributions that cause RedLog to execute plugin-supplied code in-process.
// Their presence makes a plugin 'privileged' and subject to the trust gate.
const PRIVILEGED_KEYS: Array<keyof PluginContributes> = ['tailers']

/** Contributions RedLog once declared and never ran. Refused by name: a
 *  plugin shipping one expects it to take effect, and loading the rest of the
 *  plugin while silently dropping it would look like success. */
const RETIRED_KEYS: Record<string, string> = {
  exporters: 'RedLog has no host to run plugin code of this kind',
  monitors: 'RedLog has no host to run plugin code of this kind',
  // Mappers normalise raw bytes posted to POST /api/ingest, which was never
  // built (docs/DESIGN-plugin-kernel.md §3); a registered mapper ran nowhere.
  mappers: 'nothing applies mappers yet — producers post normalised events to POST /api/events'
}

/** The install methods a plugin's capture entry may name. `powershell-profile`
 *  is the built-in PowerShell producer's own and is not offered to plugins. */
const PLUGIN_INSTALL_METHODS = ['claude-settings', 'shell-source', 'manual'] as const

/** The shell startup files a `shell-source` capture may name. */
const PLUGIN_SHELL_RC_FILES = ['.zshrc', '.bashrc', '.bash_profile', '.profile'] as const

/** A shell-source hook is copied to a file of this name directly inside
 *  ~/.redlog: no folder, nothing that starts with a dot, and a script's
 *  extension, so it cannot be written over a data file RedLog keeps there. */
const HOOK_FILE_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*\.(?:sh|zsh|bash)$/

/** Whether a capture entry puts something on the machine for the operator
 *  (their shell startup file, Claude Code's settings) rather than showing them
 *  steps to follow. Anything that is not exactly `manual` does: an entry that
 *  names no method is not given the benefit of the doubt. */
export function installsHook(cap: unknown): boolean {
  return (cap as { installMethod?: unknown } | null)?.installMethod !== 'manual'
}

/** Why a capture entry's install fields are not acceptable from a plugin, or
 *  null. The fields decide what RedLog writes and where: a file under
 *  ~/.redlog, a line in a shell startup file, an entry in Claude Code's
 *  settings. They are therefore an enum and two short fixed shapes, and are
 *  refused rather than rewritten. */
export function captureInstallProblem(cap: {
  installMethod?: unknown; installTarget?: unknown; shellRcFile?: unknown; hookFile?: unknown
}): string | null {
  if (!(PLUGIN_INSTALL_METHODS as readonly unknown[]).includes(cap.installMethod)) {
    return `installMethod must be one of ${PLUGIN_INSTALL_METHODS.join(', ')}`
  }
  if (cap.installTarget !== undefined
    && !(typeof cap.installTarget === 'string' && HOOK_FILE_NAME_RE.test(cap.installTarget))) {
    return 'installTarget must be a file name ending in .sh, .zsh or .bash, with no folder: the hook is written to ~/.redlog'
  }
  if (cap.shellRcFile !== undefined
    && !(PLUGIN_SHELL_RC_FILES as readonly unknown[]).includes(cap.shellRcFile)) {
    return `shellRcFile must be one of ${PLUGIN_SHELL_RC_FILES.join(', ')}`
  }
  if (cap.installMethod === 'shell-source' && cap.installTarget === undefined && typeof cap.hookFile === 'string') {
    const written = cap.hookFile.split(/[\\/]/).pop() ?? ''
    if (!HOOK_FILE_NAME_RE.test(written)) {
      return `a shell-source hook is written to ~/.redlog under its own file name, which must end in .sh, .zsh or .bash (got ${written})`
    }
  }
  return null
}

/** Whether the plugin must be approved by the operator, at its current
 *  content, before anything it contributes takes effect. Everything that runs
 *  code does (the `privileged` tier). So does a plugin that declares
 *  `terminalProfiles`, which runs nothing: a profile decides what the shell
 *  records and what it leaves alone, so a manifest dropped into the plugins
 *  folder must not be able to set it unasked. So does a plugin with a capture
 *  entry that RedLog installs (`shell-source`, `claude-settings`): the hook
 *  becomes a script that runs in every new shell, or after every tool call.
 *  Everything else is data RedLog reads and is active from the start. */
export function requiresApproval(manifest: PluginManifest): boolean {
  const c = manifest.contributes ?? {}
  return tierOf(manifest) === 'privileged'
    || (Array.isArray(c.terminalProfiles) && c.terminalProfiles.length > 0)
    || (Array.isArray(c.capture) && c.capture.some(installsHook))
}

/** The capture entries an approval is an approval of: the ones that install. */
export function installingCaptures(manifest: PluginManifest): Array<{ name: string; installMethod: string }> {
  return (manifest.contributes?.capture ?? []).filter(installsHook)
    .map((cap) => ({ name: String(cap.name ?? cap.id), installMethod: String(cap.installMethod) }))
}

export function tierOf(manifest: PluginManifest): PluginTier {
  const c = manifest.contributes ?? {}
  return PRIVILEGED_KEYS.some((k) => typeof c[k] === 'string' && (c[k] as string).length > 0)
    ? 'privileged'
    : 'declarative'
}

/** Files that must be hashed so a code change invalidates a prior trust grant.
 *
 *  v0.11.0: `capture[].hookFile` is included. It was previously left out
 *  because capture integrations are the 🟢 declarative tier and "declarative"
 *  was read as "not code" — but a capture hook IS a shell script, one the
 *  operator sources into their own `~/.zshrc` and which then runs on every
 *  command they type. Excluding it meant its contents could change on an
 *  update with no hash change and therefore no re-consent: exactly the
 *  scenario content-hash pinning exists to prevent, on the file with the
 *  broadest execution reach in the whole plugin model.
 *
 *  `collectFileRefs` already listed it for path-safety validation, so the
 *  omission was in the hashing, not the parsing. */
export function codeFilesOf(manifest: PluginManifest): string[] {
  const c = manifest.contributes ?? {}
  const files = PRIVILEGED_KEYS
    .map((k) => c[k])
    .filter((v): v is string => typeof v === 'string' && v.length > 0)
  for (const cap of c.capture ?? []) {
    if (typeof cap?.hookFile === 'string' && cap.hookFile) files.push(cap.hookFile)
  }
  return files
}

const ID_RE = /^[a-z0-9][a-z0-9-]{1,63}$/
const SEMVER_RE = /^\d+\.\d+\.\d+/

export interface ManifestParse {
  ok: boolean
  manifest?: PluginManifest
  error?: string
}

/** Parse + validate a raw plugin.json object. Rejects anything malformed or unsafe. */
const PLUGIN_KINDS = new Set(['producer', 'mapper', 'enrichment', 'exporter', 'pack'])
function isPluginKind(v: unknown): v is NonNullable<PluginManifest['kind']> {
  return typeof v === 'string' && PLUGIN_KINDS.has(v)
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)
const isStringList = (v: unknown): boolean => Array.isArray(v) && v.every((s) => typeof s === 'string')

/** Why `contributes` has a shape `applyContributions` cannot take, or null.
 *  It reads each list with `.map` or `for..of`, and each entry's strings with
 *  `.trim`, `.startsWith` and `.replaceAll`, so a value of another shape does
 *  not make a plugin that contributes less: it throws, in the middle of
 *  applying everyone. Every key that function reads is checked here, in the
 *  detail it needs; what an entry's own fields mean is for the registrars to
 *  judge, entry by entry, at load. `terminalProfiles` is in `validateManifest`
 *  itself, where its message is. */
function contributesShapeError(c: Record<string, unknown>): string | null {
  for (const key of ['lootPatterns', 'commandTags', 'targetExtractors', 'eventTypes', 'capture']) {
    const v = c[key]
    if (v !== undefined && !(Array.isArray(v) && v.every(isObject))) return `contributes.${key} must be a list of objects`
  }
  for (const key of ['lootPatterns', 'targetExtractors']) {
    for (const entry of (c[key] ?? []) as Array<Record<string, unknown>>) {
      if (entry.name !== undefined && typeof entry.name !== 'string') return `contributes.${key}: name must be text`
    }
  }
  if (c.redaction !== undefined) {
    if (!isObject(c.redaction)) return 'contributes.redaction must be an object'
    // A plugin can only add to what is masked. Letting a value through is the
    // operator's setting: a plugin allowlist is checked before the denylist and
    // before the values loot detection found, so it could switch masking off
    // at ingest, and the spans fixed there are what an export is masked by.
    if (c.redaction.allowlist !== undefined) {
      return 'contributes.redaction.allowlist is not supported: a plugin can only add to what is masked; letting a value through is the operator\'s setting'
    }
    if (c.redaction.denylist !== undefined && !Array.isArray(c.redaction.denylist)) return 'contributes.redaction.denylist must be a list'
  }
  for (const cap of (c.capture ?? []) as Array<Record<string, unknown>>) {
    if (cap.id !== undefined && typeof cap.id !== 'string') return 'contributes.capture: id must be text'
    if (cap.hookFile !== undefined && typeof cap.hookFile !== 'string') return 'contributes.capture: hookFile must be text'
    for (const list of ['requires', 'emits']) {
      if (cap[list] !== undefined && !isStringList(cap[list])) return `contributes.capture: ${list} must be a list of text`
    }
    if (cap.manualSteps !== undefined) {
      const steps = cap.manualSteps
      if (!Array.isArray(steps) || !steps.every((s) => isObject(s) && typeof s.label === 'string'
        && (s.command === undefined || typeof s.command === 'string'))) {
        return 'contributes.capture: manualSteps must be a list of steps with a text label'
      }
    }
  }
  if (c.tailers !== undefined && typeof c.tailers !== 'string') return 'contributes.tailers must be the path of a module'
  return null
}

export function validateManifest(raw: unknown, dir: string): ManifestParse {
  if (typeof raw !== 'object' || raw === null) return { ok: false, error: 'manifest is not an object' }
  const m = raw as Record<string, unknown>

  if (typeof m.id !== 'string' || !ID_RE.test(m.id)) {
    return { ok: false, error: 'invalid id (expect lowercase kebab, 2-64 chars)' }
  }
  if (typeof m.name !== 'string' || !m.name.trim()) return { ok: false, error: 'missing name' }
  if (typeof m.version !== 'string' || !SEMVER_RE.test(m.version)) return { ok: false, error: 'invalid version (expect semver)' }
  if (typeof m.redlogApi !== 'number') return { ok: false, error: 'missing redlogApi' }
  // Forward-compat (§8-4): read manifests up to ONE API version ahead so a pack
  // built for the next RedLog still loads its declarative parts here (unknown
  // contribution keys are ignored by applyContributions). The loader flags such
  // a plugin `apiAhead` and refuses to run a code (privileged) plugin's newer
  // code. Two versions ahead is too far to interpret safely — reject.
  if (m.redlogApi > PLUGIN_API_VERSION + 1) {
    return { ok: false, error: `plugin targets API v${m.redlogApi}; this RedLog supports v${PLUGIN_API_VERSION} and reads v${PLUGIN_API_VERSION + 1} declaratively` }
  }
  if (typeof m.contributes !== 'object' || m.contributes === null) {
    return { ok: false, error: 'missing contributes block' }
  }
  const shapeError = contributesShapeError(m.contributes as Record<string, unknown>)
  if (shapeError) return { ok: false, error: shapeError }

  for (const [retired, why] of Object.entries(RETIRED_KEYS)) {
    if ((m.contributes as Record<string, unknown>)[retired] !== undefined) {
      return { ok: false, error: `contributes.${retired} is not supported: ${why}` }
    }
  }

  const contributes = m.contributes as PluginContributes
  // The list's own entries are judged one by one at load (`registerTerminalProfiles`),
  // so one bad profile does not cost the plugin; only a value that is not a list at all does.
  if ((contributes as Record<string, unknown>).terminalProfiles !== undefined
    && !Array.isArray(contributes.terminalProfiles)) {
    return { ok: false, error: 'contributes.terminalProfiles must be a list' }
  }
  for (const cap of contributes.capture ?? []) {
    const installProblem = captureInstallProblem(cap)
    if (installProblem) return { ok: false, error: `contributes.capture${cap.id ? ` "${cap.id}"` : ''}: ${installProblem}` }
    if (cap.platforms !== undefined && (!Array.isArray(cap.platforms) || cap.platforms.length === 0
      || cap.platforms.some(p => !['darwin', 'linux', 'win32'].includes(p)))) {
      return { ok: false, error: 'capture platforms must name darwin, linux or win32' }
    }
  }
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
    schemaVersion: typeof m.schemaVersion === 'number' ? m.schemaVersion : undefined,
    kind: isPluginKind(m.kind) ? m.kind : undefined,
    emits: Array.isArray(m.emits) ? m.emits.filter((e): e is string => typeof e === 'string') : undefined,
    health: typeof m.health === 'object' && m.health !== null ? (m.health as PluginManifest['health']) : undefined,
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
