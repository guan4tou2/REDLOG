/** Where the renderer loads a screenshot's image from: the stored file's name
 *  under the `redlog-screenshot` protocol. Null when the event carries no file
 *  (a screenshot recorded through the API without one). */
export function screenshotSrc(data: Record<string, unknown> | undefined): string | null {
  const filePath = data?.filePath
  if (typeof filePath !== 'string' || !filePath) return null
  const basename = filePath.split(/[\\/]/).pop() || ''
  return basename ? `redlog-screenshot://local/${encodeURIComponent(basename)}` : null
}
