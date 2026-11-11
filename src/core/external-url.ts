// What the renderer may ask the OS to open in the operator's browser.
//
// http and https only: Electron's openExternal also dispatches file:// and
// app-registered schemes, and untrusted plugin content can reach the handler.
// No userinfo: `http://user:pass@host/` hands those credentials to the browser
// and to anything the OS logs the URL to, and the host shown after the `@` is
// easy to misread.

export function externalUrlAllowed(url: unknown): boolean {
  if (typeof url !== 'string') return false
  let u: URL
  try { u = new URL(url) } catch { return false }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return false
  return u.username === '' && u.password === ''
}
