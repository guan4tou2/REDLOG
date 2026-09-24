// Spec 036: what this machine needs before a capture adapter can record, and
// which shell profiles still source a hook file Spec 006 retired.
//
// The POSIX adapters build every event with python3 and send it with curl; a
// missing one used to leave the hook "installed" and silently recording
// nothing. An upgraded operator whose profile still sources a retired entry
// point went just as dark. Preflight answers both from the filesystem — PATH
// lookups via command-lookup, no processes spawned — so it is safe to call
// from the main thread on every onboarding render.

import { existsSync, readFileSync, writeFileSync, copyFileSync } from 'fs'
import { basename, join, resolve } from 'path'
import { homedir } from 'os'
import { isOnPath } from './command-lookup'
import { installHook, invalidateCommandCache, powershellProfilePaths } from './hooks-manager'

export type PreflightCommand = 'python3' | 'curl' | 'mitmdump' | 'zsh' | 'bash' | 'pwsh' | 'powershell'

export interface PreflightCheck {
  id: PreflightCommand
  found: boolean
  /** hook ids that cannot record without this command */
  neededFor: string[]
  /** copyable install command; present only when the command is missing */
  remediation?: string
}

export interface LegacyHookRef {
  file: string
  /** 1-based line number */
  line: number
  text: string
  /** the current adapter that replaces the retired file; null = nothing to install */
  hookId: string | null
}

export interface PreflightResult {
  platform: NodeJS.Platform
  shell: { name: string; hookId: string } | null
  checks: PreflightCheck[]
  legacyHooks: LegacyHookRef[]
}

export interface PreflightOptions {
  platform?: NodeJS.Platform
  env?: NodeJS.ProcessEnv
  home?: string
}

const SHELL_HOOKS: Record<string, string> = {
  zsh: 'shell-zsh',
  bash: 'shell-bash',
  pwsh: 'shell-powershell',
  powershell: 'shell-powershell'
}

// The project installs Python tools with uv, never pip. Linux targets are
// Debian/Kali, the distributions operators run RedLog on.
function remediationFor(cmd: PreflightCommand, platform: NodeJS.Platform): string | undefined {
  if (cmd === 'mitmdump') return 'uv tool install mitmproxy'
  if (cmd === 'pwsh' || cmd === 'powershell') return platform === 'win32' ? 'winget install --id Microsoft.PowerShell' : undefined
  const pkg = cmd === 'python3' && platform === 'darwin' ? 'python' : cmd
  if (platform === 'darwin') return `brew install ${pkg}`
  if (platform === 'linux') return `sudo apt install ${pkg}`
  return undefined
}

function detectShell(platform: NodeJS.Platform, env: NodeJS.ProcessEnv, found: (cmd: string) => boolean): PreflightResult['shell'] {
  if (platform === 'win32') {
    const name = found('pwsh') ? 'pwsh' : 'powershell'
    return { name, hookId: SHELL_HOOKS[name] }
  }
  const name = basename(env.SHELL ?? '')
  return SHELL_HOOKS[name] ? { name, hookId: SHELL_HOOKS[name] } : null
}

export function runPreflight(opts: PreflightOptions = {}): PreflightResult {
  const platform = opts.platform ?? process.platform
  const env = opts.env ?? process.env
  const found = (cmd: string): boolean => isOnPath(cmd, { platform, env })
  const wanted: Array<{ id: PreflightCommand; neededFor: string[] }> = platform === 'win32'
    ? [
        { id: 'powershell', neededFor: ['shell-powershell'] },
        { id: 'pwsh', neededFor: ['shell-powershell'] },
        { id: 'mitmdump', neededFor: ['mitmproxy'] }
      ]
    : [
        { id: 'python3', neededFor: ['shell-zsh', 'shell-bash'] },
        { id: 'curl', neededFor: ['shell-zsh', 'shell-bash'] },
        { id: 'zsh', neededFor: ['shell-zsh'] },
        { id: 'bash', neededFor: ['shell-bash'] },
        { id: 'mitmdump', neededFor: ['mitmproxy'] }
      ]
  const checks = wanted.map(({ id, neededFor }): PreflightCheck => {
    const ok = found(id)
    const remediation = ok ? undefined : remediationFor(id, platform)
    return remediation ? { id, found: ok, neededFor, remediation } : { id, found: ok, neededFor }
  })
  return {
    platform,
    shell: detectShell(platform, env, found),
    checks,
    legacyHooks: findLegacyHookReferences({ home: opts.home })
  }
}

// Entry points removed in Spec 006 (scripts/verify-packaged-resources.mjs keeps
// them out of the package). `shell-preexec-hook.sh` was the combined bash/zsh
// hook, so its replacement depends on which profile sources it.
// `claude-code-hook.sh` has no replacement: the agent tailer reads Claude
// Code's transcript directly, so migration only removes the line.
export const RETIRED_HOOK_FILES = ['shell-preexec-hook.sh', 'redlog-hook.zsh', 'claude-code-hook.sh']

function rcFiles(home: string): Array<{ file: string; shellHook: string }> {
  const ps = powershellProfilePaths(home)
  return [
    { file: join(home, '.zshrc'), shellHook: 'shell-zsh' },
    { file: join(home, '.bashrc'), shellHook: 'shell-bash' },
    { file: join(home, '.bash_profile'), shellHook: 'shell-bash' },
    { file: join(home, '.profile'), shellHook: 'shell-bash' },
    { file: ps.pwsh, shellHook: 'shell-powershell' },
    { file: ps.windowsPowerShell, shellHook: 'shell-powershell' }
  ]
}

// A `source` / `.` line naming a retired file as a path component. Comments
// are left alone: they load nothing.
function retiredFileIn(text: string): string | null {
  const t = text.trim()
  if (!/^(source|\.)\s/.test(t)) return null
  for (const name of RETIRED_HOOK_FILES) {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    if (new RegExp(`(^|[\\s/\\\\"'])${escaped}(["']|\\s|$)`).test(t)) return name
  }
  return null
}

function replacementFor(retired: string, shellHook: string): string | null {
  if (retired === 'claude-code-hook.sh') return null
  if (retired === 'redlog-hook.zsh') return 'shell-zsh'
  return shellHook
}

function scanFile(file: string, shellHook: string): LegacyHookRef[] {
  let content: string
  try {
    if (!existsSync(file)) return []
    content = readFileSync(file, 'utf-8')
  } catch { return [] }
  const refs: LegacyHookRef[] = []
  content.split(/\r?\n/).forEach((text, i) => {
    const retired = retiredFileIn(text)
    if (retired) refs.push({ file, line: i + 1, text, hookId: replacementFor(retired, shellHook) })
  })
  return refs
}

export function findLegacyHookReferences(opts: { home?: string } = {}): LegacyHookRef[] {
  const home = opts.home ?? homedir()
  return rcFiles(home).flatMap(({ file, shellHook }) => scanFile(file, shellHook))
}

export interface MigrationResult {
  success: boolean
  message: string
  backupPath?: string
  /** legacy lines removed from the file */
  removed: number
  hookId: string | null
}

// Back up the profile, drop every retired source line in it (plus the
// `# RedLog shell hook` comment the old installer wrote above each), then
// install the current adapter through the normal install path. The ref comes
// from the renderer, so it is only a pointer: the file must be one this module
// scans, and the lines removed are the ones a fresh scan finds, never the
// ref's own text. Never throws — the IPC layer gets a result either way.
export function migrateLegacyHook(ref: LegacyHookRef, opts: { home?: string } = {}): MigrationResult {
  const hookId = ref && typeof ref.hookId === 'string' ? ref.hookId : null
  try {
    if (!ref || typeof ref.file !== 'string') {
      return { success: false, message: 'Invalid legacy hook reference', removed: 0, hookId }
    }
    const home = opts.home ?? homedir()
    const target = rcFiles(home).find(({ file }) => resolve(file) === resolve(ref.file))
    if (!target) {
      return { success: false, message: `Not a shell profile RedLog manages: ${ref.file}`, removed: 0, hookId }
    }
    const refs = scanFile(target.file, target.shellHook)
    const installId = refs.find((r) => r.line === ref.line)?.hookId ?? refs[0]?.hookId ?? null
    if (refs.length === 0) {
      return { success: false, message: `No retired RedLog hook found in ${target.file}`, removed: 0, hookId }
    }
    const content = readFileSync(target.file, 'utf-8')
    const eol = content.includes('\r\n') ? '\r\n' : '\n'
    const lines = content.split(/\r?\n/)
    const drop = new Set(refs.map((r) => r.line - 1))
    for (const i of [...drop]) {
      if (i > 0 && lines[i - 1].trim() === '# RedLog shell hook') drop.add(i - 1)
    }
    const backupPath = `${target.file}.redlog-bak-${Date.now()}`
    copyFileSync(target.file, backupPath)
    writeFileSync(target.file, lines.filter((_, i) => !drop.has(i)).join(eol))

    if (!installId) {
      return { success: true, message: `Removed ${refs.length} retired hook line(s); nothing to install`, backupPath, removed: refs.length, hookId: null }
    }
    invalidateCommandCache()
    const installed = installHook(installId)
    return {
      success: installed.success,
      message: installed.success
        ? `Removed ${refs.length} retired hook line(s). ${installed.message}`
        : `Removed ${refs.length} retired hook line(s), but installing ${installId} failed: ${installed.message}`,
      backupPath,
      removed: refs.length,
      hookId: installId
    }
  } catch (e) {
    return { success: false, message: `Migration failed: ${e}`, removed: 0, hookId }
  }
}
