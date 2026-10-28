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
function runWsl(args: string[]): Promise<{ status: number; stdout: Buffer; stderr: string; timedOut: boolean }> {
  return new Promise((resolve) => {
    const empty = { status: -1, stdout: Buffer.alloc(0), stderr: '', timedOut: false }
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
    let timedOut = false
    const finish = (status: number): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ status, stdout: Buffer.concat(out), stderr: Buffer.concat(err).toString().trim(), timedOut })
    }
    // A distro that hangs must not hold the panel open forever — same ceiling
    // spawnSync's `timeout` gave us, enforced by hand because spawn has none.
    const timer = setTimeout(() => {
      // Mark the cause before kill: it can immediately deliver a close event.
      timedOut = true
      child.kill()
      finish(-1)
    }, WSL_TIMEOUT)
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
 * e.g. C:\Users\foo\hooks\shell-bash-hook.sh -> /mnt/c/Users/foo/hooks/shell-bash-hook.sh
 *
 * Reuses the same logic from hooks-manager.ts buildManualSteps('shell-wsl').
 */
export function windowsPathToWsl(winPath: string): string {
  return winPath
    .replace(/\\/g, '/')
    .replace(/^([A-Z]):/, (_m, d: string) => `/mnt/${d.toLowerCase()}`)
}

/**
 * Resolve the absolute Windows path to a shell-specific adapter.
 * Mirrors how hooks-manager.ts resolves hook files.
 */
function resolveHookPath(shell: 'bash' | 'zsh'): string {
  const hooksDir = join(__dirname, '../../../hooks')
  const fallback = join(__dirname, '../../hooks')
  const dir = existsSync(hooksDir) ? hooksDir : fallback
  return join(dir, shell === 'zsh' ? 'shell-zsh-hook.zsh' : 'shell-bash-hook.sh')
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

// The rc line sources the bundled hook in place, so an upgrade into the same
// install directory updates what it runs. What can go stale is the path: a line
// left by a build that lived somewhere else (another install location, a dev
// checkout) still mentions `shell-<shell>-hook`, and matching on that name alone
// reported it installed and made install a no-op. Both scripts compare the
// whole line instead. Arguments arrive as $1 rc file, $2 hook path, $3 shell —
// positional, never spliced into the script, so a path cannot inject.
//
// Both run with `wsl.exe -e`, not `--`. After `--` the rest of the command line
// is read again by the distro's default shell, which expands `$1` and `$HOME`
// before this bash sees them: measured on Ubuntu 26.04, `$1` arrived empty.
// `-e` execs bash directly and hands over argv untouched.
const RC_STATUS_SCRIPT = [
  'rc="$HOME/$1"; line="source \\"$2\\""',
  'if grep -qxF "$line" "$rc" 2>/dev/null; then echo installed; else echo not-installed; fi'
].join('\n')

const RC_INSTALL_SCRIPT = [
  'rc="$HOME/$1"; line="source \\"$2\\""',
  'if grep -qxF "$line" "$rc" 2>/dev/null; then echo present; exit 0; fi',
  // Drop any earlier RedLog line for this shell. `cat >` rather than a rename
  // keeps the rc's own inode, so a symlinked dotfile stays a symlink.
  'if [ -f "$rc" ]; then',
  '  grep -vE "RedLog WSL hook|shell-$3-hook" "$rc" > "$rc.redlog-tmp"',
  '  cat "$rc.redlog-tmp" > "$rc" && rm -f "$rc.redlog-tmp" || exit 1',
  'fi',
  'printf \'\\n# RedLog WSL hook\\n%s\\n\' "$line" >> "$rc" && echo installed'
].join('\n')

// Uninstall: take this build's line out of ~/.bashrc and ~/.zshrc. $1 and $2
// are the bash and zsh hook paths; a line for another build stays, being some
// other install's to remove. The marker goes with the last hook line, and an
// rc left with nothing but whitespace was created by install and is deleted.
// POSIX sh, because a distro need not have bash. Prints each rc it changed.
const RC_REMOVE_SCRIPT = [
  'for name in .bashrc .zshrc; do',
  '  rc="$HOME/$name"; tmp="$rc.redlog-tmp"',
  '  [ -f "$rc" ] || continue',
  '  grep -qxF -e "source \\"$1\\"" -e "source \\"$2\\"" "$rc" || continue',
  '  grep -vxF -e "source \\"$1\\"" -e "source \\"$2\\"" "$rc" > "$tmp"',
  '  [ $? -le 1 ] || { rm -f "$tmp"; continue; }',
  '  if ! grep -qE "shell-(bash|zsh)-hook" "$tmp"; then',
  '    grep -vxF "# RedLog WSL hook" "$tmp" > "$tmp.2"; mv -f "$tmp.2" "$tmp"',
  '  fi',
  '  if grep -q "[^[:space:]]" "$tmp"; then cat "$tmp" > "$rc"; else rm -f "$rc"; fi',
  '  rm -f "$tmp"; echo "$name"',
  'done'
].join('\n')

/**
 * Remove this build's hook from every WSL distro, running or not — the
 * uninstaller's `--remove-hooks` run, which happens once. Returns
 * `<distro>: ~/<rc>` for each rc changed.
 */
export async function removeWslHooks(): Promise<string[]> {
  if (process.platform !== 'win32') return []
  const listing = await runWsl(['-l', '-q'])
  if (listing.status !== 0) return []
  const distros = listing.stdout.toString('utf16le').replace(/\x00/g, '')
    .split(/\r?\n/).map((l) => l.trim()).filter(Boolean)
  const paths = (['bash', 'zsh'] as const).map((s) => windowsPathToWsl(resolveHookPath(s)))
  const removed: string[] = []
  for (const distro of distros) {
    const r = await runWsl(['-d', distro, '-e', '/bin/sh', '-c', RC_REMOVE_SCRIPT, 'redlog', ...paths])
    for (const rc of r.stdout.toString().split('\n').map((l) => l.trim()).filter(Boolean)) {
      removed.push(`${distro}: ~/${rc}`)
    }
  }
  invalidateWslCache()
  return removed
}

/**
 * Check hook status for a specific distro.
 * Returns install status per shell. Installed means the rc sources this
 * build's hook; a line for another build is not-installed, so install fixes it.
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
      '-d', distro, '-e', '/bin/bash', '-c', RC_STATUS_SCRIPT,
      'redlog', rcFile, windowsPathToWsl(resolveHookPath(shell)), shell
    ])
    return result.stdout.toString().trim() === 'installed' ? 'installed' : 'not-installed'
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

  const hookPath = resolveHookPath(shell)
  if (!existsSync(hookPath)) {
    return { success: false, message: `Hook file not found: ${hookPath}` }
  }

  const wslHookPath = windowsPathToWsl(hookPath)
  const rcFile = shell === 'bash' ? '.bashrc' : '.zshrc'

  const result = await runWsl([
    '-d', distro, '-e', '/bin/bash', '-c', RC_INSTALL_SCRIPT,
    'redlog', rcFile, wslHookPath, shell
  ])
  const outcome = result.stdout.toString().trim()
  if (outcome === 'present') {
    return { success: true, message: `Hook already installed in ~/${rcFile}` }
  }

  // The rc file just changed, so the cached hookStatus is wrong.
  invalidateWslCache()

  if (result.status === 0 && outcome === 'installed') {
    return { success: true, message: `Hook installed in ~/${rcFile}` }
  }
  return { success: false, message: `Failed to write to ~/${rcFile}: ${result.stderr}` }
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
    `sed -i '/RedLog WSL hook/d; /shell-${shell}-hook/d' ~/${rcFile}`
  ])

  invalidateWslCache()

  if (result.status === 0) {
    return { success: true, message: `Hook removed from ~/${rcFile}` }
  }
  return { success: false, message: `Failed to remove hook: ${result.stderr}` }
}

/**
 * Parse the diagnostics script's own output into checks.
 *
 * The script prints coloured `✓ / ✗ / !` lines under `── section` headers —
 * not the `[PASS] name: message` shape this parser used to expect. Nothing
 * matched, so every line fell through to a catch-all that recorded it as a
 * passing `info` row: a `✗ Failed to send test event` line was shown green.
 * The parser now reads the format the script actually writes (#433).
 *
 * Exported so a test can feed it the script's real output instead of a
 * synthetic format the script never emits.
 */
export function parseDiagnosticOutput(raw: string): WslDiagnosticResult['checks'] {
  const checks: WslDiagnosticResult['checks'] = []
  let section = 'diagnostics'
  let last: WslDiagnosticResult['checks'][number] | null = null
  for (const rawLine of raw.split(/\r?\n/)) {
    const line = rawLine.replace(/\x1b\[[0-9;]*m/g, '')
    if (!line.trim()) continue

    // Section header, e.g. `── Token Path Resolution`.
    const header = line.match(/^\s*──\s*(.+?)\s*$/)
    if (header) { section = header[1]; last = null; continue }

    // The script's own verdict line closes the run; it is a restatement of the
    // counts, not a check.
    if (/^\s*[✓✗!]\s+(WSL → RedLog integration is working\.|Some checks failed)/.test(line)) {
      last = null
      continue
    }
    // `Passed: 6  Failed: 1` — the summary, not a check.
    if (/^\s*Passed:\s*\d+\s+Failed:\s*\d+\s*$/.test(line)) { last = null; continue }

    const mark = line.match(/^\s*([✓✗!])\s+(.+?)\s*$/)
    if (mark) {
      const status = mark[1] === '✓' ? 'pass' : mark[1] === '✗' ? 'fail' : 'warn'
      const body = mark[2]
      // `Token file found: /path` reads better split into name + detail; a
      // message with no `: ` keeps the section as its name.
      const split = body.match(/^(.{1,80}?):\s+(.+)$/)
      last = { name: split ? split[1] : section, status, message: split ? split[2] : body }
      checks.push(last)
      continue
    }

    // Deeper-indented prose is remediation for the check above it
    // (`      → Is RedLog running?`), not a check of its own.
    if (last && /^\s{4,}\S/.test(rawLine)) {
      last.message = `${last.message} ${line.trim()}`
      continue
    }

    // Anything else is output this parser does not understand. It used to be
    // recorded as a PASS, which is how a failure line could be shown green;
    // unknown is a warning, never a success.
    checks.push({ name: 'output', status: 'warn', message: line.trim() })
  }
  return checks
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

    if (result.status !== 0 && !stdout && !result.timedOut) {
      return {
        distro,
        checks: [{ name: 'run', status: 'fail', message: stderr || 'Diagnostics script failed' }]
      }
    }

    // Parse the script's own output — see parseDiagnosticOutput for the format
    // and why this is not `[PASS] name: message`.
    const checks: WslDiagnosticResult['checks'] = parseDiagnosticOutput(stdout)

    if (result.timedOut) {
      checks.push({
        name: 'timeout',
        status: 'fail',
        message: `Diagnostics timed out after ${WSL_TIMEOUT / 1000} seconds. A stopped WSL distro may still be starting. Start "${distro}" in a terminal, then retry diagnostics.`
      })
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
