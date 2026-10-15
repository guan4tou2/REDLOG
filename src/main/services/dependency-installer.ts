// Runs the install a preflight remediation describes, in the main process, with
// the operator's PATH already widened (login-path.ts) so uv from `uv tool
// install` in ~/.local/bin is found. The plan — run / needs-prereq / manual —
// is decided in core/dependency-install.ts and unit-tested there; this only
// spawns the command the plan cleared, captures its output, and reports the
// outcome. One code path for every dependency; mitmproxy is the first caller.

import { spawn as nodeSpawn, type ChildProcess } from 'node:child_process'
import { runPreflight, type PreflightCommand } from '../../core/runtime-preflight'
import { INSTALL_TIMEOUT_MS, planInstall } from '../../core/dependency-install'

export interface InstallDependencyResult {
  success: boolean
  message: string
  /** Present when the installer itself (uv, brew) must be installed first, so
   *  the renderer can point the operator at it rather than repeat a failure. */
  needsPrereq?: { command: string; url: string }
  cancelled?: boolean
}

interface Dependencies {
  preflight: typeof runPreflight
  spawn: typeof nodeSpawn
  timeoutMs: number
  signal?: AbortSignal
}

const DEFAULT_DEPS: Dependencies = { preflight: runPreflight, spawn: nodeSpawn, timeoutMs: INSTALL_TIMEOUT_MS }

export async function installDependency(
  id: PreflightCommand,
  deps: Partial<Dependencies> = {}
): Promise<InstallDependencyResult> {
  const { preflight, spawn, timeoutMs, signal } = { ...DEFAULT_DEPS, ...deps }
  if (signal?.aborted) return { success: false, cancelled: true, message: 'Installation cancelled' }
  const check = preflight().checks.find((c) => c.id === id)
  if (!check) return { success: false, message: `Unknown dependency: ${id}` }
  const plan = planInstall(check)
  switch (plan.kind) {
    case 'none':
      return plan.reason === 'present'
        ? { success: true, message: `${id} is already installed` }
        : { success: false, message: `No automatic installer is available for ${id}` }
    case 'needs-prereq':
      return {
        success: false,
        message: `${plan.prereq.command} is required to install ${id}`,
        needsPrereq: plan.prereq
      }
    case 'manual':
      return { success: false, message: `${id} needs elevated privileges — run "${plan.command}" in a terminal` }
    case 'run': {
      const result = await runInstall(plan.command, plan.args, spawn, timeoutMs, signal)
      if (result.success && !preflight().checks.find((c) => c.id === id)?.found) {
        return { success: false, message: `Installer exited successfully, but ${id} is not available on PATH. Check the installation or restart RedLog.` }
      }
      return result
    }
  }
}

function runInstall(
  command: string,
  args: string[],
  spawn: typeof nodeSpawn,
  timeoutMs: number,
  signal?: AbortSignal
): Promise<InstallDependencyResult> {
  return new Promise((resolve) => {
    let output = ''
    let settled = false
    let interrupted: InstallDependencyResult | undefined
    let timer: ReturnType<typeof setTimeout> | undefined
    const finish = (result: InstallDependencyResult): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal?.removeEventListener('abort', cancel)
      resolve(result)
    }
    let child: ChildProcess
    try {
      child = spawn(command, args, {
        stdio: ['ignore', 'pipe', 'pipe'], env: process.env,
        // A private POSIX process group lets cancellation include build helpers.
        detached: process.platform !== 'win32', windowsHide: true
      })
    } catch (e) {
      finish({ success: false, message: `Could not start ${command}: ${e instanceof Error ? e.message : String(e)}` })
      return
    }
    const stop = (): void => {
      if (child.pid && process.platform !== 'win32') {
        try { process.kill(-child.pid, 'SIGKILL'); return } catch { /* already gone */ }
      } else if (child.pid && process.platform === 'win32') {
        // PID comes only from the child we started; never match by tool name.
        try {
          nodeSpawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
            .on('error', () => { try { child.kill('SIGKILL') } catch { /* already gone */ } })
          return
        } catch { /* direct-child fallback */ }
      }
      try { child.kill('SIGKILL') } catch { /* already gone */ }
    }
    function cancel(): void {
      if (settled) return
      interrupted = { success: false, cancelled: true, message: 'Installation cancelled' }
      stop()
      finish(interrupted)
    }
    timer = setTimeout(() => {
      interrupted = { success: false, message: `${command} timed out after ${Math.round(timeoutMs / 1000)}s` }
      stop()
      finish(interrupted)
    }, timeoutMs)
    const collect = (chunk: string): void => { output = (output + chunk).slice(-64 * 1024) }
    child.stdout?.setEncoding('utf8'); child.stdout?.on('data', collect)
    child.stderr?.setEncoding('utf8'); child.stderr?.on('data', collect)
    child.on('error', (e: NodeJS.ErrnoException) =>
      finish({ success: false, message: e.code === 'ENOENT' ? `${command} is not installed or not on PATH` : e.message }))
    child.on('close', (code) => finish(interrupted ?? (code === 0
      ? { success: true, message: `Installed via ${command}` }
      : { success: false, message: lastLine(output) || `${command} exited with code ${code ?? 'null'}` })))
    signal?.addEventListener('abort', cancel, { once: true })
    if (signal?.aborted) cancel()
  })
}

/** The tail of an installer's output is where the reason a run failed usually
 *  is; the rest is progress noise the operator does not need in a toast. */
function lastLine(output: string): string {
  const lines = output.trim().split(/\r?\n/).filter((l) => l.trim())
  return lines.length ? lines[lines.length - 1].trim() : ''
}
