// Every Copy affordance in the app goes through here. `navigator.clipboard`
// does not work in this renderer — main/index.ts grants geolocation and denies
// every other permission, which includes the `clipboard-sanitized-write` and
// `clipboard-read` gates Chromium puts in front of the Async Clipboard API.
// The call sites that used it dropped the rejected promise, so a Copy button
// could report success while the clipboard stayed unchanged.
//
// `writeClipboard` reports whether the write actually happened; callers that
// show a confirmation must wait for it rather than assuming success.
export async function writeClipboard(text: string): Promise<boolean> {
  try {
    return await window.redlog.clipboard.writeText(text)
  } catch {
    return false
  }
}

export async function readClipboard(): Promise<string> {
  try {
    return await window.redlog.clipboard.readText()
  } catch {
    return ''
  }
}
