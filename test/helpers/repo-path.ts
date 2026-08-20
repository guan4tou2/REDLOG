import path from 'path'

/**
 * A repo-relative path with forward slashes, on every platform.
 *
 * `path.relative()` returns `src\renderer\src\...` on Windows, so any test
 * that compares its result against a literal like `'src/renderer/src/x.tsx'`
 * — an exemption list, an `endsWith` filter — silently stops matching there
 * and only there. `test/truncation.test.ts` failed exactly this way in CI on
 * Windows while passing on Linux and macOS: every exemption missed, so four
 * deliberately-exempt elements were reported as violations.
 */
export function repoRelative(root: string, file: string): string {
  return path.relative(root, file).split(path.sep).join('/')
}
