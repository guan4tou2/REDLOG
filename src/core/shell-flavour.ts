/** Which capture hook a shell can take, if any.
 *
 *  Kept here, free of electron and node-pty, so it is unit-testable — the
 *  bug it exists to prevent was a one-line predicate in `terminal-manager.ts`
 *  that nothing could reach from a test.
 *
 *  `none` is a real answer, not a fallback. `cmd.exe` has no hook, and a pane
 *  running one records its own lifecycle and its `.cast` but not a single
 *  command. Resolving it to the POSIX hook anyway — which is what keying off
 *  "is it PowerShell?" did — produced a hook path that could never be sourced,
 *  indistinguishable from a hook that simply had not fired yet.
 */
export type ShellFlavour = 'powershell' | 'posix' | 'none'

const POSIX_SHELLS = ['bash', 'zsh', 'sh', 'ksh', 'dash']

/**
 * Classify a shell by its executable name.
 *
 * Deliberately not platform-dependent: `bash.exe` shipped by Git for Windows,
 * MSYS2 or Cygwin is a POSIX shell and takes the POSIX hook, exactly like
 * `/bin/bash` does. The hook itself dispatches on `$ZSH_VERSION` /
 * `$BASH_VERSION`, never on the platform, and Git Bash sources the mixed
 * `C:/…/hooks/shell-preexec-hook.sh` form without complaint — verified on
 * Windows 11 before this stopped being treated as impossible.
 */
export function shellFlavour(shell: string): ShellFlavour {
  const base = (shell.split(/[\\/]/).pop() ?? shell).replace(/\.exe$/i, '').toLowerCase()
  if (base === 'powershell' || base === 'pwsh') return 'powershell'
  if (POSIX_SHELLS.includes(base)) return 'posix'
  return 'none'
}
