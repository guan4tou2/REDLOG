import path from 'path'
import { resolveContainedFile } from '../core/contained-file'

/** Which file a `redlog-screenshot://` request may read: a regular file
 *  directly in the open project's screenshots/ folder, or the status to answer
 *  with. A symlink placed there used to be followed to whatever it named. */
export function screenshotRequestFile(requestUrl: string, projectDir: string): { file: string } | { status: 400 | 404 } {
  let basename: string
  try {
    const url = new URL(requestUrl)
    // Only the trailing path segment, so `redlog-screenshot://local/foo.jpg`
    // and `redlog-screenshot://foo.jpg` both resolve to <projectDir>/screenshots/foo.jpg.
    // Callers pass basename only; the hostname/segment ordering depends on how
    // Chromium normalises the URL (differs between platforms).
    const segments = decodeURIComponent(url.pathname).split('/').filter(Boolean)
    basename = segments[segments.length - 1] || decodeURIComponent(url.hostname || '')
  } catch {
    return { status: 400 }
  }
  if (!basename || basename.includes('..') || basename.includes('/') || basename.includes('\\')) return { status: 400 }
  // Missing, a link, or not a regular file: the same 404 a missing file gave.
  const file = resolveContainedFile(path.join(projectDir, 'screenshots'), basename)
  return file ? { file } : { status: 404 }
}
