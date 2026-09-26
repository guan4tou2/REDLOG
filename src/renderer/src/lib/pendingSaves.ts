// Saves still waiting to reach main (#223).
//
// Settings debounces its autosave by 350 ms and flushes the pending write when
// it unmounts. Closing the project used to await `project.close()` first and
// only then unmount Settings — so the flush reached main after the project was
// gone, was refused for having no active project, and nothing said so. The
// change the operator had just made was lost.
//
// So anything holding an unsaved change registers here, and closing a project
// flushes them first. A failed flush stops the close: the operator is still in
// the project, the change is still on screen, and they can try again.

type Flush = () => Promise<boolean>

const flushers = new Set<Flush>()

export function registerPendingSave(flush: Flush): () => void {
  flushers.add(flush)
  return () => { flushers.delete(flush) }
}

/** Write every pending change now. True when all of them were saved. */
export async function flushPendingSaves(): Promise<boolean> {
  const results = await Promise.all([...flushers].map((f) => f().catch(() => false)))
  return results.every(Boolean)
}

/** Close the active project, after its pending saves. False — and the
 *  project left open — when a save could not be written. */
export async function closeProjectAfterSaves(): Promise<boolean> {
  if (!(await flushPendingSaves())) return false
  await window.redlog.project.close()
  return true
}
