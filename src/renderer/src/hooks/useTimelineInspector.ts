import { useCallback, useEffect, useRef, useState } from 'react'
import type { RedLogEvent } from '../../../core/db/events'
import type { ReaderMode } from '../components/EventContentReader'

/** Ring selection, inspector visibility and content reading are separate state.
 * The Reader is scoped to one event and can never open for a later selection. */
export function useTimelineInspector() {
  const [selectedEvent, setSelectedEvent] = useState<RedLogEvent | null>(null)
  const selectedRef = useRef(selectedEvent)
  selectedRef.current = selectedEvent
  const [detailOpen, setDetailOpen] = useState(false)
  const [reader, setReaderState] = useState<{ id: string | null; mode: ReaderMode }>({ id: null, mode: 'closed' })
  const id = selectedEvent?.id ?? null
  const readerMode: ReaderMode = detailOpen && reader.id === id ? reader.mode : 'closed'
  const setReader = useCallback((mode: ReaderMode) => setReaderState({ id, mode }), [id])
  useEffect(() => { if (!detailOpen) setReaderState({ id: null, mode: 'closed' }) }, [detailOpen])
  return { selectedEvent, selectedRef, setSelectedEvent, detailOpen, setDetailOpen, readerMode, setReader }
}
