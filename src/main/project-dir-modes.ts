import fs from 'node:fs'
import path from 'node:path'

// Directories a project grows after it is created. Some of their creators pass
// no mode (terminal recording: `casts`; the export runner: `exports`), so under
// a 022 umask they appear 0755. Opening the project brings the ones that exist
// back to owner-only. Only these directories, never what is in them: a project
// can hold tens of thousands of files and this runs on every open.
const PROJECT_PRIVATE_DIRS = [
  'casts', 'exports', 'raw', 'http-bodies', 'screenshots', 'agent-transcripts', 'artifacts', 'browser-profile'
]

/** chmod 0700 on each known project subdirectory that exists as a real
 *  directory (a symlink is left alone: chmod would follow it out of the
 *  project). No-op on Windows, where node ignores modes (fs-acl.ts covers it).
 *  Never throws: a mount that refuses chmod must not stop the project opening. */
export function restrictProjectDirs(projectDir: string, platform: NodeJS.Platform = process.platform): void {
  if (platform === 'win32') return
  for (const name of PROJECT_PRIVATE_DIRS) {
    const dir = path.join(projectDir, name)
    try {
      if (fs.lstatSync(dir).isDirectory()) fs.chmodSync(dir, 0o700)
    } catch { /* missing, or chmod refused */ }
  }
}
