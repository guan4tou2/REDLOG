// A deleted UI string is a deleted contract, and the tests that assert it are
// part of the change — but nothing tells you so.
//
// Typecheck cannot: the assertion is a string literal. The i18n key test
// cannot: it checks that keys used in components exist, which is the opposite
// direction. Vitest mostly cannot: a renderer test that asserts a sentence
// usually renders through `t()`, so it fails only if the key is gone, not if
// the wording moved. The one thing that catches it is a full e2e round, six
// minutes long, and only if the gates before it were green.
//
// So: whatever this branch removed from a locale file, nothing in `test/` or
// `e2e/` may still be asserting. Pure functions here; `verify-i18n-assertions`
// supplies git and the filesystem.

/** Values present in `base` and gone from `current`, as a Set.
 *
 *  Keyed by VALUE, not by key: renaming a key while keeping the sentence does
 *  not break an assertion, and that is the common half of an i18n refactor. */
export function removedValues(baseDict, currentDict) {
  const kept = new Set(Object.values(currentDict))
  const gone = new Set()
  for (const value of Object.values(baseDict)) {
    if (!kept.has(value)) gone.add(value)
  }
  return gone
}

// Short strings are words, not sentences. "active", "idle" and "off" each
// match hundreds of lines that have nothing to do with the UI, and a gate that
// cries wolf is a gate someone deletes. A sentence an operator reads is longer
// than this; a label that is not is caught by the e2e round or not at all.
export const MIN_DISTINCTIVE_LENGTH = 22

export function isDistinctive(value) {
  return typeof value === 'string' && value.trim().length >= MIN_DISTINCTIVE_LENGTH
}

// A comment that quotes the old wording — "it used to read X" — is how a
// change explains itself, and must not fail the gate. Only code lines count.
function isCommentLine(line) {
  const t = line.trim()
  return t.startsWith('//') || t.startsWith('*') || t.startsWith('/*')
}

/**
 * @param {Set<string>} removed  values this branch deleted
 * @param {Array<{path: string, text: string}>} files  test and e2e sources
 * @returns {string[]} failure lines, empty when nothing asserts a dead string
 */
export function assertionsOnRemovedValues(removed, files) {
  const distinctive = [...removed].filter(isDistinctive)
  if (distinctive.length === 0) return []

  const failures = []
  for (const value of distinctive) {
    const hits = []
    for (const file of files) {
      if (!file.text.includes(value)) continue
      const live = file.text
        .split(/\r?\n/)
        .some((line) => line.includes(value) && !isCommentLine(line))
      if (live) hits.push(file.path)
    }
    if (hits.length > 0) {
      failures.push(
        `"${value}" was removed from the locale files, and is still asserted in: ${hits.join(', ')}`
      )
    }
  }
  return failures
}
