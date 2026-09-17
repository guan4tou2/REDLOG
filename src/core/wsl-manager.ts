import { spawn } from 'child_process'
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
 * One `wsl.exe` invocation, off the main thread.
 *
 * Every probe below used to be `spawnSync`, and `listWslDistros()` makes five
 * of them for a single running distro: `-l -v`, then two shell probes and two
 * rc greps. Measured on Windows 11 that is **2.1–2.4 s, every call, with no
 * cache** — and it was paid on the Electron main thread, which also serves the
 * capture API. Opening Settings (the WSL panel mounts with the hooks page)
 * therefore stalled a `POST /api/events` for 2059 ms against a shell hook
 * whose foreground deadline is 2 s, so a command run in that window timed out
 * and spooled instead of landing live.
 *
 * `spawn` keeps the same argv-only shape as `spawnSync` — no shell, so a
 * distro name still cannot be injected — and the same timeout. Only the
 * waiting moves off the main thread.
 */
function runWsl(args: string[]): Promise<{ status: number; stdout: Buffer; stderr: string }> {
  return new Promise((resolve) => {
    const empty = { status: -1, stdout: Buffer.alloc(0), stderr: '' }
    let child: ReturnType<typeof spawn>
    try {
      child = spawn('wsl.exe', args, { windowsHide: true })
    } catch {
      resolve(empty)
      return
    }
    const out: Buffer[] = []
    const err: Buffer[] = []
    let settled = false
    const finish = (status: number): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ status, stdout: Buffer.concat(out), stderr: Buffer.concat(err).toString().trim() })
    }
    // A distro that hangs must not hold the panel open forever — same ceiling
    // spawnSync's `timeout` gave us, enforced by hand because spawn has none.
    const timer = setTimeout(() => { child.kill(); finish(-1) }, WSL_TIMEOUT)
    child.stdout?.on('data', (b: Buffer) => out.push(b))
    child.stderr?.on('data', (b: Buffer) => err.push(b))
    child.on('error', () => finish(-1))
    child.on('close', (code) => finish(code ?? -1))
  })
}

// Enumerating distros costs seconds of `wsl.exe` round-trips and the answer
// changes only when the operator starts, stops or installs one. Cache it for
// long enough to cover reopening Settings or moving between its pages, but not
// so long that a distro the operator just started stays invisible.
// `invalidateWslCache()` clears it after an install/uninstall, which are the
// changes RedLog itself makes.
let distroCache: { at: number; value: WslDistro[] } | null = null
const DISTRO_TTL_MS = 30_000

export function invalidateWslCache(): void { distroCache = null }

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
export async function listWslDistros(now = Date.now()): Promise<WslDistro[]> {
  if (process.platform !== 'win32') return []
  if (distroCache && now - distroCache.at < DISTRO_TTL_MS) return distroCache.value

  // "WSL is not installed here" is an answer worth caching too — otherwise a
  // machine without WSL re-pays a failed `wsl.exe` launch on every call.
  const miss = (): WslDistro[] => {
    distroCache = { at: now, value: [] }
    return distroCache.value
  }

  try {
    // wsl.exe -l -v outputs UTF-16LE encoded text
    const result = await runWsl(['-l', '-v'])
    if (result.status !== 0 || !result.stdout.length) return miss()

    // CRITICAL: output is UTF-16LE. Read as Buffer, decode, strip null bytes.
    const raw = result.stdout.toString('utf16le')
    const text = raw.replace(/\x00/g, '').trim()

    const lines = text.split(/\r?\n/).filter((l) => l.trim())
    if (lines.length < 2) return miss()

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
        shells = await detectShells(name)
        hookStatus = await checkHookStatus(name, shells)
      }

      distros.push({ name, state, version, isDefault, shells, hookStatus })
    }

    distroCache = { at: now, value: distros }
    return distros
  } catch {
    return []
  }
}

/**
 * Detect which shells are available in a running WSL distro.
 */
async function detectShells(distro: string): Promise<string[]> {
  const shells: string[] = []

  // Sequential, not Promise.all: two `wsl.exe` calls into the same distro at
  // once is not obviously safe on a cold VM, and the main thread is free
  // either way now — the cost that mattered was blocking, not wall clock.
  const bashResult = await runWsl(['-d', distro, '--', '/bin/bash', '-c', 'echo ok'])
  if (bashResult.status === 0) shells.push('bash')

  const zshResult = await runWsl(['-d', distro, '--', '/bin/bash', '-c', 'which zsh 2>/dev/null && echo ok'])
  if (zshResult.stdout.toString().trim().includes('ok')) shells.push('zsh')

  return shells
}

/**
 * Check hook status for a specific distro.
 * Returns install status per shell.
 */
export async function checkHookStatus(
  distro: string,
  shells?: string[]
): Promise<{ bash: 'installed' | 'not-installed' | 'no-shell'; zsh: 'installed' | 'not-installed' | 'no-shell' }> {
  if (process.platform !== 'win32') return { bash: 'no-shell', zsh: 'no-shell' }

  const available = shells ?? await detectShells(distro)

  const checkRc = async (shell: 'bash' | 'zsh'): Promise<'installed' | 'not-installed' | 'no-shell'> => {
    if (!available.includes(shell)) return 'no-shell'
    const rcFile = shell === 'bash' ? '.bashrc' : '.zshrc'
    const result = await runWsl([
      '-d', distro, '--', '/bin/bash', '-c',
      `grep -c "shell-preexec-hook" ~/${rcFile} 2>/dev/null || echo 0`
    ])
    const count = parseInt(result.stdout.toString().trim() || '0', 10)
    return count > 0 ? 'installed' : 'not-installed'
  }

  return {
    bash: await checkRc('bash'),
    zsh: await checkRc('zsh')
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
export async function installHook(
  distro: string,
  shell: 'bash' | 'zsh'
): Promise<{ success: boolean; message: string }> {
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
  const checkResult = await runWsl([
    '-d', distro, '--', '/bin/bash', '-c',
    `grep -c "shell-preexec-hook" ~/${rcFile} 2>/dev/null || echo 0`
  ])
  const count = parseInt(checkResult.stdout.toString().trim() || '0', 10)
  if (count > 0) {
    return { success: true, message: `Hook already installed in ~/${rcFile}` }
  }

  // Append hook source line
  const appendResult = await runWsl([
    '-d', distro, '--', '/bin/bash', '-c',
    `printf '\\n# RedLog WSL hook\\nsource "${wslHookPath}"\\n' >> ~/${rcFile}`
  ])

  // The rc file just changed, so the cached hookStatus is wrong.
  invalidateWslCache()

  if (appendResult.status === 0) {
    return { success: true, message: `Hook installed in ~/${rcFile}` }
  }
  return { success: false, message: `Failed to write to ~/${rcFile}: ${appendResult.stderr}` }
}

/**
 * Remove the RedLog shell hook from a WSL distro's shell rc file.
 */
export async function uninstallHook(
  distro: string,
  shell: 'bash' | 'zsh'
): Promise<{ success: boolean; message: string }> {
  if (process.platform !== 'win32') {
    return { success: false, message: 'WSL is only available on Windows' }
  }

  const rcFile = shell === 'bash' ? '.bashrc' : '.zshrc'

  const result = await runWsl([
    '-d', distro, '--', '/bin/bash', '-c',
    `sed -i '/RedLog WSL hook/d; /shell-preexec-hook/d' ~/${rcFile}`
  ])

  invalidateWslCache()

  if (result.status === 0) {
    return { success: true, message: `Hook removed from ~/${rcFile}` }
  }
  return { success: false, message: `Failed to remove hook: ${result.stderr}` }
}

/**
 * Run diagnostics on a WSL distro using the wsl-redlog-test.sh script.
 * Parses the output into structured checks.
 */
export async function runDiagnostics(distro: string): Promise<WslDiagnosticResult> {
  if (process.platform !== 'win32') {
    return { distro, checks: [{ name: 'platform', status: 'fail', message: 'WSL is only available on Windows' }] }
  }

  const scriptPath = resolveDiagnosticsScript()
  if (!existsSync(scriptPath)) {
    return { distro, checks: [{ name: 'script', status: 'fail', message: 'Diagnostics script not found' }] }
  }

  const wslScriptPath = windowsPathToWsl(scriptPath)

  try {
    const result = await runWsl(['-d', distro, '--', '/bin/bash', wslScriptPath])

    const stdout = result.stdout.toString().trim()
    const stderr = result.stderr

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
