import { useEffect, useState } from 'react'
import { useI18n } from '../i18n'
import { toast } from './Toast'
import { toggleRecordingWithFeedback } from '../lib/recordingToggle'
import { useIssues, raiseIssue, clearIssue } from '../lib/issues'
import { formatTime, formatDateTime, useDisplayZone } from '../lib/time'
import { useAppCounts } from '../lib/useAppCounts'
import { integrityFault } from '../lib/integrityPulse'
import { settingsTarget } from '../lib/navigation'

export default function StatusBar(): JSX.Element {
  // Mounted under Settings too, so it reprints the last-event time when the
  // display zone changes there (spec 038).
  useDisplayZone()
  const { eventCount, loggedCount, scopeViolations, scopeConfigured, scopeUnknown } = useAppCounts()
  const [ipStatus, setIpStatus] = useState<IPStatus | null>(null)
  const [uptime, setUptime] = useState(0)
  // The counter runs from the project's creation (audit P1 #33), which a bare
  // number next to REC does not say — it reads as this session's recording time.
  const [since, setSince] = useState<number | null>(null)
  const [recording, setRecording] = useState(true)
  const [pausedAt, setPausedAt] = useState<number | null>(null)
  const [pauseElapsed, setPauseElapsed] = useState(0)
  const [overlayVisible, setOverlayVisible] = useState(true)
  const [captureVerdict, setCaptureVerdict] = useState<'healthy' | 'partial' | 'dark' | null>(null)
  const [lastEventAt, setLastEventAt] = useState<number | null>(null)
  const { t } = useI18n()
  const issues = useIssues()

  useEffect(() => {
    // Uptime is engagement-scoped: how long since the project was created,
    // NOT how long since this window opened. Audit finding P1 #33 — closing
    // and reopening the app used to reset the counter mid-engagement.
    // Falls back to now() if project.active() hasn't resolved yet; the very
    // first render can be off by a second, subsequent poll ticks correct.
    let start = Date.now()
    window.redlog.project.active().then((p) => {
      if (p?.createdAt) { start = p.createdAt; setSince(p.createdAt) }
    })
    window.redlog.ip.getStatus().then(setIpStatus)
    window.redlog.recording.get().then((r) => {
      setRecording(r)
      if (!r) setPausedAt(Date.now())
    })

    const unsubIp = window.redlog.ip.onStatus(setIpStatus)
    const unsubRec = window.redlog.recording.onChange((r) => {
      setRecording(r)
      if (!r) setPausedAt(Date.now())
      else { setPausedAt(null); setPauseElapsed(0) }
    })
    window.redlog.overlay.isVisible().then(setOverlayVisible)
    const unsubOverlay = window.redlog.overlay.onVisibilityChanged(setOverlayVisible)
    const timer = setInterval(() => setUptime(Math.floor((Date.now() - start) / 1000)), 1000)

    // Capture health polls — surfaces the "recording indicator says ON but
    // capture is broken" case (P1b from the v0.6.85 audit). Dashboard
    // has its own richer CaptureHealthCard; the StatusBar dot is the always-
    // visible indicator so operators on the Timeline view still see a change
    // from healthy → partial → dark.
    //
    // Fire a one-shot toast on healthy → partial/dark transitions
    // so operators get an active notification, not just a passive dot colour
    // change. Held in a ref (not state) so the previous verdict survives across
    // re-renders and we only toast on the transition itself.
    let prevVerdict: 'healthy' | 'partial' | 'dark' | null = null
    const loadCapture = (): void => {
      void window.redlog.capture.health().then((h) => {
          if (!h || typeof h !== 'object' || !('verdict' in h)) return
          const verdict = (h as { verdict: 'healthy' | 'partial' | 'dark' }).verdict
          const dbErr = (h as { lastDbError?: { source: string; message: string } }).lastDbError
          const evAt = (h as { lastEventAt?: number | null }).lastEventAt ?? null
          setCaptureVerdict(verdict)
          setLastEventAt(evAt)
          // A dark or partial pipeline is a *condition*, not an event, so it
          // goes to the issue store rather than firing a toast every poll
          // (§9). The one-shot toast on the healthy → not-healthy transition
          // stays: that transition is an event, and it is the moment the
          // operator needs to look up.
          if (verdict === 'healthy') {
            clearIssue('capture')
          } else {
            raiseIssue({
              id: 'capture',
              tier: 'attention',
              title: verdict === 'dark' ? t('statusBar.captureDark') : t('statusBar.capturePartial'),
              detail: dbErr ? `${dbErr.source}: ${dbErr.message.slice(0, 120)}` : t('issues.captureDetail'),
              view: 'dashboard'
            })
          }
          if (prevVerdict === 'healthy' && verdict !== 'healthy') {
            toast(
              verdict === 'dark' ? t('statusBar.captureDark') : t('statusBar.capturePartial'),
              { type: 'warning', why: t('issues.captureDetail'), detail: dbErr ? `${dbErr.source}: ${dbErr.message}` : undefined }
            )
          }
          prevVerdict = verdict
          // Same tick, and the sample state rides the payload this call
          // already fetched rather than costing a second round trip.
          loadIntegrity(!!(h as { lastSampleBroken?: unknown }).lastSampleBroken)
        }).catch(() => {})
    }
    // The chain gets the same tick. Until now it was checked only when the
    // operator pressed Verify in Settings ▸ Integrity or happened to look at
    // the dashboard tile, so a drifted chain or a dead anchor loop could run
    // the length of an engagement in silence — and unlike a capture outage,
    // which costs the events it drops, a chain fault costs the defensibility
    // of everything already written.
    //
    // Three cheap reads: two counts and the newest anchor row. The broken
    // sample comes off the health payload, which was already carrying it and
    // being ignored.
    const loadIntegrity = (sampleBroken: boolean): void => {
      void Promise.all([
        window.redlog.chain.length(),
        window.redlog.events.getCount('chained'),
        window.redlog.chain.anchors()
      ]).then(([chainLen, eventCount, anchors]) => {
        const newest = anchors[0]
        const fault = integrityFault({
          chainLen,
          eventCount,
          lastAnchor: newest ? { createdAt: newest.createdAt, status: newest.status } : null,
          sampleBroken
        })
        if (!fault) { clearIssue('integrity'); return }
        raiseIssue({
          id: 'integrity',
          tier: 'attention',
          title: t(`issues.integrity.${fault.kind}`, fault.vars),
          detail: t('issues.integrityDetail'),
          view: settingsTarget('integrity'),
          // A dead or failed anchor loop is answered by submitting again, and
          // that is one call. A drifted chain or a broken row is not answered
          // by anything from here — the walk is what says how bad it is, so
          // that is what the button offers.
          fix: fault.kind === 'anchor-failed' || fault.kind === 'anchor-stale' ? 'anchor-now' : 'verify-chain'
        })
      }).catch(() => { /* a failed probe must not clear a real fault */ })
    }

    loadCapture()
    const healthTimer = setInterval(loadCapture, 30_000)

    return () => { unsubIp(); unsubRec(); unsubOverlay(); clearInterval(timer); clearInterval(healthTimer) }
  }, [])

  useEffect(() => {
    if (pausedAt == null) return
    const tick = setInterval(() => setPauseElapsed(Math.floor((Date.now() - pausedAt) / 1000)), 1000)
    return () => clearInterval(tick)
  }, [pausedAt])

  const PAUSE_WARN_SECS = 300
  const pauseMins = Math.floor(pauseElapsed / 60)

  const handleToggleRecording = (): void => { void toggleRecordingWithFeedback(t) }

  const safety = ipStatus?.ipSafety ?? 'unknown'
  const safetyDot = safety === 'safe' ? 'bg-emerald-500' : safety === 'exposed' ? 'bg-redlog-danger' : 'bg-amber-500'
  const safetyLabel = safety === 'safe' ? t('statusBar.safeIp') : safety === 'exposed' ? t('statusBar.exposedIp') : t('statusBar.ipUnknown')

  const hours = Math.floor(uptime / 3600)
  const mins = Math.floor((uptime % 3600) / 60)
  const secs = uptime % 60
  const uptimeStr = hours > 0
    ? `${hours}:${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`
    : `${mins}:${String(secs).padStart(2, '0')}`

  const Sep = (): JSX.Element => <span className="text-redlog-text-faint select-none">|</span>

  const attention = issues.filter((i) => i.tier === 'attention')
  const pending = issues.filter((i) => i.tier === 'pending')

  return (
    <div className="h-8 bg-redlog-bg border-t border-redlog-border flex items-center px-3 gap-3 text-xs font-mono shrink-0 select-none">
      {/* §9: persistent faults pinned to the left, split by whether they
          affect the evidence. Attention cannot be dismissed — it clears when
          the condition clears and not before. */}
      {attention.length > 0 && (
        <button
          data-testid="status-bar-attention"
          onClick={() => { const v = attention[0]?.view; if (v) window.dispatchEvent(new CustomEvent('redlog:navigate', { detail: v })) }}
          title={attention.map((i) => `${i.title}${i.detail ? ` — ${i.detail}` : ''}`).join('\n')}
          className="flex items-center gap-1.5 px-1.5 py-0.5 rounded text-redlog-danger hover:bg-redlog-danger/10 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-redlog-danger/40"
        >
          <span className="w-1.5 h-1.5 rounded-full bg-redlog-danger animate-pulse-slow shrink-0" aria-hidden />
          {t('issues.attention', { count: attention.length })}
        </button>
      )}
      {pending.length > 0 && (
        <button
          data-testid="status-bar-pending"
          onClick={() => { const v = pending[0]?.view; if (v) window.dispatchEvent(new CustomEvent('redlog:navigate', { detail: v })) }}
          title={pending.map((i) => `${i.title}${i.detail ? ` — ${i.detail}` : ''}`).join('\n')}
          className="flex items-center gap-1.5 px-1.5 py-0.5 rounded text-redlog-text-dim hover:text-redlog-text focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-redlog-text-dim/40"
        >
          <span className="w-1.5 h-1.5 rounded-full bg-redlog-text-faint shrink-0" aria-hidden />
          {t('issues.pending', { count: pending.length })}
        </button>
      )}
      {issues.length > 0 && <Sep />}
      {(() => {
        // Recording OFF → grey. Recording ON + capture healthy (or unknown) → pulsing red.
        // Recording ON + capture partial → amber (a source is failing, or a
        // producer the operator is running has stopped delivering; quiet
        // sources have not meant anything since the state model lost `idle`).
        // Recording ON + capture dark → amber non-pulsing (nothing has fed events).
        const pauseWarn = !recording && pauseElapsed >= PAUSE_WARN_SECS
        const dotColor = !recording
          ? pauseWarn ? 'bg-amber-500 animate-pulse-slow' : 'bg-redlog-text-dim'
          : captureVerdict === 'dark'
            ? 'bg-amber-500'
            : captureVerdict === 'partial'
              ? 'bg-amber-500 animate-pulse-slow'
              : 'bg-red-500 animate-pulse-slow'
        const labelColor = !recording
          ? pauseWarn ? 'text-amber-400/80' : 'text-redlog-text-dim'
          : captureVerdict === 'dark' || captureVerdict === 'partial'
            ? 'text-amber-400/80'
            : 'text-red-400/80'
        const lastEventLine = lastEventAt
          ? t('statusBar.lastEvent', { time: formatTime(lastEventAt, { seconds: true }) })
          : recording ? t('statusBar.lastEventNever') : ''
        const tooltip = !recording
          ? t('statusBar.clickToResume')
          : captureVerdict === 'dark'
            ? `${t('statusBar.captureDark')}\n${lastEventLine}`
            : captureVerdict === 'partial'
              ? `${t('statusBar.capturePartial')}\n${lastEventLine}`
              : lastEventAt
                ? `${t('statusBar.clickToPause')}\n${lastEventLine}`
                : `${t('statusBar.captureWaiting')}\n${t('statusBar.lastEventNever')}`
        return (
          <button
            data-testid="status-bar-recording"
            data-recording={recording ? 'on' : 'off'}
            data-capture={captureVerdict ?? 'unknown'}
            onClick={handleToggleRecording}
            className="flex items-center gap-1.5 px-1.5 py-0.5 rounded hover:bg-white/[0.05] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-red-500/40 transition-colors"
            title={tooltip}
            aria-label={tooltip}
          >
            <span className={`w-1.5 h-1.5 rounded-full ${dotColor}`} />
            <span className={labelColor}>{
              !recording
                ? pauseWarn ? `${t('statusBar.paused')} ${pauseMins}m` : t('statusBar.paused')
              : captureVerdict === 'dark' || (recording && !lastEventAt) ? t('statusBar.captureWaiting')
              : t('statusBar.rec')
            }</span>
            <span
              className="text-redlog-text-dim tabular-nums"
              title={since ? t('statusBar.uptimeSince', { date: formatDateTime(since) }) : undefined}
              aria-label={since ? `${uptimeStr} — ${t('statusBar.uptimeSince', { date: formatDateTime(since) })}` : undefined}
              data-testid="statusbar-uptime"
            >{uptimeStr}</span>
          </button>
        )
      })()}

      <Sep />

      <div className="flex items-center gap-1.5">
        <span className={`w-1.5 h-1.5 rounded-full ${safetyDot}`} />
        <span className={safety === 'safe' ? 'text-emerald-400/80' : safety === 'exposed' ? 'text-red-400/80' : 'text-amber-400/80'}>
          {safetyLabel}
        </span>
        {ipStatus?.externalIP && (
          <span className="text-redlog-text-dim tabular-nums">{ipStatus.externalIP}</span>
        )}
      </div>

      <Sep />

      <div className="flex items-center gap-1.5">
        {scopeViolations > 0 ? (
          <>
            <span className="w-1.5 h-1.5 rounded-full bg-red-500" />
            <span className="text-red-400/80">{t('statusBar.scopeViolations', { count: scopeViolations })}</span>
          </>
        ) : scopeUnknown ? (
          <>
            <span className="w-1.5 h-1.5 rounded-full bg-amber-500" />
            <span className="text-amber-400/80">{t('statusBar.scopeUnknown')}</span>
          </>
        ) : scopeConfigured ? (
          <>
            <span className="w-1.5 h-1.5 rounded-full bg-emerald-500" />
            <span className="text-emerald-400/80">{t('statusBar.scopeOk')}</span>
          </>
        ) : (
          <>
            <span className="w-1.5 h-1.5 rounded-full bg-zinc-500" />
            <span className="text-redlog-text-dim">{t('statusBar.scopeNotConfigured')}</span>
          </>
        )}
      </div>

      {/* No loot count here. The Sidebar's 戰利品 item already carries it as a
       *  badge, next to the page it opens; a second copy on the status bar was
       *  the same number twice, and the one place it could not be clicked. */}

      <div className="ml-auto flex items-center gap-3">
        {/* One number: how much this project has recorded. The chained ·
         *  logged split used to be spelled out here, and it asked the operator
         *  to hold an audit concept they have no decision to make about —
         *  which tier a row landed in is the verifier's question, not theirs.
         *  The split is still available where it is actually acted on: the
         *  FilterBar's "Chained only" chip (spec 038) and the Dashboard.
         */}
        <span
          data-testid="statusbar-event-count"
          className="text-redlog-text-dim tabular-nums"
        >
          {t('statusBar.events', { count: eventCount + loggedCount })}
        </span>
        <button
          onClick={() => window.redlog.overlay.toggle()}
          className={`flex items-center gap-1.5 px-1.5 py-0.5 rounded hover:bg-white/[0.05] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-red-500/40 transition-colors ${overlayVisible ? 'text-emerald-400 hover:text-emerald-300' : 'text-redlog-text-dim hover:text-redlog-text'}`}
          title={t('statusBar.toggleOverlay')}
          aria-label={t('statusBar.toggleOverlay')}
        >
          <span className={`w-1.5 h-1.5 rounded-full ${overlayVisible ? 'bg-emerald-500' : 'border border-redlog-border'}`} />
          <span>{t('statusBar.overlay')}</span>
        </button>
      </div>
    </div>
  )
}
