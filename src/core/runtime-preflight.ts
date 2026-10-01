// Spec 036: what this machine needs before a capture adapter can record.
//
// The POSIX adapters build every event with python3 and send it with curl; a
// missing one used to leave the hook "installed" and silently recording
// nothing. Preflight answers from the filesystem — PATH lookups via
// command-lookup, no processes spawned — so it is safe to call from the main
// thread on every onboarding render.
//
// It also used to detect shell profiles still sourcing an entry point Spec 006
// retired, and offer to migrate them. That is gone: RedLog is pre-1.0 and
// carries no installed base worth a compatibility path.

import { basename } from 'path'
import { isOnPath } from './command-lookup'

export type PreflightCommand = 'python3' | 'curl' | 'mitmdump' | 'zsh' | 'bash' | 'pwsh' | 'powershell'

export interface PreflightCheck {
  id: PreflightCommand
  found: boolean
  /** hook ids that cannot record without this command */
  neededFor: string[]
  /** copyable install command; present only when the command is missing */
  remediation?: string
  /** The tool `remediation` is typed into, when it is not one every machine
   *  has. A clean box may have neither `uv` nor `brew`, so a bare
   *  `uv tool install mitmproxy` is a command the operator cannot run and no
   *  hint about why. Named here rather than baked into the command string so
   *  the UI can offer the prerequisite without parsing it back out. */
  remediationRequires?: { command: string; url: string }
}


export interface PreflightResult {
  platform: NodeJS.Platform
  shell: { name: string; hookId: string } | null
  checks: PreflightCheck[]
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

// The installer a remediation is typed into. `apt` and `winget` ship with the
// systems that use them here; `uv` and `brew` do not, so a clean machine can
// be handed a fix it cannot run.
const UV = { command: 'uv', url: 'https://docs.astral.sh/uv/getting-started/installation/' }
const BREW = { command: 'brew', url: 'https://brew.sh' }
/** Exported for its own test: a PATH cannot be simulated for a foreign
 *  platform from Windows, because an absolute path there contains the colon
 *  that a POSIX PATH splits on. */
export function remediationRequiresFor(
  remediation: string | undefined,
  found: (cmd: string) => boolean
): { command: string; url: string } | undefined {
  if (!remediation) return undefined
  const tool = remediation.startsWith('uv ') ? UV : remediation.startsWith('brew ') ? BREW : null
  // Only when it is actually absent: naming a prerequisite the operator
  // already has is noise on the one screen that must stay readable.
  return tool && !found(tool.command) ? tool : undefined
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
    const requires = remediationRequiresFor(remediation, found)
    if (!remediation) return { id, found: ok, neededFor }
    return requires
      ? { id, found: ok, neededFor, remediation, remediationRequires: requires }
      : { id, found: ok, neededFor, remediation }
  })
  return {
    platform,
    shell: detectShell(platform, env, found),
    checks
  }
}
