import { execSync } from 'child_process'
import { existsSync, readFileSync, writeFileSync, mkdirSync, copyFileSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'

export interface PluginManifest {
  id: string
  name: string
  description: string
  agentType: string
  requires: string[]
  hookFile: string
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
  installed: boolean
  available: boolean
  installMethod: 'claude-settings' | 'shell-source' | 'manual'
  hookFile: string
  /** for installMethod 'manual': ordered, copy-paste setup steps */
  manualSteps?: ManualStep[]
}

const HOOKS_DIR = join(__dirname, '../../../hooks')
const SHELL_DIR = join(__dirname, '../../../shell')

function resolveDir(primary: string, fallback: string): string {
  return existsSync(primary) ? primary : fallback
}

const PLUGIN_REGISTRY: PluginManifest[] = [
  {
    id: 'claude-code',
    name: 'Claude Code',
    description: 'Captures Bash tool calls from Claude Code sessions',
    agentType: 'shell',
    requires: ['claude'],
    hookFile: 'hooks/claude-code-hook.sh',
    installMethod: 'claude-settings',
    claudeSettingsMatcher: 'claude-code-hook'
  },
  {
    id: 'shell-zsh',
    name: 'Zsh Shell',
    description: 'Captures commands and exit codes from zsh',
    agentType: 'shell',
    requires: [],
    hookFile: 'shell/redlog-hook.zsh',
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
    hookFile: 'hooks/shell-preexec-hook.sh',
    installMethod: 'shell-source',
    installTarget: join(homedir(), '.redlog', 'shell-preexec-hook.sh'),
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
  }
]

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
  return [...PLUGIN_REGISTRY, ...externalCaptures]
}

// Absolute path to a manifest's hook script source. Plugin captures resolve
// inside the plugin dir; built-ins resolve against the shipped hooks/ or shell/.
function srcPathFor(plugin: PluginManifest): string {
  if (plugin._dir) return join(plugin._dir, plugin.hookFile)
  const hooksDir = resolveDir(HOOKS_DIR, join(__dirname, '../../hooks'))
  const shellDir = resolveDir(SHELL_DIR, join(__dirname, '../../shell'))
  return plugin.hookFile.startsWith('shell/')
    ? join(shellDir, plugin.hookFile.replace('shell/', ''))
    : join(hooksDir, plugin.hookFile.replace('hooks/', ''))
}

// For shell-source plugin captures without an explicit target, drop the hook in
// ~/.redlog under its own basename.
function installTargetFor(plugin: PluginManifest): string {
  if (plugin.installTarget) return plugin.installTarget
  const base = plugin.hookFile.split(/[\\/]/).pop() ?? `${plugin.id}.sh`
  return join(homedir(), '.redlog', base)
}

// Which shell rc a shell-source hook appends to. Explicit wins; otherwise pick
// by the operator's login shell.
function shellRcFor(plugin: PluginManifest): string {
  if (plugin.shellRcFile) return plugin.shellRcFile
  return process.env.SHELL?.includes('zsh') ? '.zshrc' : '.bashrc'
}

function commandExists(cmd: string): boolean {
  try {
    // Windows has no `which` — it's `where`. Without this, every requires-based
    // hook (claude-code, codex, mitmproxy) throws here and reports unavailable
    // on Windows, greying out the whole panel.
    const probe = process.platform === 'win32' ? `where ${cmd}` : `which ${cmd}`
    execSync(probe, { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
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
  const hookName = hookPath.split('/').pop() ?? ''
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
    if (plugin.id === 'shell-zsh') return process.env.SHELL?.includes('zsh') || existsSync('/bin/zsh')
    if (plugin.id === 'shell-bash') {
      return existsSync('/bin/bash') || (process.platform === 'win32' && commandExists('bash'))
    }
    return true
  }
  return plugin.requires.some((cmd) => commandExists(cmd))
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
          label: 'Wrap a whole shell the agent will use — every command it runs is captured',
          command: `"${hookFile}"`
        },
        {
          label: 'Or point Codex CLI at the wrapper as its shell',
          command: `SHELL="${hookFile}" codex run "scan the target"`
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
    default:
      return undefined
  }
}

export function detectHooks(): PluginInfo[] {
  return allManifests().map((plugin) => {
    const hookFile = srcPathFor(plugin)
    // Plugin captures carry their own manualSteps; built-ins compute theirs.
    const manualSteps = plugin.installMethod === 'manual'
      ? (plugin.manualSteps ?? buildManualSteps(plugin.id, hookFile))
      : undefined

    return {
      id: plugin.id,
      name: plugin.name,
      description: plugin.description,
      agentType: plugin.agentType,
      installed: checkInstalled(plugin),
      available: checkAvailable(plugin),
      installMethod: plugin.installMethod,
      hookFile,
      manualSteps
    }
  })
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
      try {
        const dest = installTargetFor(plugin)
        const src = srcPathFor(plugin)
        mkdirSync(join(homedir(), '.redlog'), { recursive: true })
        if (existsSync(src)) copyFileSync(src, dest)
        const rcFile = shellRcFor(plugin)
        const rcPath = join(homedir(), rcFile)
        let content = existsSync(rcPath) ? readFileSync(rcPath, 'utf-8') : ''
        const hookName = dest.split('/').pop()
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
