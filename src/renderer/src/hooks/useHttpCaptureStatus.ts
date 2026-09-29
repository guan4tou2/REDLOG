import { useCallback, useEffect, useRef, useState } from 'react'

type CaptureStatus = Omit<ManagedProxyStatus, 'state'> & { state: ManagedProxyStatus['state'] | 'unknown' }
const CHANGED = 'redlog:http-capture-changed'

/** Shared status/read/error semantics for the toolbar and Settings.
 * Polling also observes exits and changes made outside either surface. */
export function useHttpCaptureStatus(): {
  status: CaptureStatus
  busy: boolean
  refresh: () => Promise<void>
  toggle: () => Promise<CaptureStatus>
} {
  const [status, setStatus] = useState<CaptureStatus>({ state: 'unknown', url: null })
  const [busy, setBusy] = useState(false)
  const alive = useRef(false)
  const serial = useRef(0)
  const reading = useRef(false)
  const acting = useRef(false)
  const refresh = useCallback(async (): Promise<void> => {
    if (reading.current || acting.current) return
    reading.current = true
    const request = ++serial.current
    try {
      const next = await window.redlog.httpCapture.status()
      if (alive.current && request === serial.current) setStatus(next)
    } catch (error) {
      if (alive.current && request === serial.current) setStatus({ state: 'unknown', url: null, error: String(error instanceof Error ? error.message : error) })
    } finally { reading.current = false }
  }, [])
  useEffect(() => {
    alive.current = true
    void refresh()
    const timer = setInterval(() => void refresh(), 2000)
    const changed = (): void => { void refresh() }
    window.addEventListener(CHANGED, changed)
    return () => { alive.current = false; ++serial.current; clearInterval(timer); window.removeEventListener(CHANGED, changed) }
  }, [refresh])
  const toggle = async (): Promise<CaptureStatus> => {
    if (acting.current) return status
    acting.current = true
    ++serial.current // An older status read cannot overwrite this operation.
    setBusy(true)
    let next: CaptureStatus
    try {
      next = status.state === 'running' ? await window.redlog.httpCapture.stop() : await window.redlog.httpCapture.start()
    } catch (error) {
      next = { state: 'unknown', url: null, error: String(error instanceof Error ? error.message : error) }
    } finally {
      acting.current = false
      if (alive.current) setBusy(false)
    }
    if (alive.current) setStatus(next)
    // Keep the actionable failure here until a retry or a later status read.
    if (next.state !== 'unknown') window.dispatchEvent(new Event(CHANGED))
    return next
  }
  return { status, busy, refresh, toggle }
}
