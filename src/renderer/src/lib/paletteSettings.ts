import { searchSettings, type SettingsHit } from './settingsSearch'

// The palette's "Setting" rows must be something an operator can go and set.
// The index holds every string a settings page renders — hints, error
// messages, placeholders, status words — and does not say which is which, so
// the key name does: these suffixes mark text that describes or reports, not a
// control or a group title.
const NOT_A_CONTROL = /(?:Hint|Failed|Why|Error|Empty|Unknown|Missing|Pending|Ready|Note|Placeholder|Stopped|Builtin|Unavailable|Unreachable)(?:[A-Z][A-Za-z]*)?$/

// `httpCapture.caReady` is the CA download link, a place to go, though its name
// reads like a status.
const KEEP = new Set(['httpCapture.caReady'])

// A control's label is a few words. The index also holds whole sentences under
// keys whose names give no sign of it ("Only web-traffic capture needs this.
// You can record…"): a sentence is an explanation, not somewhere to go.
const SENTENCE = /[.。!?！？](?:\s|$)/
const LABEL_MAX = 60

export function looksLikeLabel(text: string): boolean {
  return text.length <= LABEL_MAX && !SENTENCE.test(text)
}

export function isSettingControlKey(key: string): boolean {
  return KEEP.has(key) || !NOT_A_CONTROL.test(key.slice(key.lastIndexOf('.') + 1))
}

/** Up to `limit` setting rows for `query`, plus whether more matched. The
 *  filter runs before the cap, or a page of hints would crowd out the controls. */
export function paletteSettingsHits(
  query: string,
  t: (key: string) => string,
  platform: string | undefined,
  limit: number
): { hits: SettingsHit[]; hasMore: boolean } {
  const all = searchSettings(query, t, 500, platform).filter((h) => isSettingControlKey(h.key) && looksLikeLabel(h.text))
  return { hits: all.slice(0, limit), hasMore: all.length > limit }
}
