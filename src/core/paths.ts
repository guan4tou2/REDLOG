import path from 'path'

/**
 * Case-insensitive containment check for path guards. NTFS is
 * case-preserving but case-insensitive, so a legitimate
 * `c:\Users\foo\.redlog\…` vs the project dir's `C:\Users\foo\…` would trip
 * a naive `startsWith(dir)` compare. Uses `path.relative` so `..\` escapes
 * are caught too, and case-folds both sides on Windows only.
 *
 * The `screenshot:read` / `screenshot:deleteFile` IPC guards, plugin
 * extraction, and any other "resolve then check inside root" call should
 * route through this helper rather than reinventing it. Audit P1-2
 * (docs/WINDOWS_COMPAT_AUDIT.md).
 */
export function isInsideDir(root: string, target: string): boolean {
  // Pick the same-shape path lib as the input's OS so `path.relative` walks
  // separators correctly. On Windows the case-fold also lets a `c:\Users\…`
  // vs `C:\Users\…` pair pass.
  const p = process.platform === 'win32' ? path.win32 : path.posix
  const rel = process.platform === 'win32'
    ? p.relative(root.toLowerCase(), target.toLowerCase())
    : p.relative(root, target)
  if (rel === '') return true                       // exact match
  if (rel.startsWith('..')) return false            // parent-dir escape
  if (p.isAbsolute(rel)) return false               // different drive on Windows
  return true
}
