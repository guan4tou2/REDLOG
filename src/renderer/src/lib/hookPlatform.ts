// Which shell adapters belong to which host. PowerShell and the WSL bridge are
// Windows things; zsh and bash are not native there. On a Mac, rows for the
// first two sat in the main list as dimmed "not found" entries and read as
// setup that was missing (Spec 060 FR-010, US4.1).
//
// A hook is only moved aside when it is foreign to the host AND neither
// installed nor usable: PowerShell on a Mac with pwsh on PATH, or an adapter
// that is already wired up, stays where the operator can see it.

const WINDOWS_ONLY = new Set(['shell-powershell', 'shell-wsl'])
const POSIX_ONLY = new Set(['shell-zsh', 'shell-bash'])

export function isForeignShellHook(
  hook: { id: string; installed: boolean; available: boolean },
  platform: string | undefined
): boolean {
  if (hook.installed || hook.available) return false
  if (platform === 'win32') return POSIX_ONLY.has(hook.id)
  return WINDOWS_ONLY.has(hook.id)
}
