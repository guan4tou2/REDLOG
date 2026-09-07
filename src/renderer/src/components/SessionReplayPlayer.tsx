import { useRef, useState, useEffect, useCallback } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import { useI18n } from '../i18n'

// Frame-accurate asciinema player for a whole session's .cast slice. Extracted
// from Timeline so it can render in the app-level replay drawer (survives view
// switches) as well as anywhere else that needs it.

function fmtMMSS(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  const mm = Math.floor(s / 60).toString().padStart(2, '0')
  const ss = (s % 60).toString().padStart(2, '0')
  return `${mm}:${ss}`
}

const SPEED_OPTIONS = [0.5, 1, 2, 4] as const

// Frame-accurate asciinema player for a whole session's .cast slice. Feeds
// bytes into a live xterm.js instance so ANSI escapes render exactly the way
// they did in the original pty. Seeks by resetting the terminal and
// fast-replaying every frame up to the target — clean, and cheap enough for
// the ~50MB cast cap enforced upstream.
export function SessionReplayPlayer({ events, truncated }: { events: Array<[number, 'o', string]>; truncated: boolean }): JSX.Element {
  const { t } = useI18n()
  const wrapRef = useRef<HTMLDivElement | null>(null)
  const termRef = useRef<Terminal | null>(null)
  const fitRef = useRef<FitAddon | null>(null)
  // idx: the next event index to emit. Kept in a ref so the scheduler
  // closure can advance it without going through React state (which would
  // trigger a re-render per frame).
  const idxRef = useRef(0)
  // Absolute cast time (ms) we're "at" — advances as frames play. Ref for
  // the scheduler; mirrored into state for the UI (scrubber + timestamp).
  const posRef = useRef(0)
  const speedRef = useRef(1)
  const playingRef = useRef(false)
  const timerRef = useRef<number | null>(null)
  const [posMs, setPosMs] = useState(0)
  const [playing, setPlaying] = useState(false)
  const [speed, setSpeed] = useState<number>(1)
  const totalMs = Math.max(1, Math.round((events[events.length - 1]?.[0] ?? 0) * 1000))

  // Mount xterm once. Sized to the container width; falls back gracefully
  // when FitAddon has no dims yet (React 18 StrictMode double-mount).
  useEffect(() => {
    if (!wrapRef.current) return
    const term = new Terminal({
      convertEol: true,
      fontSize: 12,
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace',
      theme: { background: '#09090b', foreground: '#e4e4e7' },
      scrollback: 5000,
      disableStdin: true,
      cursorBlink: false
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(wrapRef.current)
    try { fit.fit() } catch { /* container not sized yet */ }
    termRef.current = term
    fitRef.current = fit
    // Draw frame 0 (usually empty) so the terminal shows something.
    return () => {
      if (timerRef.current != null) { clearTimeout(timerRef.current); timerRef.current = null }
      term.dispose()
      termRef.current = null
      fitRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Refit on container resize (detail panel width can change).
  useEffect(() => {
    if (!wrapRef.current || !fitRef.current) return
    const ro = new ResizeObserver(() => { try { fitRef.current?.fit() } catch { /* ignore */ } })
    ro.observe(wrapRef.current)
    return () => ro.disconnect()
  }, [])

  // Write every frame with cast-time <= targetMs into the terminal, starting
  // from a clean slate. Used by both initial mount and seek. O(N) in event
  // count; fine for the sizes we cap at.
  const seekTo = useCallback((targetMs: number) => {
    const term = termRef.current
    if (!term) return
    term.reset()
    let i = 0
    for (; i < events.length; i++) {
      const [tSec, , data] = events[i]
      if (tSec * 1000 > targetMs) break
      term.write(data)
    }
    idxRef.current = i
    posRef.current = targetMs
    setPosMs(targetMs)
  }, [events])

  // Once xterm is mounted, seek to 0 so the terminal is definitely primed.
  useEffect(() => {
    seekTo(0)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Advance to the next frame with a real-time-scaled delay. The scheduler
  // reads from refs (idx/pos/speed/playing) so speed changes and pauses take
  // effect on the *next* frame — no need to tear down and rebuild timers.
  const scheduleNext = useCallback(() => {
    if (timerRef.current != null) { clearTimeout(timerRef.current); timerRef.current = null }
    if (!playingRef.current) return
    const term = termRef.current
    if (!term) return
    if (idxRef.current >= events.length) {
      playingRef.current = false
      setPlaying(false)
      posRef.current = totalMs
      setPosMs(totalMs)
      return
    }
    const [tSec, , data] = events[idxRef.current]
    const evMs = tSec * 1000
    const wait = Math.max(0, evMs - posRef.current) / (speedRef.current || 1)
    // Cap wait so a long idle stretch (operator was afk for 20 minutes) doesn't
    // freeze the player. Anything longer than 3s / speed collapses to 3s / speed
    // — you can still scrub past it, but auto-play doesn't leave you staring at
    // a blank terminal.
    const capped = Math.min(wait, 3000 / (speedRef.current || 1))
    timerRef.current = window.setTimeout(() => {
      term.write(data)
      idxRef.current += 1
      posRef.current = evMs
      setPosMs(evMs)
      scheduleNext()
    }, capped)
  }, [events, totalMs])

  const doPlay = useCallback(() => {
    if (posRef.current >= totalMs) {
      // At end — restart from 0. Same semantics as most players.
      seekTo(0)
    }
    playingRef.current = true
    setPlaying(true)
    scheduleNext()
  }, [scheduleNext, seekTo, totalMs])

  const doPause = useCallback(() => {
    playingRef.current = false
    setPlaying(false)
    if (timerRef.current != null) { clearTimeout(timerRef.current); timerRef.current = null }
  }, [])

  const onSeek = useCallback((ms: number) => {
    const wasPlaying = playingRef.current
    doPause()
    seekTo(Math.max(0, Math.min(totalMs, ms)))
    if (wasPlaying) doPlay()
  }, [doPause, doPlay, seekTo, totalMs])

  const onSpeed = useCallback((v: number) => {
    speedRef.current = v
    setSpeed(v)
    // No teardown — the running timeout is honored, then the next scheduled
    // frame picks the new speed up.
  }, [])

  // Stop the timer on unmount.
  useEffect(() => () => {
    playingRef.current = false
    if (timerRef.current != null) clearTimeout(timerRef.current)
  }, [])

  return (
    <div className="mt-1.5 rounded border border-redlog-border bg-redlog-bg overflow-hidden">
      <div ref={wrapRef} className="h-[360px] w-full p-2" />
      <div className="flex items-center gap-2 border-t border-redlog-border bg-redlog-surface/70 px-2 py-1.5 text-xs">
        <button
          onClick={() => (playing ? doPause() : doPlay())}
          className="px-2 py-0.5 rounded bg-cyan-500/10 text-cyan-400 hover:bg-cyan-500/20 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-cyan-500/40"
          aria-label={playing ? t('timeline.replay.pause') : t('timeline.replay.play')}
        >{playing ? t('timeline.replay.pause') : t('timeline.replay.play')}</button>
        <button
          onClick={() => onSeek(posRef.current - 5000)}
          className="px-2 py-0.5 rounded bg-redlog-elevated text-redlog-text hover:bg-redlog-elevated-hover focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-redlog-text-dim"
        >{t('timeline.replay.stepBack')}</button>
        <button
          onClick={() => onSeek(posRef.current + 5000)}
          className="px-2 py-0.5 rounded bg-redlog-elevated text-redlog-text hover:bg-redlog-elevated-hover focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-redlog-text-dim"
        >{t('timeline.replay.stepForward')}</button>
        <input
          type="range"
          min={0}
          max={totalMs}
          step={100}
          value={posMs}
          aria-label={t('timeline.replay.seek')}
          onChange={(e) => onSeek(Number(e.target.value))}
          className="flex-1 accent-cyan-500"
        />
        <span className="font-mono tabular-nums text-redlog-text-dim whitespace-nowrap">{fmtMMSS(posMs)} / {fmtMMSS(totalMs)}</span>
        <label className="flex items-center gap-1 text-redlog-text-dim">
          <span>{t('timeline.replay.speed')}</span>
          <select
            value={speed}
            onChange={(e) => onSpeed(Number(e.target.value))}
            className="bg-redlog-elevated border border-redlog-border text-redlog-text rounded px-1 py-0.5 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-cyan-500/40"
          >
            {SPEED_OPTIONS.map((s) => (
              <option key={s} value={s}>{s}×</option>
            ))}
          </select>
        </label>
      </div>
      {truncated && (
        <p className="px-2 py-1 text-xs text-amber-400 border-t border-redlog-border bg-redlog-surface/40">{t('timeline.replay.truncated')}</p>
      )}
    </div>
  )
}

