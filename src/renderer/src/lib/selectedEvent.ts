// The one selected event (Spec 069 FR-006). The Timeline, the Activity list and
// the readers all read and write this id, so switching view keeps what the
// operator was looking at. The storage key is the Timeline's own, from before
// there was a second writer — kept so a stored selection survives the upgrade.

export const SELECTED_EVENT_KEY = 'redlog-timeline-focus-event'

export function readSelectedEventId(): string | null {
  try { return localStorage.getItem(SELECTED_EVENT_KEY) } catch { return null }
}

export function writeSelectedEventId(id: string | null): void {
  try {
    if (id) localStorage.setItem(SELECTED_EVENT_KEY, id)
    else localStorage.removeItem(SELECTED_EVENT_KEY)
  } catch { /* storage unavailable: selection just isn't shared */ }
}
