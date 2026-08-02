import { useEffect, useState } from 'react'
import { useI18n } from '../i18n'
import { toast } from './Toast'

export default function StatusBar(): JSX.Element {
  const [ipStatus, setIpStatus] = useState<IPStatus | null>(null)
  const [eventCount, setEventCount] = useState(0)
  const [lootCount, setLootCount] = useState(0)
  const [scopeViolations, setScopeViolations] = useState(0)
  const [uptime, setUptime] = useState(0)
  const [recording, setRecording] = useState(true)
  const [stamped, setStamped] = useState(false)
  const [overlayVisible, setOverlayVisible] = useState(true)
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
    window.redlog.scope.getViolationCount().then(setScopeViolations)
    window.redlog.recording.get().then(setRecording)

    const unsubIp = window.redlog.ip.onStatus(setIpStatus)
    const unsubEvent = window.redlog.events.onNew(() => {
      setEventCount((c) => c + 1)
      window.redlog.loot.getCount().then(setLootCount)
      window.redlog.scope.getViolationCount().then(setScopeViolations)
    })
    const unsubRec = window.redlog.recording.onChange(setRecording)
    window.redlog.overlay.isVisible().then(setOverlayVisible)
    const unsubOverlay = window.redlog.overlay.onVisibilityChanged(setOverlayVisible)
    const timer = setInterval(() => setUptime(Math.floor((Date.now() - start) / 1000)), 1000)

    return () => { unsubIp(); unsubEvent(); unsubRec(); unsubOverlay(); clearInterval(timer) }
  }, [])

  const handleToggleRecording = async (): Promise<void> => {
    const newState = await window.redlog.recording.toggle()
    toast(newState ? t('toast.recordingResumed') : t('toast.recordingPaused'), newState ? 'success' : 'warning')
  }

  const safety = ipStatus?.ipSafety ?? 'unknown'
  const safetyDot = safety === 'safe' ? 'bg-emerald-500' : safety === 'exposed' ? 'bg-red-500' : 'bg-amber-500'
  const safetyLabel = safety === 'safe' ? t('statusBar.safeIp') : safety === 'exposed' ? t('statusBar.exposedIp') : t('statusBar.ipUnknown')

  const hours = Math.floor(uptime / 3600)
  const mins = Math.floor((uptime % 3600) / 60)
  const secs = uptime % 60
  const uptimeStr = hours > 0
    ? `${hours}:${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`
    : `${mins}:${String(secs).padStart(2, '0')}`

  const Sep = (): JSX.Element => <span className="text-zinc-800 select-none">|</span>

  return (
    <div className="h-7 bg-zinc-950 border-t border-redlog-border flex items-center px-3 gap-3 text-[11px] font-mono shrink-0 select-none">
      <button
        data-testid="status-bar-recording"
        data-recording={recording ? 'on' : 'off'}
        onClick={handleToggleRecording}
        className="flex items-center gap-1.5 px-1.5 py-0.5 rounded hover:bg-white/[0.05] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-red-500/40 transition-colors"
        title={recording ? t('statusBar.clickToPause') : t('statusBar.clickToResume')}
        aria-label={recording ? t('statusBar.clickToPause') : t('statusBar.clickToResume')}
      >
        <span className={`w-1.5 h-1.5 rounded-full ${recording ? 'bg-red-500 animate-pulse-slow' : 'bg-zinc-500'}`} />
        <span className={recording ? 'text-red-400/80' : 'text-zinc-500'}>{recording ? t('statusBar.rec') : t('statusBar.paused')}</span>
        <span className="text-zinc-600 tabular-nums">{uptimeStr}</span>
      </button>

      <Sep />

      <div className="flex items-center gap-1.5">
        <span className={`w-1.5 h-1.5 rounded-full ${safetyDot}`} />
        <span className={safety === 'safe' ? 'text-emerald-400/80' : safety === 'exposed' ? 'text-red-400/80' : 'text-amber-400/80'}>
          {safetyLabel}
        </span>
        {ipStatus?.externalIP && (
          <span className="text-zinc-600 tabular-nums">{ipStatus.externalIP}</span>
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
        <span className={lootCount > 0 ? 'text-amber-400/80' : 'text-zinc-600'}>◆</span>
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
