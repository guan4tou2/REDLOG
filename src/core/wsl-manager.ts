import { spawnSync } from 'child_process'
import { existsSync, readFileSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'

export interface WslDistro {
  name: string
  state: 'Running' | 'Stopped' | 'Installing' | 'Converting'
  version: number
  isDefault: boolean
  shells: string[]
  hookStatus: {
    bash: 'installed' | 'not-installed' | 'no-shell'
    zsh: 'installed' | 'not-installed' | 'no-shell'
  }
}

export interface WslDiagnosticResult {
  distro: string
  checks: Array<{ name: string; status: 'pass' | 'fail' | 'warn'; message: string }>
}

const WSL_TIMEOUT = 10_000

/**
 * Convert a Windows path to its WSL /mnt/ equivalent.
 * e.g. C:\Users\foo\hooks\shell-preexec-hook.sh -> /mnt/c/Users/foo/hooks/shell-preexec-hook.sh
 *
 * Reuses the same logic from hooks-manager.ts buildManualSteps('shell-wsl').
 */
function windowsPathToWsl(winPath: string): string {
  return winPath
    .replace(/\\/g, '/')
    .replace(/^([A-Z]):/, (_m, d: string) => `/mnt/${d.toLowerCase()}`)
}

/**
 * Resolve the absolute Windows path to the shell-preexec-hook.sh file.
 * Mirrors how hooks-manager.ts resolves hook files.
 */
function resolveHookPath(): string {
  const hooksDir = join(__dirname, '../../../hooks')
  const fallback = join(__dirname, '../../hooks')
  const dir = existsSync(hooksDir) ? hooksDir : fallback
  return join(dir, 'shell-preexec-hook.sh')
}

/**
 * Resolve the absolute Windows path to the wsl-redlog-test.sh file.
 */
function resolveDiagnosticsScript(): string {
  const hooksDir = join(__dirname, '../../../hooks')
  const fallback = join(__dirname, '../../hooks')
  const dir = existsSync(hooksDir) ? hooksDir : fallback
  return join(dir, 'wsl-redlog-test.sh')
}

/**
 * List WSL distributions with their state, shells, and hook status.
 * Returns an empty array on non-Windows or if WSL is not available.
 */
export function listWslDistros(): WslDistro[] {
  if (process.platform !== 'win32') return []

  try {
    // wsl.exe -l -v outputs UTF-16LE encoded text
    const result = spawnSync('wsl.exe', ['-l', '-v'], {
      timeout: WSL_TIMEOUT,
      windowsHide: true
    })
    if (result.status !== 0 || !result.stdout) return []

    // CRITICAL: output is UTF-16LE. Read as Buffer, decode, strip null bytes.
    const raw = result.stdout instanceof Buffer
      ? result.stdout.toString('utf16le')
      : String(result.stdout)
    const text = raw.replace(/\x00/g, '').trim()

    const lines = text.split(/\r?\n/).filter((l) => l.trim())
    if (lines.length < 2) return []

    // Skip the header line (NAME STATE VERSION)
    const distros: WslDistro[] = []
    for (let i = 1; i < lines.length; i++) {
      const line = lines[i].trim()
      // Match: optional * (default), name, state, version
      // e.g. "* Ubuntu    Running    2" or "  kali-linux    Stopped    2"
      const match = line.match(/^(\*?)\s*(\S+)\s+(Running|Stopped|Installing|Converting)\s+(\d+)/)
      if (!match) continue

      const isDefault = match[1] === '*'
      const name = match[2]
      const state = match[3] as WslDistro['state']
      const version = parseInt(match[4], 10)

      let shells: string[] = []
      let hookStatus: WslDistro['hookStatus'] = {
        bash: 'no-shell',
        zsh: 'no-shell'
      }

      // Only probe running distros to avoid waking stopped ones
      if (state === 'Running') {
        shells = detectShells(name)
        hookStatus = checkHookStatus(name, shells)
      }

      distros.push({ name, state, version, isDefault, shells, hookStatus })
    }

    return distros
  } catch {
    return []
  }
}

/**
 * Detect which shells are available in a running WSL distro.
 */
function detectShells(distro: string): string[] {
  const shells: string[] = []

  try {
    const bashResult = spawnSync('wsl.exe', [
      '-d', distro, '--', '/bin/bash', '-c', 'echo ok'
    ], { timeout: WSL_TIMEOUT, windowsHide: true })
    if (bashResult.status === 0) shells.push('bash')
  } catch { /* shell not available */ }

  try {
    const zshResult = spawnSync('wsl.exe', [
      '-d', distro, '--', '/bin/bash', '-c', 'which zsh 2>/dev/null && echo ok'
    ], { timeout: WSL_TIMEOUT, windowsHide: true })
    const out = zshResult.stdout?.toString().trim() ?? ''
    if (out.includes('ok')) shells.push('zsh')
  } catch { /* shell not available */ }

  return shells
}

/**
 * Check hook status for a specific distro.
 * Returns install status per shell.
 */
export function checkHookStatus(
  distro: string,
  shells?: string[]
): { bash: 'installed' | 'not-installed' | 'no-shell'; zsh: 'installed' | 'not-installed' | 'no-shell' } {
  if (process.platform !== 'win32') return { bash: 'no-shell', zsh: 'no-shell' }

  const available = shells ?? detectShells(distro)

  const checkRc = (shell: 'bash' | 'zsh'): 'installed' | 'not-installed' | 'no-shell' => {
    if (!available.includes(shell)) return 'no-shell'
    const rcFile = shell === 'bash' ? '.bashrc' : '.zshrc'
    try {
      const result = spawnSync('wsl.exe', [
        '-d', distro, '--', '/bin/bash', '-c',
        `grep -c "shell-preexec-hook" ~/${rcFile} 2>/dev/null || echo 0`
      ], { timeout: WSL_TIMEOUT, windowsHide: true })
      const count = parseInt(result.stdout?.toString().trim() ?? '0', 10)
      return count > 0 ? 'installed' : 'not-installed'
    } catch {
      return 'not-installed'
    }
  }

  return {
    bash: checkRc('bash'),
    zsh: checkRc('zsh')
  }
}

/**
 * Read the WSL2 networking mode from %USERPROFILE%\.wslconfig.
 */
export function getNetworkMode(): 'mirrored' | 'nat' | 'not-configured' {
  if (process.platform !== 'win32') return 'not-configured'

  const wslConfigPath = join(homedir(), '.wslconfig')
  if (!existsSync(wslConfigPath)) return 'not-configured'

  try {
    const content = readFileSync(wslConfigPath, 'utf-8')
    // Simple INI parsing: look for [wsl2] section and networkingMode key
    let inWsl2Section = false
    for (const line of content.split(/\r?\n/)) {
      const trimmed = line.trim()
      if (/^\[wsl2\]$/i.test(trimmed)) {
        inWsl2Section = true
        continue
      }
      if (trimmed.startsWith('[') && inWsl2Section) {
        // Entered a different section
        break
      }
      if (inWsl2Section) {
        const match = trimmed.match(/^networkingMode\s*=\s*(.+)/i)
        if (match) {
          const mode = match[1].trim().toLowerCase()
          if (mode === 'mirrored') return 'mirrored'
          return 'nat'
        }
      }
    }
    return 'not-configured'
  } catch {
    return 'not-configured'
  }
}

/**
 * Install the RedLog shell hook into a WSL distro's shell rc file.
 * Idempotent: skips if already installed.
 */
export function installHook(
  distro: string,
  shell: 'bash' | 'zsh'
): { success: boolean; message: string } {
  if (process.platform !== 'win32') {
    return { success: false, message: 'WSL is only available on Windows' }
  }

  const hookPath = resolveHookPath()
  if (!existsSync(hookPath)) {
    return { success: false, message: `Hook file not found: ${hookPath}` }
  }

  const wslHookPath = windowsPathToWsl(hookPath)
  const rcFile = shell === 'bash' ? '.bashrc' : '.zshrc'

  // Check if already installed
  try {
    const checkResult = spawnSync('wsl.exe', [
      '-d', distro, '--', '/bin/bash', '-c',
      `grep -c "shell-preexec-hook" ~/${rcFile} 2>/dev/null || echo 0`
    ], { timeout: WSL_TIMEOUT, windowsHide: true })
    const count = parseInt(checkResult.stdout?.toString().trim() ?? '0', 10)
    if (count > 0) {
      return { success: true, message: `Hook already installed in ~/${rcFile}` }
    }
  } catch { /* proceed with install */ }

  // Append hook source line
  try {
    const appendResult = spawnSync('wsl.exe', [
      '-d', distro, '--', '/bin/bash', '-c',
      `printf '\\n# RedLog WSL hook\\nsource "${wslHookPath}"\\n' >> ~/${rcFile}`
    ], { timeout: WSL_TIMEOUT, windowsHide: true })

    if (appendResult.status === 0) {
      return { success: true, message: `Hook installed in ~/${rcFile}` }
    }
    const stderr = appendResult.stderr?.toString().trim() ?? ''
    return { success: false, message: `Failed to write to ~/${rcFile}: ${stderr}` }
  } catch (e) {
    return { success: false, message: `Install failed: ${(e as Error).message}` }
  }
}

/**
 * Remove the RedLog shell hook from a WSL distro's shell rc file.
 */
export function uninstallHook(
  distro: string,
  shell: 'bash' | 'zsh'
): { success: boolean; message: string } {
  if (process.platform !== 'win32') {
    return { success: false, message: 'WSL is only available on Windows' }
  }

  const rcFile = shell === 'bash' ? '.bashrc' : '.zshrc'

  try {
    const result = spawnSync('wsl.exe', [
      '-d', distro, '--', '/bin/bash', '-c',
      `sed -i '/RedLog WSL hook/d; /shell-preexec-hook/d' ~/${rcFile}`
    ], { timeout: WSL_TIMEOUT, windowsHide: true })

    if (result.status === 0) {
      return { success: true, message: `Hook removed from ~/${rcFile}` }
    }
    const stderr = result.stderr?.toString().trim() ?? ''
    return { success: false, message: `Failed to remove hook: ${stderr}` }
  } catch (e) {
    return { success: false, message: `Uninstall failed: ${(e as Error).message}` }
  }
}

/**
 * Run diagnostics on a WSL distro using the wsl-redlog-test.sh script.
 * Parses the output into structured checks.
 */
export function runDiagnostics(distro: string): WslDiagnosticResult {
  if (process.platform !== 'win32') {
    return { distro, checks: [{ name: 'platform', status: 'fail', message: 'WSL is only available on Windows' }] }
  }

  const scriptPath = resolveDiagnosticsScript()
  if (!existsSync(scriptPath)) {
    return { distro, checks: [{ name: 'script', status: 'fail', message: 'Diagnostics script not found' }] }
  }

  const wslScriptPath = windowsPathToWsl(scriptPath)

  try {
    const result = spawnSync('wsl.exe', [
      '-d', distro, '--', '/bin/bash', wslScriptPath
    ], { timeout: WSL_TIMEOUT, windowsHide: true })

    const stdout = result.stdout?.toString().trim() ?? ''
    const stderr = result.stderr?.toString().trim() ?? ''

    if (result.status !== 0 && !stdout) {
      return {
        distro,
        checks: [{ name: 'run', status: 'fail', message: stderr || 'Diagnostics script failed' }]
      }
    }

    // Parse output lines — expected format: [PASS|FAIL|WARN] check_name: message
    const checks: WslDiagnosticResult['checks'] = []
    for (const line of stdout.split(/\r?\n/)) {
      const m = line.match(/^\[(PASS|FAIL|WARN)\]\s*(.+?):\s*(.*)/)
      if (m) {
        checks.push({
          name: m[2].trim(),
          status: m[1].toLowerCase() as 'pass' | 'fail' | 'warn',
          message: m[3].trim()
        })
      } else if (line.trim()) {
        // Non-structured output — include as info
        checks.push({ name: 'info', status: 'pass', message: line.trim() })
      }
    }

    if (checks.length === 0) {
      checks.push({ name: 'output', status: 'warn', message: 'No structured output from diagnostics script' })
    }

    return { distro, checks }
  } catch (e) {
    return {
      distro,
      checks: [{ name: 'error', status: 'fail', message: (e as Error).message }]
    }
  }
}
