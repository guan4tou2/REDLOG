import { execSync } from 'child_process'
import { existsSync, readFileSync, writeFileSync, mkdirSync, copyFileSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'

export interface HookInfo {
  id: string
  name: string
  description: string
  installed: boolean
  available: boolean
  hookFile: string
}

const HOOKS_DIR = join(__dirname, '../../../hooks')
const SHELL_DIR = join(__dirname, '../../../shell')

function commandExists(cmd: string): boolean {
  try {
    execSync(`which ${cmd}`, { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

function isClaudeCodeHookInstalled(): boolean {
  const settingsPath = join(homedir(), '.claude', 'settings.json')
  if (!existsSync(settingsPath)) return false
  try {
    const settings = JSON.parse(readFileSync(settingsPath, 'utf-8'))
    const hooks = settings?.hooks?.PostToolUse
    if (!Array.isArray(hooks)) return false
    return hooks.some((h: { hooks?: Array<{ command?: string }> }) =>
      h.hooks?.some((hk) => hk.command?.includes('claude-code-hook'))
    )
  } catch {
    return false
  }
}

function isShellHookInstalled(): boolean {
  const hookDest = join(homedir(), '.redlog', 'shell-hook.zsh')
  if (!existsSync(hookDest)) return false
  const zshrc = join(homedir(), '.zshrc')
  if (existsSync(zshrc)) {
    const content = readFileSync(zshrc, 'utf-8')
    if (content.includes('shell-hook.zsh')) return true
  }
  const bashrc = join(homedir(), '.bashrc')
  if (existsSync(bashrc)) {
    const content = readFileSync(bashrc, 'utf-8')
    if (content.includes('shell-hook') || content.includes('shell-preexec-hook')) return true
  }
  return false
}

export function detectHooks(): HookInfo[] {
  const hooksDir = existsSync(HOOKS_DIR) ? HOOKS_DIR : join(__dirname, '../../hooks')
  const shellDir = existsSync(SHELL_DIR) ? SHELL_DIR : join(__dirname, '../../shell')

  return [
    {
      id: 'claude-code',
      name: 'Claude Code',
      description: 'Captures Bash tool calls from Claude Code sessions',
      installed: isClaudeCodeHookInstalled(),
      available: commandExists('claude'),
      hookFile: join(hooksDir, 'claude-code-hook.sh')
    },
    {
      id: 'shell-zsh',
      name: 'Zsh Shell',
      description: 'Captures commands and exit codes from zsh',
      installed: isShellHookInstalled(),
      available: process.env.SHELL?.includes('zsh') || existsSync('/bin/zsh'),
      hookFile: join(shellDir, 'redlog-hook.zsh')
    },
    {
      id: 'shell-bash',
      name: 'Bash Shell',
      description: 'Captures commands via preexec/precmd hooks',
      installed: (() => {
        const bashrc = join(homedir(), '.bashrc')
        if (!existsSync(bashrc)) return false
        return readFileSync(bashrc, 'utf-8').includes('shell-preexec-hook')
      })(),
      available: existsSync('/bin/bash'),
      hookFile: join(hooksDir, 'shell-preexec-hook.sh')
    },
    {
      id: 'codex',
      name: 'Codex',
      description: 'Wraps Codex shell to capture agent commands',
      installed: false,
      available: commandExists('codex'),
      hookFile: join(hooksDir, 'codex-wrapper.sh')
    },
    {
      id: 'mitmproxy',
      name: 'mitmproxy',
      description: 'Captures HTTP traffic via mitmproxy addon',
      installed: false,
      available: commandExists('mitmproxy') || commandExists('mitmdump'),
      hookFile: join(hooksDir, 'mitmproxy-addon.py')
    }
  ]
}

export function installHook(hookId: string): { success: boolean; message: string } {
  const hookFile = join(HOOKS_DIR, 'claude-code-hook.sh')

  switch (hookId) {
    case 'claude-code': {
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
        const exists = postTool.some((h) =>
          (h.hooks as Array<{ command?: string }>)?.some((hk) => hk.command?.includes('claude-code-hook'))
        )
        if (!exists) {
          postTool.push({
            matcher: 'Bash',
            hooks: [{ command: existsSync(hookFile) ? hookFile : 'redlog-hooks/claude-code-hook.sh' }]
          })
        }
        writeFileSync(settingsPath, JSON.stringify(settings, null, 2))
        return { success: true, message: 'Claude Code hook added to ~/.claude/settings.json' }
      } catch (e) {
        return { success: false, message: `Failed: ${e}` }
      }
    }
    case 'shell-zsh': {
      try {
        const dest = join(homedir(), '.redlog', 'shell-hook.zsh')
        const src = join(SHELL_DIR, 'redlog-hook.zsh')
        mkdirSync(join(homedir(), '.redlog'), { recursive: true })
        if (existsSync(src)) copyFileSync(src, dest)
        const zshrc = join(homedir(), '.zshrc')
        let content = existsSync(zshrc) ? readFileSync(zshrc, 'utf-8') : ''
        if (!content.includes('shell-hook.zsh')) {
          content += '\n# RedLog shell hook\nsource ~/.redlog/shell-hook.zsh\n'
          writeFileSync(zshrc, content)
        }
        return { success: true, message: 'Zsh hook installed. Run: source ~/.zshrc' }
      } catch (e) {
        return { success: false, message: `Failed: ${e}` }
      }
    }
    case 'shell-bash': {
      try {
        const dest = join(homedir(), '.redlog', 'shell-preexec-hook.sh')
        const src = join(HOOKS_DIR, 'shell-preexec-hook.sh')
        mkdirSync(join(homedir(), '.redlog'), { recursive: true })
        if (existsSync(src)) copyFileSync(src, dest)
        const bashrc = join(homedir(), '.bashrc')
        let content = existsSync(bashrc) ? readFileSync(bashrc, 'utf-8') : ''
        if (!content.includes('shell-preexec-hook')) {
          content += '\n# RedLog shell hook\nsource ~/.redlog/shell-preexec-hook.sh\n'
          writeFileSync(bashrc, content)
        }
        return { success: true, message: 'Bash hook installed. Run: source ~/.bashrc' }
      } catch (e) {
        return { success: false, message: `Failed: ${e}` }
      }
    }
    default:
      return { success: false, message: `Manual setup required for ${hookId}` }
  }
}

export function uninstallHook(hookId: string): { success: boolean; message: string } {
  switch (hookId) {
    case 'claude-code': {
      const settingsPath = join(homedir(), '.claude', 'settings.json')
      try {
        if (!existsSync(settingsPath)) return { success: true, message: 'Already removed' }
        const settings = JSON.parse(readFileSync(settingsPath, 'utf-8'))
        const postTool = settings?.hooks?.PostToolUse as Array<Record<string, unknown>> | undefined
        if (postTool) {
          settings.hooks.PostToolUse = postTool.filter((h) =>
            !(h.hooks as Array<{ command?: string }>)?.some((hk) => hk.command?.includes('claude-code-hook'))
          )
        }
        writeFileSync(settingsPath, JSON.stringify(settings, null, 2))
        return { success: true, message: 'Claude Code hook removed' }
      } catch (e) {
        return { success: false, message: `Failed: ${e}` }
      }
    }
    case 'shell-zsh': {
      try {
        const zshrc = join(homedir(), '.zshrc')
        if (existsSync(zshrc)) {
          let content = readFileSync(zshrc, 'utf-8')
          content = content.replace(/\n?# RedLog shell hook\nsource ~\/.redlog\/shell-hook\.zsh\n?/g, '\n')
          writeFileSync(zshrc, content)
        }
        return { success: true, message: 'Zsh hook removed. Run: source ~/.zshrc' }
      } catch (e) {
        return { success: false, message: `Failed: ${e}` }
      }
    }
    case 'shell-bash': {
      try {
        const bashrc = join(homedir(), '.bashrc')
        if (existsSync(bashrc)) {
          let content = readFileSync(bashrc, 'utf-8')
          content = content.replace(/\n?# RedLog shell hook\nsource ~\/.redlog\/shell-preexec-hook\.sh\n?/g, '\n')
          writeFileSync(bashrc, content)
        }
        return { success: true, message: 'Bash hook removed. Run: source ~/.bashrc' }
      } catch (e) {
        return { success: false, message: `Failed: ${e}` }
      }
    }
    default:
      return { success: false, message: `Manual removal required for ${hookId}` }
  }
}
