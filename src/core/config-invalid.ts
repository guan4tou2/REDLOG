// The one fact about an unusable config.yaml that has to cross IPC. Electron
// keeps only an error's message, prefixed with its own text, so the renderer
// recognises the refusal by this tag rather than by a class or a code. Kept
// out of config.ts because the renderer cannot import a module that uses fs.

export const CONFIG_INVALID_TAG = '[config-invalid]'

/** `<file>: <reason>` from a refused open's message, or null when the message
 *  is about something else. */
export function configInvalidDetail(message: string): string | null {
  const at = message.indexOf(CONFIG_INVALID_TAG)
  return at < 0 ? null : message.slice(at + CONFIG_INVALID_TAG.length).trim()
}
