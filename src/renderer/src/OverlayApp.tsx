import { useEffect, useState, useRef } from 'react'
import { useI18n } from './i18n'
import { HUD, hexA, CHAMFER } from './lib/hud'

interface ActivePivot { via: string; tool: string; route?: string; ts: number }

// HUD palette — cyberpunk, but DESATURATED for dark-UI comfort (see lib/hud):
// cyan frame identity, calmer state accents, angular corner brackets that frame
// without enclosing (reads as an active scan), low-alpha glows.
const CYAN = HUD.cyan
const SKY = HUD.sky
const MUTED = HUD.muted
const VALUE = HUD.value

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
  const STATE = { safe: HUD.green, exposed: HUD.red, unknown: HUD.amber }[safety]
  const LABEL = { safe: t('overlay.safeIp'), exposed: t('overlay.exposedIp'), unknown: t('overlay.ipUnknown') }[safety]
  const STATUS_TXT = { safe: t('overlay.safeIpStatus'), exposed: t('overlay.exposedIpStatus'), unknown: t('overlay.unknownIp') }[safety]
  // exposure turns the whole frame into a red-alert scan; otherwise cyan HUD.
  const FRAME = safety === 'exposed' ? HUD.red : CYAN
  const noDrag = { WebkitAppRegion: 'no-drag' } as React.CSSProperties

  const bracket = (pos: React.CSSProperties): JSX.Element => (
    <span style={{ position: 'absolute', width: 9, height: 9, borderColor: FRAME, boxShadow: `0 0 4px ${FRAME}55`, pointerEvents: 'none', ...pos }} />
  )
  const iconBtn: React.CSSProperties = {
    color: CYAN, fontSize: 10, cursor: 'pointer', width: 18, height: 16,
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    background: interactive ? 'rgba(34,211,238,0.10)' : 'transparent',
    border: `1px solid ${interactive ? 'rgba(34,211,238,0.35)' : 'transparent'}`,
    transition: 'background 0.12s, border-color 0.12s'
  }
  const hair = <span style={{ width: 1, height: 13, background: 'rgba(34,211,238,0.25)', flexShrink: 0 }} />
  const latestPivot = pivots[0]
  const tick = (c: string): React.CSSProperties => ({ width: 6, height: 6, borderRadius: '50%', background: c, boxShadow: `0 0 7px ${c}, 0 0 3px ${c}`, flexShrink: 0 })

  return (
    <div
      style={{ width: '100%', height: '100%', padding: 3, WebkitAppRegion: 'drag', cursor: interactive ? 'grab' : 'default' } as React.CSSProperties}
    >
      {/* frame (neon edge) */}
      <div style={{ position: 'relative', height: '100%', clipPath: CHAMFER, background: FRAME, opacity: interactive ? 1 : 0.94, transition: 'background 0.2s, opacity 0.15s', boxShadow: `0 0 16px ${FRAME}44` }}>
        {/* panel (inset fill) */}
        <div
          style={{
            position: 'absolute', inset: 1, clipPath: CHAMFER,
            background: 'rgba(7,12,17,0.80)',
            backdropFilter: 'blur(16px) saturate(1.5)',
            overflow: 'hidden',
            fontFamily: 'ui-monospace, SFMono-Regular, "SF Mono", Menlo, monospace'
          }}
        >
          {/* scanlines */}
          <div style={{ position: 'absolute', inset: 0, pointerEvents: 'none', background: 'repeating-linear-gradient(0deg, rgba(34,211,238,0.035) 0px, rgba(34,211,238,0.035) 1px, transparent 1px, transparent 3px)', opacity: 0.6 }} />

          {/* buttons */}
          <div style={{ position: 'absolute', top: 5, right: 7, zIndex: 10, display: 'flex', alignItems: 'center', gap: 3, ...noDrag }}>
            <div onClick={toggleExpand} style={iconBtn} title={expanded ? t('overlay.collapse') : t('overlay.expand')}>{expanded ? '▲' : '▼'}</div>
            <div onClick={() => window.redlog.overlay?.hide()} style={iconBtn} title={t('overlay.hide')}>✕</div>
          </div>

          {/* compact bar */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '0 54px 0 14px', height: 40, fontSize: 12, position: 'relative', zIndex: 2, overflow: 'hidden' }}>
            <span style={{ display: 'flex', alignItems: 'center', gap: 5, flexShrink: 0 }}>
              <span style={{ ...tick(recording ? HUD.red : '#3a4a52'), animation: recording ? 'blinkRec 1.1s step-end infinite' : undefined }} />
              <span style={{ fontSize: 9, fontWeight: 700, letterSpacing: '0.14em', color: recording ? '#e39aa0' : '#4a5a62', textShadow: recording ? `0 0 7px ${hexA(HUD.red, 0.4)}` : 'none' }}>{recording ? t('overlay.rec') : t('overlay.paused')}</span>
            </span>
            {hair}
            <span style={{ ...tick(STATE), animation: safety === 'exposed' ? 'pulse 1.4s infinite' : undefined }} />
            <span style={{ color: STATE, fontWeight: 700, fontSize: 10.5, letterSpacing: '0.09em', textShadow: `0 0 8px ${STATE}55`, flexShrink: 0 }}>{status ? LABEL : '···'}</span>
            <span style={{ display: 'flex', alignItems: 'baseline', gap: 4, minWidth: 0, flexShrink: 1 }}>
              <span style={{ color: MUTED, fontSize: 8.5, letterSpacing: '0.1em', flexShrink: 0 }}>{t('overlay.ext')}</span>
              <span style={{ color: VALUE, fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{status?.externalIP ?? '—'}</span>
            </span>
            <span style={{ display: 'flex', alignItems: 'baseline', gap: 4, minWidth: 0, flexShrink: 1 }}>
              <span style={{ color: MUTED, fontSize: 8.5, letterSpacing: '0.1em', flexShrink: 0 }}>{t('overlay.int')}</span>
              <span style={{ color: '#9fd8e6', fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{status?.internalIP ?? '—'}</span>
            </span>
            {latestPivot && (
              <span
                style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 4, flexShrink: 0, padding: '2px 8px', clipPath: 'polygon(5px 0,100% 0,100% calc(100% - 5px),calc(100% - 5px) 100%,0 100%,0 5px)', background: hexA(CYAN, 0.12), border: `1px solid ${SKY}55` }}
                title={pivots.map((p) => `${p.tool} → ${p.via}${p.route ? ` (${p.route})` : ''}`).join('\n')}
              >
                <span style={{ color: CYAN, fontSize: 10, textShadow: `0 0 6px ${CYAN}` }}>⇄</span>
                <span style={{ color: '#bff2ff', fontSize: 10, fontWeight: 600, maxWidth: 80, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{latestPivot.via}</span>
                {pivots.length > 1 && <span style={{ color: CYAN, fontSize: 9, fontWeight: 700 }}>+{pivots.length - 1}</span>}
              </span>
            )}
          </div>

          {/* expanded */}
          {expanded && (
            <div style={{ padding: '0 14px 11px', fontSize: 11, position: 'relative', zIndex: 2 }}>
              <div style={{ height: 1, background: `linear-gradient(90deg, ${FRAME}55, transparent)`, margin: '0 0 8px' }} />
              <div style={{ display: 'grid', gridTemplateColumns: '70px 1fr', rowGap: 5, alignItems: 'baseline' }}>
                <span style={{ color: MUTED, letterSpacing: '0.06em' }}>{t('overlay.status')}</span>
                <span style={{ color: STATE, fontWeight: 600, textShadow: `0 0 8px ${STATE}55` }}>{STATUS_TXT}</span>
                <span style={{ color: MUTED, letterSpacing: '0.06em' }}>{t('overlay.external')}</span>
                <span style={{ color: VALUE }}>{status?.externalIP ?? '—'}</span>
                <span style={{ color: MUTED, letterSpacing: '0.06em' }}>{t('overlay.internal')}</span>
                <span style={{ color: VALUE }}>{status?.internalIP ?? '—'}</span>
                <span style={{ color: MUTED, letterSpacing: '0.06em' }}>{t('overlay.lastCheck')}</span>
                <span style={{ color: '#9fd8e6' }}>{status?.lastCheck ? new Date(status.lastCheck).toLocaleTimeString() : '—'}</span>
              </div>

              {safety === 'unknown' && (
                <p style={{ color: '#ffcc44', fontSize: 9, marginTop: 6, letterSpacing: '0.02em', opacity: 0.85 }}>ⓘ {t('overlay.unknownHint')}</p>
              )}

              {pivots.length > 0 && (() => {
                const chain = [...pivots].sort((a, b) => a.ts - b.ts)
                const deepest = [...chain].reverse().find((p) => p.route)?.route ?? status?.internalIP ?? t('overlay.internalNet')
                const arrow = <span style={{ color: `${SKY}99`, fontSize: 11, flexShrink: 0 }}>▸</span>
                const nodeClip = 'polygon(5px 0,100% 0,100% calc(100% - 5px),calc(100% - 5px) 100%,0 100%,0 5px)'
                const pill = (color: string, bg: string, brd: string, top: string, sub: string): JSX.Element => (
                  <span style={{ display: 'inline-flex', flexDirection: 'column', alignItems: 'flex-start', padding: '3px 8px', clipPath: nodeClip, background: bg, border: `1px solid ${brd}`, flexShrink: 0, maxWidth: 150 }}>
                    <span style={{ color, fontSize: 10, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 134 }}>{top}</span>
                    <span style={{ color: MUTED, fontSize: 8, letterSpacing: '0.08em' }}>{sub.toUpperCase()}</span>
                  </span>
                )
                return (
                  <>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6, margin: '9px 0 6px' }}>
                      <span style={{ color: CYAN, fontSize: 10, textShadow: `0 0 6px ${CYAN}` }}>⇄</span>
                      <span style={{ color: '#7fe6f7', fontSize: 8.5, fontWeight: 700, letterSpacing: '0.14em' }}>{t('overlay.topology').toUpperCase()}</span>
                      <span style={{ flex: 1, height: 1, background: `linear-gradient(90deg, ${CYAN}44, transparent)` }} />
                    </div>
                    <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 5, rowGap: 6 }}>
                      {pill('#d6f5ff', 'rgba(255,255,255,0.04)', 'rgba(120,140,150,0.4)', status?.externalIP ?? '—', t('overlay.external'))}
                      {chain.map((p) => (
                        <span key={p.via + p.ts} style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                          {arrow}
                          {pill('#bfeff5', hexA(CYAN, 0.12), `${SKY}55`, p.via, p.tool)}
                        </span>
                      ))}
                      {arrow}
                      {pill('#8fddb6', hexA(HUD.green, 0.12), hexA(HUD.green, 0.42), deepest, t('overlay.internalNet'))}
                    </div>
                  </>
                )
              })()}

              {status?.error && <p style={{ color: '#e39aa0', marginTop: 6, fontSize: 10 }}>{status.error}</p>}

              {showMark && (
                <button
                  onClick={() => window.redlog.overlay?.quickMark()}
                  style={{ ...noDrag, marginTop: 10, width: '100%', padding: '6px 0', fontSize: 10, fontWeight: 700, letterSpacing: '0.14em', color: CYAN, background: hexA(CYAN, 0.09), border: `1px solid ${CYAN}55`, clipPath: 'polygon(6px 0,100% 0,100% calc(100% - 6px),calc(100% - 6px) 100%,0 100%,0 6px)', cursor: 'pointer', fontFamily: 'inherit', textShadow: `0 0 7px ${CYAN}55`, transition: 'background 0.12s' }}
                  onMouseEnter={(e) => (e.currentTarget.style.background = 'rgba(34,211,238,0.18)')}
                  onMouseLeave={(e) => (e.currentTarget.style.background = 'rgba(34,211,238,0.08)')}
                  title="⌘⇧M"
                >
                  ⚑ {t('overlay.mark').toUpperCase()}
                </button>
              )}
            </div>
          )}
        </div>

        {/* corner brackets — incomplete frame = active scan */}
        {bracket({ top: 4, left: 4, borderTop: `1.5px solid ${FRAME}`, borderLeft: `1.5px solid ${FRAME}` })}
        {bracket({ top: 4, right: 4, borderTop: `1.5px solid ${FRAME}`, borderRight: `1.5px solid ${FRAME}` })}
        {bracket({ bottom: 4, left: 4, borderBottom: `1.5px solid ${FRAME}`, borderLeft: `1.5px solid ${FRAME}` })}
        {bracket({ bottom: 4, right: 4, borderBottom: `1.5px solid ${FRAME}`, borderRight: `1.5px solid ${FRAME}` })}

        <style>{`
          @keyframes pulse { 0%,100% { opacity: 1; } 50% { opacity: 0.35; } }
          @keyframes blinkRec { 0%,100% { opacity: 1; } 50% { opacity: 0.15; } }
        `}</style>
      </div>
    </div>
  )
}
