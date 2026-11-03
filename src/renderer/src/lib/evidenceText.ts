// Untrusted bytes reach the interface verbatim: commands, output, URLs, file
// paths, marker notes. Unicode direction controls are invisible in most fonts,
// so the rendered line can be ordered differently from the bytes that were
// recorded — same trick as Trojan Source (CVE-2021-42574), aimed at whoever
// reads the evidence rather than a compiler.
//
// Evidence has to read as it was captured, so the controls are replaced with a
// visible name at render time. Nothing here touches what is stored: the chain
// keeps the original bytes, and copy/save hand back the original bytes.

/** Controls that reorder, hide or split a line. */
const NAMES: Record<string, string> = {
  '\u202A': 'LRE', '\u202B': 'RLE', '\u202C': 'PDF', '\u202D': 'LRO', '\u202E': 'RLO',
  '\u2066': 'LRI', '\u2067': 'RLI', '\u2068': 'FSI', '\u2069': 'PDI',
  '\u200E': 'LRM', '\u200F': 'RLM',
  '\u2028': 'LS', '\u2029': 'PS',
  '\u200B': 'ZWSP', '\u200C': 'ZWNJ', '\u200D': 'ZWJ', '\uFEFF': 'BOM'
}
const ANY = /[\u200B-\u200F\u202A-\u202E\u2066-\u2069\u2028\u2029\uFEFF]/g

/** True when `safeDisplay` would change this string. Callers that map what is
 *  on screen back to byte offsets (the content reader's selection marker) must
 *  not do that when the display no longer matches the stored text. */
export function hasUnsafeText(text: string): boolean {
  ANY.lastIndex = 0
  return ANY.test(text)
}

/** The same string with every direction/zero-width control replaced by
 *  `⟨NAME⟩`, so the reader can see that one is present. */
export function safeDisplay(text: string): string {
  if (!hasUnsafeText(text)) return text
  return text.replace(ANY, (ch) => `⟨${NAMES[ch] ?? 'CTRL'}⟩`)
}
