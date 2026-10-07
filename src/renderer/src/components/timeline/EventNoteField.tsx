import { useEffect, useRef, useState } from 'react'
import { formatDateTime } from '../../lib/time'

// What the operator made of this event.
//
// The record says what happened. It does not say "this 404 is the interesting
// one" or "ran this twice by mistake" — and three weeks later, writing the
// report, that is the part nobody can reconstruct.
//
// An ANNOTATION, never evidence, and the storage says so: a side table keyed
// by event id, because events rows are hashed and immutable and a note
// written an hour later must not touch the row it is about or the chain stops
// verifying. It carries its own timestamps, so a reader can see it was
// written after the fact and when.
//
// Saves on blur, not per keystroke: a note is a thought finished, and a write
// per character would put the operator's typing on the DB's hot path while a
// scan is running.

/** Fired after a note is written or cleared, so an open list re-reads. */
export const EVENT_NOTE_SAVED = 'redlog:event-note-saved'

export function EventNoteField({ eventId, t }: {
  eventId: string
  t: (key: string, vars?: Record<string, string | number>) => string
}): JSX.Element {
  const [text, setText] = useState('')
  const [saved, setSaved] = useState<{ note: string; updatedAt: number } | null>(null)
  // What is actually in the database, so blur knows whether anything changed.
  const committed = useRef('')

  useEffect(() => {
    let cancelled = false
    setText(''); setSaved(null); committed.current = ''
    void window.redlog.events.getNote(eventId).then((n) => {
      if (cancelled || !n) return
      setText(n.note); setSaved(n); committed.current = n.note
    }).catch(() => { /* a note that cannot be read is an empty field, not an error */ })
    return () => { cancelled = true }
  }, [eventId])

  const commit = (): void => {
    if (text.trim() === committed.current) return
    committed.current = text.trim()
    void window.redlog.events.setNote(eventId, text).then((n) => {
      setSaved(n)
      // The list needs to know: an annotated event stops folding into a
      // summary the moment somebody writes on it.
      try { window.dispatchEvent(new CustomEvent(EVENT_NOTE_SAVED, { detail: { eventId } })) } catch { /* no window */ }
    }).catch(() => {})
  }

  return (
    <div className="mt-3">
      <div className="flex items-center justify-between mb-1">
        <span className="text-xs text-redlog-text-faint">{t('timeline.detail.note')}</span>
        {/* When, not just that. An annotation's whole honesty is that it was
            written after the event, so the moment it was written is part of
            what it says. */}
        {saved && (
          <span className="text-xs text-redlog-text-faint font-mono tabular-nums">
            {t('timeline.detail.noteSavedAt', { time: formatDateTime(saved.updatedAt) })}
          </span>
        )}
      </div>
      <textarea
        data-testid="event-note"
        value={text}
        onChange={(e) => setText(e.target.value)}
        onBlur={commit}
        rows={2}
        maxLength={4000}
        className="w-full resize-y rounded border border-redlog-border bg-redlog-bg px-2 py-1.5 text-xs text-redlog-text focus:outline-none focus:border-redlog-accent/60"
      />
    </div>
  )
}
