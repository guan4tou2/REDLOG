/** Pending edits belong to the project, not the mounted Settings page.
 * Serialize writes and retain a failed snapshot so project close can retry it. */
export function createSettingsWriteQueue<T>(save: (projectId: string, config: T) => Promise<boolean | void>) {
  const pending = new Map<string, { value: T }>()
  const running = new Map<string, Promise<boolean>>()
  function stage(projectId: string, value: T): void {
    pending.set(projectId, { value })
  }
  function flush(projectId: string): Promise<boolean> {
    const active = running.get(projectId)
    if (active) return active
    const work = Promise.resolve().then(async () => {
      while (pending.has(projectId)) {
        const next = pending.get(projectId)!
        try {
          if (await save(projectId, next.value) === false) return false
        } catch { return false }
        if (pending.get(projectId) === next) pending.delete(projectId)
      }
      return true
    }).finally(() => { running.delete(projectId) })
    running.set(projectId, work)
    return work
  }
  return { stage, flush, peek: (projectId: string): T | undefined => pending.get(projectId)?.value }
}

export const settingsWrites = createSettingsWriteQueue<unknown>(async (projectId, config) => {
  const ok = await window.redlog.config.save(config, { expectProjectId: projectId })
  if (ok !== false) window.dispatchEvent(new CustomEvent('redlog:config-saved'))
  return ok !== false
})
