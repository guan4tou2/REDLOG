import { shellFlavour, type ShellFlavour } from './shell-flavour'

/**
 * The shells a built-in terminal pane can be opened with.
 *
 * Until now the pane's shell was decided by one predicate over `$SHELL` with
 * no way for the operator to intervene, which meant the same machine captured
 * or did not capture depending on how RedLog happened to be launched (#94).
 * Making the choice explicit is the other half of that fix: an operator who
 * can see which shells exist, and which of them RedLog can hook, can no longer
 * be surprised by the answer.
 *
 * `hookable` is derived, never hand-set — it is exactly "this flavour has a
 * hook file", so a shell that cannot be recorded says so in the picker rather
 * than only after a pane has been opened.
 */
export interface ShellOption {
  /** Stable id, persisted as the operator's choice. `wsl:<distro>` for WSL. */
  id: string
  label: string
  /** Executable handed to pty.spawn. */
  command: string
  args: string[]
  flavour: ShellFlavour
  /** Set for WSL entries: the hook path needs /mnt/c/… conversion inside it. */
  wslDistro?: string
}

/** What the catalog needs to know about the machine. Injected so the build
 *  step is a pure function — the probing itself lives in the main process and
 *  is the part that must not block it. */
export interface ShellProbe {
  platform: NodeJS.Platform
  /** `$SHELL`, when set and usable. */
  envShell?: string
  /** Absolute paths that exist on this machine. */
  exists: (path: string) => boolean
  /** Distro names from `wsl -l -v`, already filtered to what can be entered. */
  wslDistros: string[]
}

/** Where Git for Windows and MSYS2 put a bash, in the order we prefer them. */
const WINDOWS_BASH_PATHS = [
  'C:\\Program Files\\Git\\bin\\bash.exe',
  'C:\\Program Files\\Git\\usr\\bin\\bash.exe',
  'C:\\Program Files (x86)\\Git\\bin\\bash.exe',
  'C:\\msys64\\usr\\bin\\bash.exe'
]

const INTERNAL_WSL_DISTROS = new Set(['docker-desktop', 'docker-desktop-data'])

const POSIX_SHELL_PATHS = ['/bin/zsh', '/bin/bash', '/usr/bin/zsh', '/usr/bin/bash', '/bin/sh']

export function isHookable(flavour: ShellFlavour): boolean {
  return flavour !== 'none'
}

export function buildShellCatalog(probe: ShellProbe): ShellOption[] {
  const out: ShellOption[] = []
  const push = (o: ShellOption): void => {
    if (!out.some((e) => e.id === o.id)) out.push(o)
  }

  if (probe.platform === 'win32') {
    // PowerShell first: it is what an unconfigured Windows install lands on,
    // and it is hookable.
    push({
      id: 'powershell',
      label: 'PowerShell',
      command: 'powershell.exe',
      args: ['-ExecutionPolicy', 'Bypass', '-NoLogo'],
      flavour: 'powershell'
    })
    if (probe.exists('C:\\Program Files\\PowerShell\\7\\pwsh.exe')) {
      push({
        id: 'pwsh',
        label: 'PowerShell 7',
        command: 'C:\\Program Files\\PowerShell\\7\\pwsh.exe',
        args: ['-ExecutionPolicy', 'Bypass', '-NoLogo'],
        flavour: 'powershell'
      })
    }
    const bash = WINDOWS_BASH_PATHS.find(probe.exists)
    if (bash) {
      push({ id: 'git-bash', label: 'Git Bash', command: bash, args: [], flavour: 'posix' })
    }
    for (const distro of probe.wslDistros) {
      // Docker Desktop registers its plumbing as WSL distros. They are not
      // shells an operator works in — `docker-desktop` opened here gives a
      // prompt with no rc file and no commands to record — and listing them
      // buries the real distros. Seen on this machine: Ubuntu-26.04,
      // docker-desktop, kali-linux.
      if (INTERNAL_WSL_DISTROS.has(distro.toLowerCase())) continue
      push({
        id: `wsl:${distro}`,
        label: `WSL · ${distro} · Bash`,
        command: 'wsl.exe',
        args: ['-d', distro, '--', '/bin/bash'],
        flavour: 'posix',
        wslDistro: distro
      })
    }
    // Last, and openly unhookable: an operator who wants cmd should be able to
    // have it, told plainly that its commands will not be recorded.
    push({ id: 'cmd', label: 'Command Prompt', command: 'cmd.exe', args: [], flavour: 'none' })
    return out
  }

  // POSIX: the operator's own shell first, then whatever else is installed.
  if (probe.envShell && probe.exists(probe.envShell)) {
    push({
      id: 'default',
      label: probe.envShell.split('/').pop() ?? probe.envShell,
      command: probe.envShell,
      args: [],
      flavour: shellFlavour(probe.envShell)
    })
  }
  for (const p of POSIX_SHELL_PATHS) {
    if (!probe.exists(p)) continue
    const name = p.split('/').pop() as string
    push({ id: name, label: name, command: p, args: [], flavour: shellFlavour(p) })
  }
  return out
}

/** The entry a pane opens with when the operator has not chosen one.
 *  Prefers a shell RedLog can actually record over one it cannot. */
export function defaultShell(catalog: ShellOption[], preferredId?: string): ShellOption | null {
  if (preferredId) {
    const chosen = catalog.find((s) => s.id === preferredId)
    if (chosen) return chosen
  }
  return catalog.find((s) => isHookable(s.flavour)) ?? catalog[0] ?? null
}
