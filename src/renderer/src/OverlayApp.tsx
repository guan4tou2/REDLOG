import { useEffect, useState, useRef } from 'react'
import { useI18n } from './i18n'

interface ActivePivot { via: string; tool: string; route?: string; ts: number }

export default function OverlayApp(): JSX.Element {
  const [status, setStatus] = useState<IPStatus | null>(null)
  const [expanded, setExpanded] = useState(false)
  const [recording, setRecording] = useState(true)
  const [interactive, setInteractive] = useState(false)
  const [showMark, setShowMark] = useState(true)
  const [pivots, setPivots] = useState<ActivePivot[]>([])
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const { t } = useI18n()

  useEffect(() => {
    const cfg = window.redlog.config as { get?: () => Promise<unknown> } | undefined
    cfg?.get?.().then((c) => {
      const ov = (c as { overlay?: { showMarkButton?: boolean } } | null)?.overlay
      setShowMark(ov?.showMarkButton !== false)
    }).catch(() => {})
  }, [])

  useEffect(() => {
    const overlay = window.redlog.overlay as { onInteractive?: (cb: (v: boolean) => void) => () => void }
    if (overlay.onInteractive) return overlay.onInteractive(setInteractive)
  }, [])

  useEffect(() => {
    window.redlog.ip.getStatus().then(setStatus)
    return window.redlog.ip.onStatus(setStatus)
  }, [])

  useEffect(() => {
    window.redlog.recording.get().then(setRecording)
    return window.redlog.recording.onChange(setRecording)
  }, [])

  useEffect(() => {
    const pv = window.redlog.pivots as {
      getActive?: () => Promise<ActivePivot[]>
      onChange?: (cb: (p: ActivePivot[]) => void) => () => void
    } | undefined
    pv?.getActive?.().then(setPivots).catch(() => {})
    return pv?.onChange?.(setPivots)
  }, [])

  useEffect(() => {
    if (expanded) timerRef.current = setTimeout(() => collapse(), 8000)
    return () => { if (timerRef.current) clearTimeout(timerRef.current) }
  }, [expanded])

  const collapse = (): void => { setExpanded(false); window.redlog.overlay?.setExpanded(false) }
  const toggleExpand = (): void => {
    const next = !expanded
    setExpanded(next)
    window.redlog.overlay?.setExpanded(next)
  }

  const safety = status?.ipSafety ?? 'unknown'
  // State drives ONLY the accent dot/label + a thin left rail — the chrome
  // itself stays neutral so the widget reads as a clean instrument, not a
  // full-box colour warning.
  const ACCENT = { safe: '#22c55e', exposed: '#ef4444', unknown: '#eab308' }[safety]
  const LABEL = { safe: t('overlay.safeIp'), exposed: t('overlay.exposedIp'), unknown: t('overlay.ipUnknown') }[safety]
  const STATUS_TXT = { safe: t('overlay.safeIpStatus'), exposed: t('overlay.exposedIpStatus'), unknown: t('overlay.unknownIp') }[safety]

  const PIVOT = '#38bdf8'
  const MUTED = '#71717a'
  const LABELC = '#9aa0a6'
  const VALUE = '#ededf0'
  const noDrag = { WebkitAppRegion: 'no-drag' } as React.CSSProperties

  const iconBtn: React.CSSProperties = {
    color: '#8b8b93', fontSize: 10, cursor: 'pointer',
    width: 20, height: 20, borderRadius: 6,
    background: interactive ? 'rgba(255,255,255,0.06)' : 'transparent',
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    transition: 'background 0.12s, color 0.12s'
  }
  const sep = <span style={{ width: 1, height: 15, background: 'rgba(255,255,255,0.09)', flexShrink: 0 }} />
  const latestPivot = pivots[0]

  return (
    <div
      style={{ width: '100%', height: '100%', padding: 3, WebkitAppRegion: 'drag', cursor: interactive ? 'grab' : 'default' } as React.CSSProperties}
    >
      <div
        style={{
          display: 'flex',
          background: 'rgba(17,17,20,0.86)',
          border: `1px solid rgba(255,255,255,${interactive ? 0.16 : 0.08})`,
          borderRadius: 11,
          backdropFilter: 'blur(20px) saturate(1.4)',
          boxShadow: '0 6px 22px rgba(0,0,0,0.40)',
          overflow: 'hidden', height: '100%', userSelect: 'none',
          fontFamily: 'ui-monospace, SFMono-Regular, "SF Mono", Menlo, monospace',
          opacity: interactive ? 1 : 0.92,
          transition: 'opacity 0.15s, border-color 0.15s'
        }}
      >
        {/* thin state rail */}
        <div style={{ width: 3, flexShrink: 0, background: ACCENT, opacity: 0.85 }} />

        <div style={{ position: 'relative', flex: 1, minWidth: 0 }}>
          {/* buttons */}
          <div style={{ position: 'absolute', top: 5, right: 6, zIndex: 10, display: 'flex', alignItems: 'center', gap: 2, ...noDrag }}>
            <div onClick={toggleExpand} style={iconBtn} title={expanded ? t('overlay.collapse') : t('overlay.expand')}>{expanded ? '▴' : '▾'}</div>
            <div onClick={() => window.redlog.overlay?.hide()} style={iconBtn} title={t('overlay.hide')}>✕</div>
          </div>

          {/* compact bar */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 7, padding: '0 52px 0 12px', height: 40, fontSize: 12, overflow: 'hidden' }}>
            <span style={{ display: 'flex', alignItems: 'center', gap: 5, flexShrink: 0 }}>
              <span style={{ width: 7, height: 7, borderRadius: '50%', background: recording ? '#ef4444' : '#52525b', boxShadow: recording ? '0 0 6px #ef4444' : 'none', animation: recording ? 'blinkRec 1.1s step-end infinite' : undefined }} />
              <span style={{ fontSize: 9, fontWeight: 700, letterSpacing: '0.08em', color: recording ? '#f87171' : '#71717a' }}>{recording ? t('overlay.rec') : t('overlay.paused')}</span>
            </span>

            {sep}

            <span style={{ width: 7, height: 7, borderRadius: '50%', background: ACCENT, boxShadow: `0 0 6px ${ACCENT}`, animation: safety === 'exposed' ? 'pulse 1.5s infinite' : undefined, flexShrink: 0 }} />
            <span style={{ color: ACCENT, fontWeight: 700, fontSize: 10.5, letterSpacing: '0.04em', flexShrink: 0 }}>{status ? LABEL : '…'}</span>

            <span style={{ display: 'flex', alignItems: 'baseline', gap: 4, minWidth: 0, flexShrink: 1 }}>
              <span style={{ color: MUTED, fontSize: 9, flexShrink: 0 }}>{t('overlay.ext')}</span>
              <span style={{ color: VALUE, fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{status?.externalIP ?? '—'}</span>
            </span>
            <span style={{ display: 'flex', alignItems: 'baseline', gap: 4, minWidth: 0, flexShrink: 1 }}>
              <span style={{ color: MUTED, fontSize: 9, flexShrink: 0 }}>{t('overlay.int')}</span>
              <span style={{ color: '#b8bcc2', fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{status?.internalIP ?? '—'}</span>
            </span>

            {latestPivot && (
              <span
                style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 4, flexShrink: 0, padding: '2px 7px', borderRadius: 999, background: 'rgba(56,189,248,0.12)', border: '1px solid rgba(56,189,248,0.28)' }}
                title={pivots.map((p) => `${p.tool} → ${p.via}${p.route ? ` (${p.route})` : ''}`).join('\n')}
              >
                <span style={{ color: PIVOT, fontSize: 10 }}>⇄</span>
                <span style={{ color: '#bae6fd', fontSize: 10, fontWeight: 600, maxWidth: 84, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{latestPivot.via}</span>
                {pivots.length > 1 && <span style={{ color: PIVOT, fontSize: 9, fontWeight: 700 }}>+{pivots.length - 1}</span>}
              </span>
            )}
          </div>

          {/* expanded */}
          {expanded && (
            <div style={{ padding: '0 12px 10px', fontSize: 11 }}>
              <div style={{ height: 1, background: 'rgba(255,255,255,0.06)', margin: '0 0 7px' }} />
              <div style={{ display: 'grid', gridTemplateColumns: '68px 1fr', rowGap: 4, alignItems: 'baseline' }}>
                <span style={{ color: LABELC }}>{t('overlay.status')}</span>
                <span style={{ color: ACCENT, fontWeight: 600 }}>{STATUS_TXT}</span>
                <span style={{ color: LABELC }}>{t('overlay.external')}</span>
                <span style={{ color: VALUE }}>{status?.externalIP ?? '—'}</span>
                <span style={{ color: LABELC }}>{t('overlay.internal')}</span>
                <span style={{ color: VALUE }}>{status?.internalIP ?? '—'}</span>
                <span style={{ color: LABELC }}>{t('overlay.lastCheck')}</span>
                <span style={{ color: '#9aa0a6' }}>{status?.lastCheck ? new Date(status.lastCheck).toLocaleTimeString() : '—'}</span>
              </div>

              {pivots.length > 0 && (() => {
                // External → pivot hop(s) → internal, as a left-to-right chain.
                // Oldest pivot sits closest to the external edge; the deepest
                // route (or internal IP) is the internal endpoint.
                const chain = [...pivots].sort((a, b) => a.ts - b.ts)
                const deepest = [...chain].reverse().find((p) => p.route)?.route ?? status?.internalIP ?? t('overlay.internalNet')
                const arrow = <span style={{ color: 'rgba(56,189,248,0.55)', fontSize: 11, flexShrink: 0 }}>→</span>
                const endPill = (color: string, bg: string, brd: string, top: string, sub?: string): JSX.Element => (
                  <span style={{ display: 'inline-flex', flexDirection: 'column', alignItems: 'flex-start', padding: '3px 8px', borderRadius: 7, background: bg, border: `1px solid ${brd}`, flexShrink: 0, maxWidth: 150 }}>
                    <span style={{ color, fontSize: 10, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 134 }}>{top}</span>
                    {sub && <span style={{ color: MUTED, fontSize: 8, letterSpacing: '0.04em' }}>{sub}</span>}
                  </span>
                )
                return (
                  <>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6, margin: '9px 0 6px' }}>
                      <span style={{ color: PIVOT, fontSize: 10 }}>⇄</span>
                      <span style={{ color: '#7dd3fc', fontSize: 8.5, fontWeight: 700, letterSpacing: '0.09em' }}>{t('overlay.topology').toUpperCase()}</span>
                      <span style={{ flex: 1, height: 1, background: 'rgba(56,189,248,0.16)' }} />
                    </div>
                    <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 5, rowGap: 6 }}>
                      {endPill('#d4d4d8', 'rgba(255,255,255,0.05)', 'rgba(255,255,255,0.12)', status?.externalIP ?? '—', t('overlay.external'))}
                      {chain.map((p) => (
                        <span key={p.via + p.ts} style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                          {arrow}
                          {endPill('#bae6fd', 'rgba(56,189,248,0.12)', 'rgba(56,189,248,0.30)', p.via, p.tool)}
                        </span>
                      ))}
                      {arrow}
                      {endPill('#86efac', 'rgba(34,197,94,0.12)', 'rgba(34,197,94,0.30)', deepest, t('overlay.internalNet'))}
                    </div>
                  </>
                )
              })()}

              {status?.error && <p style={{ color: '#f87171', marginTop: 6, fontSize: 10 }}>{status.error}</p>}

              {showMark && (
                <button
                  onClick={() => window.redlog.overlay?.quickMark()}
                  style={{ ...noDrag, marginTop: 9, width: '100%', padding: '6px 0', fontSize: 10, fontWeight: 600, letterSpacing: '0.06em', color: '#d4d4d8', background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.10)', borderRadius: 7, cursor: 'pointer', fontFamily: 'inherit', transition: 'background 0.12s, border-color 0.12s' }}
                  onMouseEnter={(e) => { e.currentTarget.style.background = 'rgba(239,68,68,0.16)'; e.currentTarget.style.borderColor = 'rgba(239,68,68,0.35)'; e.currentTarget.style.color = '#fca5a5' }}
                  onMouseLeave={(e) => { e.currentTarget.style.background = 'rgba(255,255,255,0.05)'; e.currentTarget.style.borderColor = 'rgba(255,255,255,0.10)'; e.currentTarget.style.color = '#d4d4d8' }}
                  title="⌘⇧M"
                >
                  ⚑ {t('overlay.mark')}
                </button>
              )}
            </div>
          )}
        </div>

        <style>{`
          @keyframes pulse { 0%,100% { opacity: 1; } 50% { opacity: 0.4; } }
          @keyframes blinkRec { 0%,100% { opacity: 1; } 50% { opacity: 0; } }
        `}</style>
      </div>
    </div>
  )
}
