import { useEffect, useRef, useState } from 'react'
import { useI18n } from '../i18n'
import { toast } from './Toast'
import { toggleRecordingWithFeedback } from '../lib/recordingToggle'
import { useIssues, raiseIssue, clearIssue } from '../lib/issues'
import { formatTime, formatDateTime, useDisplayZone } from '../lib/time'
import { useAppCounts } from '../lib/useAppCounts'
import { integrityFault } from '../lib/integrityPulse'
import { scopeIssue } from '../lib/scopeIssue'
import { settingsTarget } from '../lib/navigation'
import { useNarrowViewport } from '../hooks/useNarrowViewport'
import { useCaptureHealthState } from '../lib/useCaptureHealth'
import { captureUnknownLine } from '../lib/captureUnknown'

export default function StatusBar(): JSX.Element {
  // Narrow: one line, in this order of importance — the issue counters, whether
  // it is recording, whether the IP is safe, the scope. The event count, the IP
  // number and the overlay's label go first, and each stays reachable: the
  // count on the Dashboard, the IP in the tooltip, the overlay by its dot.
  const narrow = useNarrowViewport()
  // Mounted under Settings too, so it reprints the last-event time when the
  // display zone changes there (spec 038).
  useDisplayZone()
  const { eventCount, loggedCount, scopeObservations, scopeConfigured, scopeUnknown, loading: countsLoading } = useAppCounts()
  const [ipStatus, setIpStatus] = useState<IPStatus | null>(null)
  const [uptime, setUptime] = useState(0)
  // The counter runs from the project's creation (audit P1 #33), which a bare
  // number next to REC does not say — it reads as this session's recording time.
  const [since, setSince] = useState<number | null>(null)
  const [recording, setRecording] = useState(true)
  const [pausedAt, setPausedAt] = useState<number | null>(null)
  const [pauseElapsed, setPauseElapsed] = useState(0)
  const [overlayVisible, setOverlayVisible] = useState(true)
  const { t } = useI18n()
  // 30 s: the bar is always mounted and only has to notice a change.
  const capture = useCaptureHealthState(30_000)
  const captureUnknown = capture.status === 'unknown'
  // Only a verdict that is current. After a failed read the last one is history
  // (captureUnknownLine names it) and must not colour the dot.
  const current = captureUnknown ? null : (capture.health as { verdict?: 'healthy' | 'partial' | 'dark'; lastEventAt?: number | null } | null)
  const captureVerdict = current?.verdict ?? null
  const lastEventAt = current?.lastEventAt ?? null
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

    return () => { unsubIp(); unsubRec(); unsubOverlay(); clearInterval(timer) }
  }, [])

  // Capture health — surfaces the "recording indicator says ON but capture is
  // broken" case (P1b from the v0.6.85 audit). Dashboard has its own richer
  // CaptureHealthCard; the StatusBar dot is the always-visible indicator so
  // operators on the Timeline view still see a change from healthy → partial
  // → dark.
  //
  // The snapshot is the store's, shared with every other reader. A failed read
  // is not a verdict: status goes 'unknown', the dot says so, and nothing below
  // runs — the issue is neither raised nor cleared and no toast fires, because
  // none of them can be decided from a read that did not happen.
  //
  // Fire a one-shot toast on healthy → partial/dark transitions so operators
  // get an active notification, not just a passive dot colour change. Held in a
  // ref (not state) so the previous verdict survives across re-renders and we
  // only toast on the transition itself.
  const prevVerdict = useRef<'healthy' | 'partial' | 'dark' | null>(null)
  useEffect(() => {
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

    if (capture.status !== 'ok') return
    const h = capture.health
    if (!h || typeof h !== 'object' || !('verdict' in h)) return
    const verdict = (h as { verdict: 'healthy' | 'partial' | 'dark' }).verdict
    const dbErr = (h as { lastDbError?: { source: string; message: string } }).lastDbError
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
    if (prevVerdict.current === 'healthy' && verdict !== 'healthy') {
      toast(
        verdict === 'dark' ? t('statusBar.captureDark') : t('statusBar.capturePartial'),
        { type: 'warning', why: t('issues.captureDetail'), detail: dbErr ? `${dbErr.source}: ${dbErr.message}` : undefined }
      )
    }
    prevVerdict.current = verdict
    // Same tick, and the sample state rides the payload this read already
    // fetched rather than costing a second round trip.
    loadIntegrity(!!(h as { lastSampleBroken?: unknown }).lastSampleBroken)
  }, [capture])

  // Scope as a condition, raised here because this is the component that is
  // always mounted — the dashboard's panel reads the store, it does not fill
  // it. The segment further down still prints the state, the way the
  // recording dot prints capture health while `capture` is also an issue: one
  // says what is true, the other says what to do about it.
  //
  // Not while the first read is in flight. `scopeConfigured` starts false, so
  // raising on it unconditionally would put a pending counter on screen at
  // every launch and take it away again a moment later.
  useEffect(() => {
    const s = scopeIssue({ loading: countsLoading, configured: scopeConfigured, unknown: scopeUnknown })
    if (!s) { clearIssue('scope'); return }
    raiseIssue({
      id: 'scope', tier: s.tier,
      title: t(s.titleKey), detail: t(s.detailKey),
      view: settingsTarget('scope'), fix: s.fix
    })
  }, [countsLoading, scopeConfigured, scopeUnknown, t])

  // An external-IP lookup that errored is a condition too, and a different one
  // from "the address is exposed": it says the answer is unknown, not bad. It
  // stands on its own — relay nodes and the local address do not depend on it.
  const ipError = ipStatus?.error
  useEffect(() => {
    if (!ipError) { clearIssue('ip'); return }
    raiseIssue({ id: 'ip', tier: 'pending', title: t('ip.lookupFailed'), detail: t('issues.ipLookupDetail'), view: settingsTarget('network') })
  }, [ipError, t])

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

  const Sep = (): JSX.Element | null => narrow ? null : <span className="text-redlog-text-faint select-none">|</span>

  const attention = issues.filter((i) => i.tier === 'attention')
  const pending = issues.filter((i) => i.tier === 'pending')

  return (
    <div
      data-testid="status-bar"
      data-narrow={narrow ? 'true' : 'false'}
      className={`h-7 bg-redlog-bg border-t border-redlog-border flex items-center px-3 text-xs font-mono shrink-0 select-none whitespace-nowrap overflow-hidden ${narrow ? 'gap-2' : 'gap-3'}`}
    >
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
          // Capture could not be read: neither the old colour nor a warning.
          : captureUnknown
            ? 'bg-redlog-text-faint'
          : captureVerdict === 'dark'
            ? 'bg-amber-500'
            : captureVerdict === 'partial'
              ? 'bg-amber-500 animate-pulse-slow'
              : 'bg-red-500 animate-pulse-slow'
        const labelColor = !recording
          ? pauseWarn ? 'text-amber-400/80' : 'text-redlog-text-dim'
          : captureUnknown
            ? 'text-redlog-text-dim'
          : captureVerdict === 'dark' || captureVerdict === 'partial'
            ? 'text-amber-400/80'
            : 'text-red-400/80'
        const lastEventLine = lastEventAt
          ? t('statusBar.lastEvent', { time: formatTime(lastEventAt, { seconds: true }) })
          : recording ? t('statusBar.lastEventNever') : ''
        const tooltip = !recording
          ? t('statusBar.clickToResume')
          : captureUnknown
            ? `${captureUnknownLine(t, capture.health, capture.lastOkAt)}\n${t('statusBar.clickToPause')}`
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
            className={`flex min-w-0 items-center gap-1.5 px-1.5 py-0.5 rounded hover:bg-white/[0.05] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-red-500/40 transition-colors ${narrow ? 'flex-1 overflow-hidden' : ''}`}
            title={tooltip}
            aria-label={tooltip}
          >
            <span className={`w-1.5 h-1.5 rounded-full ${dotColor}`} />
            <span className={`${labelColor} ${narrow ? 'min-w-0 truncate' : ''}`} title={tooltip}>{
              !recording
                ? pauseWarn ? `${t('statusBar.paused')} ${pauseMins}m` : t('statusBar.paused')
              : !captureUnknown && (captureVerdict === 'dark' || (recording && !lastEventAt)) ? t('statusBar.captureWaiting')
              : t('statusBar.rec')
            }</span>
            <span
              className="text-redlog-text-dim tabular-nums shrink-0"
              title={since ? t('statusBar.uptimeSince', { date: formatDateTime(since) }) : undefined}
              aria-label={since ? `${uptimeStr} — ${t('statusBar.uptimeSince', { date: formatDateTime(since) })}` : undefined}
              data-testid="statusbar-uptime"
            >{uptimeStr}</span>
          </button>
        )
      })()}

      <Sep />

      {/* Narrow: the dot and an accessible name, not the word. At 800×600 with
          the shell at 200% the bar is 400px wide and the three word labels
          pushed the HUD toggle past the right edge, where `overflow-hidden`
          made it unreachable — a control that exists and cannot be clicked.
          The words are still there for a screen reader, and in the title. */}
      <div className="flex items-center gap-1.5 shrink-0" title={ipStatus?.externalIP ? `${safetyLabel} ${ipStatus.externalIP}` : safetyLabel}>
        <span className={`w-1.5 h-1.5 rounded-full ${safetyDot}`} />
        <span aria-hidden={narrow || undefined} className={narrow ? 'sr-only' : (safety === 'safe' ? 'text-emerald-400/80' : safety === 'exposed' ? 'text-red-400/80' : 'text-amber-400/80')}>
          {safetyLabel}
        </span>
        {!narrow && ipStatus?.externalIP && (
          <span className="text-redlog-text-dim tabular-nums">{ipStatus.externalIP}</span>
        )}
        {narrow && <span className="sr-only">{ipStatus?.externalIP ?? ''}</span>}
      </div>

      <Sep />

      {/* Clickable like its fault-counter neighbours: an unfixed scope is a
          setup debt the chip can only point at, and the scope states share one
          destination — Settings ▸ 範圍規則, where the lists are edited.
          The 越界 count belongs here because the clash already happened; the
          tab it opens is where the allow/exclude lists live. */}
      <button
        type="button"
        data-testid="status-bar-scope"
        onClick={() => window.dispatchEvent(new CustomEvent('redlog:navigate', { detail: settingsTarget('scope') }))}
        title={t('statusBar.scopeOpen')}
        aria-label={t('statusBar.scopeOpen')}
        // min-w/min-h: at 800×600/150% the bar squeezes labels away and this
        // chip shrinks to the dot alone — 18×10, below the 24×24 floor. Same
        // floor as the HUD toggle beside it (e2e/ui-closeout hit-area check).
        className="flex items-center gap-1.5 shrink-0 min-w-6 min-h-6 px-1.5 py-0.5 rounded hover:bg-white/[0.05] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-redlog-text-dim/40 transition-colors"
      >
        {scopeObservations > 0 ? (
          <>
            <span className="w-1.5 h-1.5 rounded-full bg-red-500" />
            <span aria-hidden={narrow || undefined} className={narrow ? 'sr-only' : 'text-red-400/80'}>{t('statusBar.scopeObservations', { count: scopeObservations })}</span>
          </>
        ) : scopeUnknown ? (
          <>
            <span className="w-1.5 h-1.5 rounded-full bg-amber-500" />
            <span aria-hidden={narrow || undefined} className={narrow ? 'sr-only' : 'text-amber-400/80'}>{t('statusBar.scopeUnknown')}</span>
          </>
        ) : scopeConfigured ? (
          <>
            <span className="w-1.5 h-1.5 rounded-full bg-emerald-500" />
            <span aria-hidden={narrow || undefined} className={narrow ? 'sr-only' : 'text-emerald-400/80'}>{t('statusBar.scopeOk')}</span>
          </>
        ) : (
          <>
            <span className="w-1.5 h-1.5 rounded-full bg-zinc-500" />
            <span aria-hidden={narrow || undefined} className={narrow ? 'sr-only' : 'text-redlog-text-dim'}>{t('statusBar.scopeNotConfigured')}</span>
          </>
        )}
      </button>

      {/* No loot count here. The Sidebar's 戰利品 item already carries it as a
       *  badge, next to the page it opens; a second copy on the status bar was
       *  the same number twice, and the one place it could not be clicked. */}

      <div className="ml-auto flex items-center gap-3 shrink-0">
        {/* One number: how much this project has recorded. The chained ·
         *  logged split used to be spelled out here, and it asked the operator
         *  to hold an audit concept they have no decision to make about —
         *  which tier a row landed in is the verifier's question, not theirs.
         *  The split is still available where it is actually acted on: the
         *  FilterBar's "Chained only" chip (spec 038) and the Dashboard.
         *  Narrow: left to the Dashboard, to keep the line on one row.
         */}
        {!narrow && (
          <span
            data-testid="statusbar-event-count"
            className="text-redlog-text-dim tabular-nums"
          >
            {t('statusBar.events', { count: eventCount + loggedCount })}
          </span>
        )}
        <button
          data-testid="status-bar-overlay"
          onClick={() => window.redlog.overlay.toggle()}
          // Narrow, the label is gone and only the dot is left — which made
          // this the smallest target in the bar (18x10 at 150% zoom). The box
          // keeps a 24px floor either way; the dot stays 6px.
          className={`flex items-center justify-center gap-1.5 min-w-6 min-h-6 px-1.5 py-0.5 rounded hover:bg-white/[0.05] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-red-500/40 transition-colors ${overlayVisible ? 'text-emerald-400 hover:text-emerald-300' : 'text-redlog-text-dim hover:text-redlog-text'}`}
          title={t('statusBar.toggleOverlay')}
          aria-label={t('statusBar.toggleOverlay')}
        >
          <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${overlayVisible ? 'bg-emerald-500' : 'border border-redlog-border'}`} />
          {!narrow && <span>{t('statusBar.overlay')}</span>}
        </button>
      </div>
    </div>
  )
}
