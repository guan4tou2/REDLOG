import { useEffect, useState } from 'react'
import { useI18n } from '../i18n'
import { toast, toastUndo } from './Toast'
import { Gem } from 'lucide-react'
import { useIssues, raiseIssue, clearIssue } from '../lib/issues'
import { appShortcuts } from '../lib/shortcuts'

// The ⌘. chord, drawn the way this platform writes it. Read from the one
// shortcut table so the toast cannot drift from the binding (§11).
const isMacPlatform = (window as { redlog?: { platform?: string } }).redlog?.platform !== 'win32'
const recordingChord =
  appShortcuts([], isMacPlatform).find((r) => r.id === 'app:toggleRecording')?.keys ?? ''

export default function StatusBar(): JSX.Element {
  const [ipStatus, setIpStatus] = useState<IPStatus | null>(null)
  const [eventCount, setEventCount] = useState(0)
  const [loggedCount, setLoggedCount] = useState(0)
  const [lootCount, setLootCount] = useState(0)
  const [scopeViolations, setScopeViolations] = useState(0)
  const [uptime, setUptime] = useState(0)
  const [recording, setRecording] = useState(true)
  const [overlayVisible, setOverlayVisible] = useState(true)
  const [captureVerdict, setCaptureVerdict] = useState<'healthy' | 'partial' | 'dark' | null>(null)
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
      if (p?.createdAt) start = p.createdAt
    })
    window.redlog.ip.getStatus().then(setIpStatus)
    window.redlog.events.getCount().then(setEventCount)
    // v0.13.0: also fetch the logged-tier count for the chained·logged
    // split. Legacy .getCount() returns chained (audit) — every existing
    // caller means that.
    window.redlog.events.getCount('logged').then(setLoggedCount)
    window.redlog.loot.getCount().then(setLootCount)
    window.redlog.scope.getViolationCount().then(setScopeViolations)
    window.redlog.recording.get().then(setRecording)

    const unsubIp = window.redlog.ip.onStatus(setIpStatus)
    const unsubEvent = window.redlog.events.onNew((event) => {
      // v0.13.0: the tier flag on the incoming event tells us which
      // counter to bump; unknown-tier (legacy events) default to chained
      // via rowToEvent's default. Loot / scope counts refetch either way.
      const tier = (event as { tier?: import('../../../core/db/events').EventTier } | undefined)?.tier
      if (tier === 'logged') setLoggedCount((c) => c + 1)
      else setEventCount((c) => c + 1)
      window.redlog.loot.getCount().then(setLootCount)
      window.redlog.scope.getViolationCount().then(setScopeViolations)
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
        }).catch(() => {})
      } catch { /* older preload */ }
    }
    loadCapture()
    const healthTimer = setInterval(loadCapture, 30_000)

    return () => { unsubIp(); unsubEvent(); unsubRec(); unsubOverlay(); clearInterval(timer); clearInterval(healthTimer) }
  }, [])

  const handleToggleRecording = async (): Promise<void> => {
    const newState = await window.redlog.recording.toggle()
    // Takes effect now — a pause that waited eight seconds would keep
    // recording exactly the thing the operator paused for. The undo is a
    // second toggle, which is why this is `toastUndo` and not
    // `toastDeferred` (§10).
    toastUndo(
      newState ? t('toast.recordingResumed') : t('toast.recordingPaused'),
      () => { void window.redlog.recording.toggle() },
      {
        type: newState ? 'success' : 'warning',
        why: newState ? undefined : t('toast.recordingPausedWhy'),
        // Name the action rather than saying "undo", and carry the chord —
        // pausing is the one toast an operator wants to reverse without
        // reaching for the mouse. The chord comes from the shortcut table so
        // it stays right on both platforms.
        ...(newState ? {} : {
          action: {
            label: `${t('statusBar.resumeRecording')}  ${recordingChord}`,
            onClick: () => { void window.redlog.recording.toggle() }
          }
        })
      }
    )
  }

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
        // Recording ON + capture partial → amber (some sources active, some idle).
        // Recording ON + capture dark → amber non-pulsing (nothing has fed events).
        const dotColor = !recording
          ? 'bg-redlog-text-dim'
          : captureVerdict === 'dark'
            ? 'bg-amber-500'
            : captureVerdict === 'partial'
              ? 'bg-amber-500 animate-pulse-slow'
              : 'bg-red-500 animate-pulse-slow'
        const labelColor = !recording
          ? 'text-redlog-text-dim'
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
            <span className="text-redlog-text-dim tabular-nums">{uptimeStr}</span>
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
        ) : (
          <>
            <span className="w-1.5 h-1.5 rounded-full bg-emerald-500" />
            <span className="text-emerald-400/80">{t('statusBar.scopeOk')}</span>
          </>
        )}
      </div>

      <Sep />

      <div className="flex items-center gap-1.5">
        <Gem size={13} strokeWidth={1.5} aria-hidden className={lootCount > 0 ? 'text-amber-400/80' : 'text-redlog-text-dim'} />
        <span className={lootCount > 0 ? 'text-amber-400/80' : 'text-redlog-text-dim'}>
          {t('statusBar.loot', { count: lootCount })}
        </span>
      </div>

      <div className="ml-auto flex items-center gap-3">
        {/* v0.13.0: chained · logged split. Chained (audit-tier) reads
         *  brighter — that's the count anchors + verifier care about.
         *  Logged renders one tier dimmer (redlog-text-dim against the chained
         *  count's redlog-text-dim) to signal "footprint, not evidence".
         *  Both tiers clear 4.5:1 on the bar's surface — these are numbers
         *  an auditor reads, so neither may sink into decoration. They used
         *  to render at 2.6:1 and 1.9:1. Hidden entirely when logged is zero, so pre-v0.13
         *  projects still show the single-number shape they always had.
         *  Title tooltip explains the two-tier story for auditors
         *  hovering to figure out what the second number is.
         *
         *  v0.14 §9.4: when the logged tier is non-zero, the counter is
         *  clickable and dispatches `redlog:auditor-view:toggle` — the
         *  Timeline picks it up and flips its auditor-view chip. When
         *  the logged tier is empty there is nothing to hide, so the
         *  counter stays a plain span. If the user is not on the
         *  Timeline the event is a no-op; the tooltip warns of that so
         *  a click from Dashboard isn't a silent surprise.
         */}
        {loggedCount > 0 ? (
          <button
            type="button"
            data-testid="statusbar-tier-count"
            onClick={() => window.dispatchEvent(new CustomEvent('redlog:auditor-view:toggle'))}
            className="text-redlog-text-dim tabular-nums cursor-pointer hover:text-redlog-text focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-emerald-500 rounded"
            title={t('statusBar.tierCountTitle', {
              chained: eventCount.toLocaleString(),
              logged: loggedCount.toLocaleString()
            })}
            // §5.7: the tooltip must not be the only place this is said. The
            // two numbers are already visible and the accessible name spells
            // out which is which, so a screen reader and a keyboard user get
            // the split without hovering.
            aria-label={t('statusBar.tierCountLabel', {
              chained: eventCount.toLocaleString(),
              logged: loggedCount.toLocaleString()
            })}
          >
            {t('statusBar.events', { count: eventCount })}
            <span className="text-redlog-text-faint mx-1" aria-hidden>·</span>
            <span className="text-redlog-text-dim">{loggedCount.toLocaleString()}</span>
          </button>
        ) : (
          <span className="text-redlog-text-dim tabular-nums">
            {t('statusBar.events', { count: eventCount })}
          </span>
        )}
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
