// A spec number is part of a directory name, and directory names do not merge.
//
// Two branches that each start "the next spec" pick the same number, and git
// is perfectly happy: the two directories differ by their slug, so both land
// and nothing conflicts. The collision surfaces later, as two specs numbered
// 048 in one tree — and by then the number is written into the spec's own
// heading, its tasks, its plan, its verification record, and every commit
// message and code comment that cited it. Renaming is the cheap part.
//
// Pure, so the gate can check a real tree and the test can check the cases a
// real tree does not have at any given moment.

/** The NNN prefix of a spec directory, or null for a directory without one. */
export function specNumber(dir) {
  return /^(\d{3})-/.exec(dir)?.[1] ?? null
}

/**
 * @param {string[]} local  spec directory names in the working tree
 * @param {string[]|null} main  the same on origin/main, or null when that ref
 *   is not reachable (a shallow CI checkout, a clone with no remote) — the
 *   local half still runs, because a gate that fails on a missing ref is a
 *   gate someone switches off.
 * @returns {string[]} failure lines, empty when every number is unique
 */
export function numberCollisions(local, main) {
  const failures = []

  const byNumber = new Map()
  for (const dir of local) {
    const n = specNumber(dir)
    if (n === null) continue
    byNumber.set(n, [...(byNumber.get(n) ?? []), dir])
  }
  for (const [n, dirs] of [...byNumber].sort()) {
    if (dirs.length > 1) failures.push(`spec number ${n} is used twice: ${dirs.join(', ')}`)
  }

  if (main === null) return failures

  const onMain = new Map()
  for (const dir of main) {
    const n = specNumber(dir)
    if (n !== null) onMain.set(n, dir)
  }
  for (const dir of local) {
    const n = specNumber(dir)
    if (n === null) continue
    const theirs = onMain.get(n)
    if (theirs !== undefined && theirs !== dir) {
      failures.push(
        `${dir}: number ${n} is already ${theirs} on origin/main — renumber before the PR ` +
        '(rename the directory, then fix the spec heading and every tasks/plan/verification reference to it)'
      )
    }
  }
  return failures
}
