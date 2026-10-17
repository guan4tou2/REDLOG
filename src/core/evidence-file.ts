// Where an evidence file the operator is asking to see actually is.
//
// The renderer names a file; it does not get to point the main process at an
// arbitrary location. Only a regular file inside the open project's own
// `artifacts/` or `screenshots/` folder resolves — anything else, including a
// `..` walk or a symlink out of the folder, comes back null.
//
// The result is for showing in the file manager, never for opening: an
// operator's evidence includes samples they were handed, and "open" would run
// them with whatever the OS associates with the file.

import fs from 'fs'
import path from 'path'
import { ARTIFACTS_DIR } from './artifacts'
import { isInsideDir } from './paths'

export type EvidenceFileKind = 'artifact' | 'screenshot'

const FOLDER: Record<EvidenceFileKind, string> = { artifact: ARTIFACTS_DIR, screenshot: 'screenshots' }

export function resolveEvidenceFile(projectDir: string, kind: EvidenceFileKind, file: unknown): string | null {
  if (typeof file !== 'string' || file === '' || file.includes('\0')) return null
  const folder = path.resolve(projectDir, FOLDER[kind])
  // An artifact is recorded relative to the project, a screenshot as an
  // absolute path; both resolve against the project folder the same way.
  const resolved = path.resolve(projectDir, file)
  if (!isInsideDir(folder, resolved) || resolved === folder) return null
  try {
    // Resolve links before judging containment: a link inside the folder that
    // points outside it is not an evidence file.
    const real = fs.realpathSync(resolved)
    if (!isInsideDir(fs.realpathSync(folder), real)) return null
    if (!fs.statSync(real).isFile()) return null
    return resolved
  } catch {
    return null
  }
}
