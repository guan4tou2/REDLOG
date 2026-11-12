// "In use, not recorded" notes the operator has put away, per project and per
// AI tool. A per-viewer convenience, so localStorage rather than the project
// config: dismissing a note is not a fact about the engagement, and the note
// itself disappears once the source is turned on.

const KEY = 'redlog.capture.unrecordedAgentDismissed'

function readAll(): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(KEY) ?? '{}')
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
  } catch { return {} }
}

export function dismissedUnrecordedAgents(projectId: string): ReadonlySet<string> {
  const ids = readAll()[projectId]
  return new Set(Array.isArray(ids) ? ids.filter((id): id is string => typeof id === 'string') : [])
}

export function dismissUnrecordedAgent(projectId: string, sourceId: string): void {
  const all = readAll()
  all[projectId] = [...new Set([...dismissedUnrecordedAgents(projectId), sourceId])]
  try { localStorage.setItem(KEY, JSON.stringify(all)) } catch { /* this window still hides it */ }
}
