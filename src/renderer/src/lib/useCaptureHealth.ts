import { useCallback, useEffect, useState } from 'react'

// The capture-health snapshot, for a settings row that has to say when a
// source last delivered something.
//
// #435: an operator configuring a source wants to know whether it is
// delivering, and the only honest answer is a fact about the record ("last
// received at 15:02"), not a switch position. The snapshot is the same one
// the dashboard's capture card reads, so the two screens cannot disagree
// about a source's state.
//
// It fails soft. A health read that throws leaves the settings usable: the
// source list is not the health card, and a failing health read must not
// blank the controls that configure the capture.
//
// `signature` is the settings state the snapshot depends on. It changes when
// the operator flips a source switch, and the snapshot is re-read then, so a
// row does not sit there contradicting the switch the operator just touched
// until the next poll.

export function useCaptureHealth(pollMs = 0, signature?: string): { health: CaptureHealthInfo | null; refresh: () => void } {
  const [health, setHealth] = useState<CaptureHealthInfo | null>(null)
  const refresh = useCallback(() => {
    window.redlog.capture.health()
      .then(setHealth)
      .catch(() => setHealth(null))
  }, [])
  useEffect(() => { refresh() }, [refresh, signature])
  useEffect(() => {
    if (!pollMs) return
    const id = setInterval(refresh, pollMs)
    return () => clearInterval(id)
  }, [refresh, pollMs])
  return { health, refresh }
}
