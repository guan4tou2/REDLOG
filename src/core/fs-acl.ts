import { execFileSync } from 'node:child_process'

/**
 * On Windows, restrict a file or directory so only the current user has access.
 * POSIX mode bits are silently ignored by NTFS; this fills the gap with icacls.
 *
 * No-op on non-win32 platforms (POSIX mode already handles it).
 * Failures are thrown — callers decide whether to swallow or propagate.
 */
export function restrictToOwner(target: string): void {
  if (process.platform !== 'win32') return
  const user = process.env.USERNAME
  if (!user) throw new Error('USERNAME env var is not set')
  execFileSync('icacls', [target, '/inheritance:r', '/grant:r', `${user}:(F)`], {
    windowsHide: true,
    timeout: 5000
  })
}
