// Runs the install a preflight remediation describes, in the main process, with
// the operator's PATH already widened (login-path.ts) so uv from `uv tool
// install` in ~/.local/bin is found. The plan — run / needs-prereq / manual —
// is decided in core/dependency-install.ts and unit-tested there; this only
// spawns the command the plan cleared, captures its output, and reports the
// outcome. One code path for every dependency; mitmproxy is the first caller.

import { spawn as nodeSpawn, type ChildProcess } from 'node:child_process'
import { runPreflight, type PreflightCommand } from '../../core/runtime-preflight'
import { planInstall } from '../../core/dependency-install'

export interface InstallDependencyResult {
  success: boolean
  message: string
  /** Present when the installer itself (uv, brew) must be installed first, so
   *  the renderer can point the operator at it rather than repeat a failure. */
  needsPrereq?: { command: string; url: string }
}

interface Dependencies {
  preflight: typeof runPreflight
  spawn: typeof nodeSpawn
  timeoutMs: number
}

const DEFAULT_DEPS: Dependencies = { preflight: runPreflight, spawn: nodeSpawn, timeoutMs: 180_000 }

export async function installDependency(
  id: PreflightCommand,
  deps: Partial<Dependencies> = {}
): Promise<InstallDependencyResult> {
  const { preflight, spawn, timeoutMs } = { ...DEFAULT_DEPS, ...deps }
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
    case 'run':
      return runInstall(plan.command, plan.args, spawn, timeoutMs)
  }
}

function runInstall(
  command: string,
  args: string[],
  spawn: typeof nodeSpawn,
  timeoutMs: number
): Promise<InstallDependencyResult> {
  return new Promise((resolve) => {
    let output = ''
    let settled = false
    const finish = (result: InstallDependencyResult): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(result)
    }
    let child: ChildProcess
    try {
      child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'], env: process.env })
    } catch (e) {
      finish({ success: false, message: `Could not start ${command}: ${e instanceof Error ? e.message : String(e)}` })
      return
    }
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL') } catch { /* already gone */ }
      finish({ success: false, message: `${command} timed out after ${Math.round(timeoutMs / 1000)}s` })
    }, timeoutMs)
    const collect = (chunk: string): void => { output += chunk }
    child.stdout?.setEncoding('utf8'); child.stdout?.on('data', collect)
    child.stderr?.setEncoding('utf8'); child.stderr?.on('data', collect)
    child.on('error', (e: NodeJS.ErrnoException) =>
      finish({ success: false, message: e.code === 'ENOENT' ? `${command} is not installed or not on PATH` : e.message }))
    child.on('close', (code) => finish(code === 0
      ? { success: true, message: `Installed via ${command}` }
      : { success: false, message: lastLine(output) || `${command} exited with code ${code ?? 'null'}` }))
  })
}

/** The tail of an installer's output is where the reason a run failed usually
 *  is; the rest is progress noise the operator does not need in a toast. */
function lastLine(output: string): string {
  const lines = output.trim().split(/\r?\n/).filter((l) => l.trim())
  return lines.length ? lines[lines.length - 1].trim() : ''
}
