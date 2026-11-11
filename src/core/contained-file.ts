// A file the main process will read (or delete) on a caller's say-so, inside
// one of the project's own folders.
//
// `path.resolve` + `isInsideDir` judges the NAME. A symlink planted inside
// screenshots/ or http-bodies/ passes that check and then reads whatever it
// points at. This judges the file: the name must resolve inside `root`, the
// entry itself must be a regular file (not a link), and after every link on
// the way is resolved it must still be inside the real `root`. The same
// approach as evidence-file.ts, stricter on one point: a link is refused even
// when it points somewhere inside.

import fs from 'fs'
import path from 'path'
import { isInsideDir } from './paths'

/** The real path of `name` under `root`, or null when it is not a regular,
 *  non-link file contained in `root` (also null when `root` is itself a link). */
export function resolveContainedFile(root: string, name: unknown): string | null {
  if (typeof name !== 'string' || name === '' || name.includes('\0')) return null
  const resolvedRoot = path.resolve(root)
  const resolved = path.resolve(resolvedRoot, name)
  if (resolved === resolvedRoot || !isInsideDir(resolvedRoot, resolved)) return null
  try {
    if (fs.lstatSync(resolvedRoot).isSymbolicLink()) return null
    const entry = fs.lstatSync(resolved)
    if (!entry.isFile()) return null
    const realRoot = fs.realpathSync(resolvedRoot)
    const real = fs.realpathSync(resolved)
    if (real === realRoot || !isInsideDir(realRoot, real)) return null
    return real
  } catch {
    return null
  }
}
