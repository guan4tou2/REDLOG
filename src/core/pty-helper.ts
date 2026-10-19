import fs from 'node:fs'
import path from 'node:path'

// node-pty starts every shell through a small helper executable on macOS
// (`spawn-helper`). Without its execute bit the spawn fails with the
// inscrutable `posix_spawnp failed`, and the built-in terminal opens but never
// runs a shell, so nothing is recorded. The bit is lost when node_modules is
// installed with scripts off (node-pty's own postinstall is what sets it) or
// copied by a tool that drops modes, so it is checked where the terminal is
// started rather than trusted to the install.

export interface PtyHelperResult {
  /** Helpers that lacked the execute bit and were fixed. */
  fixed: string[]
  /** Helpers that lacked it and could not be fixed (read-only location). */
  failed: string[]
}

/** `root` is the node-pty package directory. A packaged app keeps native files
 *  outside the archive, so the unpacked twin of each path is checked too. */
export function ensurePtyHelperExecutable(root: string, platform: string = process.platform): PtyHelperResult {
  const result: PtyHelperResult = { fixed: [], failed: [] }
  if (platform !== 'darwin') return result
  const relative = [
    path.join('prebuilds', 'darwin-arm64', 'spawn-helper'),
    path.join('prebuilds', 'darwin-x64', 'spawn-helper'),
    path.join('build', 'Release', 'spawn-helper'),
    path.join('build', 'Debug', 'spawn-helper')
  ]
  const roots = [root, root.replace(`app.asar${path.sep}`, `app.asar.unpacked${path.sep}`)]
  for (const base of new Set(roots)) {
    for (const rel of relative) {
      const file = path.join(base, rel)
      try {
        const mode = fs.statSync(file).mode
        if ((mode & 0o111) !== 0) continue
        try {
          fs.chmodSync(file, mode | 0o755)
          result.fixed.push(file)
        } catch {
          result.failed.push(file)
        }
      } catch { /* not there: this build does not ship that helper */ }
    }
  }
  return result
}
