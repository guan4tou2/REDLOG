import { useEffect, useState } from 'react'
import { ipBadge } from '../lib/ip-badge'
import { SEVERITY_CLASS, scopeSeverity as scopeSev, worstSeverity, type Severity } from '../lib/alertSeverity'
import { useI18n } from '../i18n'
import { toast } from './Toast'
import { ICON } from '../lib/icons'

export default function StatusBar(): JSX.Element {
  const [ipStatus, setIpStatus] = useState<IPStatus | null>(null)
  const [eventCount, setEventCount] = useState(0)
  const [lootCount, setLootCount] = useState(0)
  // G-C1: the severity of what happened, not just how much. `getViolationCount`
  // could only ever drive an on/off light.
  const [violations, setViolations] = useState<Array<{ reason: string; authority: string }>>([])
  const [uptime, setUptime] = useState(0)
  const [recording, setRecording] = useState(true)
  const [stamped, setStamped] = useState(false)
  const [overlayVisible, setOverlayVisible] = useState(true)
  const [captureVerdict, setCaptureVerdict] = useState<'healthy' | 'partial' | 'dark' | null>(null)
  const { t } = useI18n()

  useEffect(() => {
    // Uptime is engagement-scoped: how long since the project was created,
    // NOT how long since this window opened. Audit finding P1 #33 — closing
    // and reopening the app used to reset the counter mid-engagement.
    // Falls back to now() if project.active() hasn't resolved yet; the very
    // first render can be off by a second, subsequent poll ticks correct.
    let start = Date.now()
    window.redlog.project.active().then((p) => {
      if (p?.createdAt) start = p.createdAt
    })
    window.redlog.ip.getStatus().then(setIpStatus)
    window.redlog.events.getCount().then(setEventCount)
    window.redlog.loot.getCount().then(setLootCount)
    window.redlog.scope.getViolations().then(setViolations)
    window.redlog.recording.get().then(setRecording)

    const unsubIp = window.redlog.ip.onStatus(setIpStatus)
    const unsubEvent = window.redlog.events.onNew(() => {
      setEventCount((c) => c + 1)
      window.redlog.loot.getCount().then(setLootCount)
      window.redlog.scope.getViolations().then(setViolations)
    })
    const unsubRec = window.redlog.recording.onChange(setRecording)
    window.redlog.overlay.isVisible().then(setOverlayVisible)
    const unsubOverlay = window.redlog.overlay.onVisibilityChanged(setOverlayVisible)
    const timer = setInterval(() => setUptime(Math.floor((Date.now() - start) / 1000)), 1000)

    // Capture health polls — surfaces the "recording indicator says ON but no
    // source is producing events" case (P1b from the v0.6.85 audit). Dashboard
    // has its own richer CaptureHealthCard; the StatusBar dot is the always-
    // visible indicator so operators on the Timeline view still see a change
    // from healthy → partial → dark.
    //
    // v0.6.86: also fire a one-shot toast on healthy → partial/dark transitions
    // so operators get an active notification, not just a passive dot colour
    // change. Held in a ref (not state) so the previous verdict survives across
    // re-renders and we only toast on the transition itself.
    let prevVerdict: 'healthy' | 'partial' | 'dark' | null = null
    const loadCapture = (): void => {
      try {
        window.redlog.capture?.health?.()?.then((h) => {
          if (!h || typeof h !== 'object' || !('verdict' in h)) return
          const verdict = (h as { verdict: 'healthy' | 'partial' | 'dark' }).verdict
          const dbErr = (h as { lastDbError?: { source: string; message: string } }).lastDbError
          setCaptureVerdict(verdict)
          if (prevVerdict === 'healthy' && verdict !== 'healthy') {
            const detail = dbErr ? `${dbErr.source}: ${dbErr.message.slice(0, 80)}` : ''
            toast(
              verdict === 'dark' ? `${t('statusBar.captureDark')}${detail ? ` — ${detail}` : ''}` : t('statusBar.capturePartial'),
              'warning'
            )
          }
          prevVerdict = verdict
        }).catch(() => {})
      } catch { /* older preload */ }
    }
    loadCapture()
    const healthTimer = setInterval(loadCapture, 30_000)

    return () => { unsubIp(); unsubEvent(); unsubRec(); unsubOverlay(); clearInterval(timer); clearInterval(healthTimer) }
  }, [])

  const handleToggleRecording = async (): Promise<void> => {
    const newState = await window.redlog.recording.toggle()
    toast(newState ? t('toast.recordingResumed') : t('toast.recordingPaused'), newState ? 'success' : 'warning')
  }

  // G-A3: the verdict, plus whether it is still backed by a current reading.
  // `qualified` means the badge must not read at full confidence.
  const badge = ipBadge(ipStatus)
  const scopeViolations = violations.length
  const scopeSeverity: Severity = worstSeverity(
    violations.map((v) => scopeSev(v.reason as 'excluded_target' | 'adjacent_subnet' | 'adjacent_domain' | 'unrelated'))
  )
  // Hollow only when EVERY violation present is an inference — one observed
  // rule match among them and the dot must assert.
  const scopeInferredOnly = scopeViolations > 0 && violations.every((v) => v.authority === 'inferred')

  const LABEL = { safe: t('statusBar.safeIp'), presumed_safe: t('statusBar.safeIp'), off_profile: t('statusBar.offProfileIp'), exposed: t('statusBar.exposedIp'), unknown: t('statusBar.ipUnknown') }
  const sev = SEVERITY_CLASS[badge.severity]
  const safetyDot = sev.dot
  const safetyLabel = badge.reason === 'stale' ? t('statusBar.ipStale') : LABEL[ipStatus?.ipSafety ?? 'unknown']
  const safetyTitle = badge.reason === 'stale'
    ? t('statusBar.staleHint', { n: ipStatus?.consecutiveFailures ?? 0 })
    : badge.reason === 'settling' ? t('statusBar.settlingHint')
      : badge.reason === 'presumed' ? t('statusBar.presumedHint')
        : ipStatus?.ipSafety === 'off_profile' ? t('statusBar.offProfileHint') : undefined

  const hours = Math.floor(uptime / 3600)
  const mins = Math.floor((uptime % 3600) / 60)
  const secs = uptime % 60
  const uptimeStr = hours > 0
    ? `${hours}:${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`
    : `${mins}:${String(secs).padStart(2, '0')}`

  const Sep = (): JSX.Element => <span className="text-zinc-800 select-none">|</span>

  return (
    <div className="h-7 bg-zinc-950 border-t border-redlog-border flex items-center px-3 gap-3 text-[11px] font-mono shrink-0 select-none">
      {(() => {
        // Recording OFF → grey. Recording ON + capture healthy (or unknown) → pulsing red.
        // Recording ON + capture partial → amber (some sources active, some idle).
        // Recording ON + capture dark → amber non-pulsing (nothing has fed events).
        const dotColor = !recording
          ? 'bg-zinc-500'
          : captureVerdict === 'dark'
            ? 'bg-amber-500'
            : captureVerdict === 'partial'
              ? 'bg-amber-500 animate-pulse-slow'
              : 'bg-red-500 animate-pulse-slow'
        const labelColor = !recording
          ? 'text-zinc-500'
          : captureVerdict === 'dark' || captureVerdict === 'partial'
            ? 'text-amber-400/80'
            : 'text-red-400/80'
        const tooltip = !recording
          ? t('statusBar.clickToResume')
          : captureVerdict === 'dark'
            ? t('statusBar.captureDark')
            : captureVerdict === 'partial'
              ? t('statusBar.capturePartial')
              : t('statusBar.clickToPause')
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
            <span className={labelColor}>{recording ? t('statusBar.rec') : t('statusBar.paused')}</span>
            <span className="text-zinc-600 tabular-nums">{uptimeStr}</span>
          </button>
        )
      })()}

      <Sep />

      <div className="flex items-center gap-1.5" title={safetyTitle}>
        {/* Hollow dot when the reading behind the verdict is not current — a
            filled dot is reserved for "this is what we see right now". */}
        <span
          className={badge.qualified
            ? `w-1.5 h-1.5 rounded-full border ${safetyDot.replace('bg-', 'border-')} animate-pulse-slow`
            : `w-1.5 h-1.5 rounded-full ${safetyDot}`}
        />
        <span className={`${sev.text}${badge.qualified ? ' opacity-70' : ''}`}>
          {safetyLabel}
        </span>
        {ipStatus?.externalIP && (
          <span className="text-zinc-600 tabular-nums">{ipStatus.externalIP}</span>
        )}
      </div>

      <Sep />

      <div className="flex items-center gap-1.5">
        {scopeViolations > 0 ? (() => {
          // G-C1: this used to be `count > 0 ? red : green`, so a proximity
          // near-miss shouted exactly as loudly as touching a forbidden host.
          // Worst-wins, and the dot is hollow when every violation present is
          // an inference (§3) — a solid dot asserts.
          const s = SEVERITY_CLASS[scopeSeverity]
          return (
            <>
              <span className={scopeInferredOnly ? `w-1.5 h-1.5 rounded-full border ${s.border}` : `w-1.5 h-1.5 rounded-full ${s.dot}`} />
              <span className={`${s.text}${scopeInferredOnly ? ' opacity-70' : ''}`}>{t('statusBar.scopeViolations', { count: scopeViolations })}</span>
            </>
          )
        })() : (
          <>
            <span className={`w-1.5 h-1.5 rounded-full ${SEVERITY_CLASS.ok.dot}`} />
            <span className={SEVERITY_CLASS.ok.text}>{t('statusBar.scopeOk')}</span>
          </>
        )}
      </div>

      <Sep />

      <div className="flex items-center gap-1.5">
        <span className={lootCount > 0 ? 'text-amber-400/80' : 'text-zinc-600'}>{ICON.loot}</span>
        <span className={lootCount > 0 ? 'text-amber-400/80' : 'text-zinc-600'}>
          {t('statusBar.loot', { count: lootCount })}
        </span>
      </div>

      <div className="ml-auto flex items-center gap-3">
        <span className="text-zinc-600 tabular-nums">{t('statusBar.events', { count: eventCount })}</span>
        <button
          onClick={async () => {
            const ts = new Date().toLocaleTimeString()
            await window.redlog.quickmarks.create({ title: `Timestamp ${ts}` })
            setStamped(true)
            setTimeout(() => setStamped(false), 1500)
          }}
          className={`flex items-center gap-1 transition-colors ${stamped ? 'text-emerald-400' : 'text-zinc-500 hover:text-red-400'}`}
          title={t('statusBar.timestampTitle')}
        >
          <span>{stamped ? '✓' : '⏱'}</span>
          <span>{stamped ? t('statusBar.stamped') : t('statusBar.stamp')}</span>
        </button>
        <button
          onClick={() => window.redlog.overlay.toggle()}
          className={`flex items-center gap-1.5 px-1.5 py-0.5 rounded hover:bg-white/[0.05] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-red-500/40 transition-colors ${overlayVisible ? 'text-emerald-400 hover:text-emerald-300' : 'text-zinc-500 hover:text-zinc-300'}`}
          title={t('statusBar.toggleOverlay')}
          aria-label={t('statusBar.toggleOverlay')}
        >
          <span className={`w-1.5 h-1.5 rounded-full ${overlayVisible ? 'bg-emerald-500' : 'border border-zinc-600'}`} />
          <span>{t('statusBar.overlay')}</span>
        </button>
      </div>
    </div>
  )
}
