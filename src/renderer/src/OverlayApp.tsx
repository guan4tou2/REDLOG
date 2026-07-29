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

  // auto-collapse timer resets while there's activity to read
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

  // Refined, calmer palette — one accent per state, muted chrome, brighter values.
  const SAFETY = {
    safe:    { bg: 'rgba(20,83,45,0.18)',  border: 'rgba(34,197,94,0.30)',  dot: '#22c55e', label: t('overlay.safeIp'),    labelColor: '#86efac', statusText: t('overlay.safeIpStatus'),    statusColor: '#4ade80' },
    exposed: { bg: 'rgba(127,29,29,0.22)', border: 'rgba(239,68,68,0.45)',  dot: '#ef4444', label: t('overlay.exposedIp'), labelColor: '#fca5a5', statusText: t('overlay.exposedIpStatus'), statusColor: '#f87171' },
    unknown: { bg: 'rgba(69,63,17,0.20)',  border: 'rgba(234,179,8,0.30)',  dot: '#eab308', label: t('overlay.ipUnknown'),  labelColor: '#fde047', statusText: t('overlay.unknownIp'),       statusColor: '#facc15' }
  }
  const s = SAFETY[safety]
  const PIVOT = '#38bdf8'
  const noDrag = { WebkitAppRegion: 'no-drag' } as React.CSSProperties

  const MUTED = '#8a8a92'
  const VALUE = '#e8e8ea'
  const iconBtn = (active: boolean): React.CSSProperties => ({
    color: active ? '#e5e5e5' : '#9a9aa2', fontSize: 10, cursor: 'pointer',
    width: 18, height: 18, borderRadius: '50%',
    background: interactive ? 'rgba(255,255,255,0.08)' : 'transparent',
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    transition: 'background 0.12s, color 0.12s'
  })

  const latestPivot = pivots[0]

  return (
    <div
      style={{ width: '100%', height: '100%', padding: 4, WebkitAppRegion: 'drag', cursor: interactive ? 'grab' : 'default' } as React.CSSProperties}
    >
      <div
        style={{
          background: `linear-gradient(180deg, rgba(24,24,27,0.72) 0%, rgba(9,9,11,0.82) 100%), ${s.bg}`,
          border: `1px solid ${interactive ? 'rgba(255,255,255,0.28)' : s.border}`,
          borderRadius: 13,
          backdropFilter: 'blur(18px) saturate(1.3)',
          boxShadow: interactive ? '0 8px 28px rgba(0,0,0,0.45)' : '0 4px 18px rgba(0,0,0,0.35)',
          overflow: 'hidden', height: '100%', userSelect: 'none',
          fontFamily: 'ui-monospace, SFMono-Regular, "SF Mono", Menlo, monospace',
          position: 'relative',
          opacity: interactive ? 1 : 0.9,
          transition: 'opacity 0.15s, border-color 0.15s, box-shadow 0.15s'
        }}
      >
        {/* Buttons row */}
        <div style={{ position: 'absolute', top: 5, right: 6, zIndex: 10, display: 'flex', alignItems: 'center', gap: 3, ...noDrag }}>
          <div onClick={toggleExpand} style={iconBtn(interactive)} title={expanded ? t('overlay.collapse') : t('overlay.expand')}>{expanded ? '▴' : '▾'}</div>
          <div onClick={() => window.redlog.overlay?.hide()} style={iconBtn(interactive)} title={t('overlay.hide')}>✕</div>
        </div>

        {/* Compact bar */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 7, padding: '0 50px 0 13px', height: 42, fontSize: 12, overflow: 'hidden' }}>
          {/* Recording */}
          <span style={{ display: 'flex', alignItems: 'center', gap: 4, flexShrink: 0 }}>
            <span style={{ width: 7, height: 7, borderRadius: '50%', background: recording ? '#ef4444' : '#52525b', boxShadow: recording ? '0 0 7px #ef4444' : 'none', animation: recording ? 'blinkRec 1.1s step-end infinite' : undefined }} />
            <span style={{ fontSize: 9, fontWeight: 700, letterSpacing: '0.09em', color: recording ? '#fca5a5' : '#71717a' }}>{recording ? t('overlay.rec') : t('overlay.paused')}</span>
          </span>

          <span style={{ color: 'rgba(255,255,255,0.10)', fontSize: 15, flexShrink: 0 }}>│</span>

          {/* IP safety */}
          <span style={{ width: 8, height: 8, borderRadius: '50%', background: s.dot, boxShadow: `0 0 7px ${s.dot}`, animation: safety === 'exposed' ? 'pulse 1.5s infinite' : undefined, flexShrink: 0 }} />
          <span style={{ color: s.labelColor, fontWeight: 700, fontSize: 11, letterSpacing: '0.05em', flexShrink: 0 }}>{status ? s.label : '…'}</span>
          <span style={{ color: MUTED, fontSize: 9, flexShrink: 0 }}>{t('overlay.ext')}</span>
          <span style={{ color: VALUE, fontWeight: 500, flexShrink: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{status?.externalIP ?? '—'}</span>

          {/* Pivot badge — sky accent, only when active */}
          {latestPivot && (
            <span
              style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 4, flexShrink: 0, padding: '2px 7px', borderRadius: 999, background: 'rgba(56,189,248,0.12)', border: '1px solid rgba(56,189,248,0.30)' }}
              title={pivots.map((p) => `${p.tool} → ${p.via}${p.route ? ` (${p.route})` : ''}`).join('\n')}
            >
              <span style={{ color: PIVOT, fontSize: 11 }}>⇄</span>
              <span style={{ color: '#bae6fd', fontSize: 10, fontWeight: 600, maxWidth: 96, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{latestPivot.via}</span>
              {pivots.length > 1 && <span style={{ color: PIVOT, fontSize: 9, fontWeight: 700 }}>+{pivots.length - 1}</span>}
            </span>
          )}
        </div>

        {/* Expanded */}
        {expanded && (
          <div style={{ padding: '0 13px 12px', fontSize: 11, color: '#a3a3a3' }}>
            <div style={{ height: 1, background: 'rgba(255,255,255,0.07)', margin: '0 0 8px' }} />
            <div style={{ display: 'grid', gridTemplateColumns: '78px 1fr', gap: '5px 0' }}>
              <span style={{ color: MUTED }}>{t('overlay.status')}</span>
              <span style={{ color: s.statusColor, fontWeight: 600 }}>{s.statusText}</span>
              <span style={{ color: MUTED }}>{t('overlay.external')}</span>
              <span style={{ color: VALUE }}>{status?.externalIP ?? '—'}</span>
              <span style={{ color: MUTED }}>{t('overlay.internal')}</span>
              <span style={{ color: VALUE }}>{status?.internalIP ?? '—'}</span>
              <span style={{ color: MUTED }}>{t('overlay.lastCheck')}</span>
              <span style={{ color: '#a3a3a3' }}>{status?.lastCheck ? new Date(status.lastCheck).toLocaleTimeString() : '—'}</span>
            </div>

            {/* Pivots */}
            {pivots.length > 0 && (
              <>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, margin: '9px 0 5px' }}>
                  <span style={{ color: PIVOT, fontSize: 11 }}>⇄</span>
                  <span style={{ color: '#7dd3fc', fontSize: 9, fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase' }}>{t('overlay.pivots')}</span>
                  <span style={{ flex: 1, height: 1, background: 'rgba(56,189,248,0.18)' }} />
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                  {pivots.slice(0, 3).map((p) => (
                    <div key={p.via} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 10 }}>
                      <span style={{ color: '#7dd3fc', fontWeight: 600, fontSize: 8, padding: '1px 5px', borderRadius: 4, background: 'rgba(56,189,248,0.12)', flexShrink: 0 }}>{p.tool}</span>
                      <span style={{ color: '#e0f2fe', fontWeight: 500, flexShrink: 0 }}>{p.via}</span>
                      {p.route && <span style={{ color: MUTED, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>→ {p.route}</span>}
                    </div>
                  ))}
                </div>
              </>
            )}

            {status?.error && <p style={{ color: '#f87171', marginTop: 7, fontSize: 10 }}>{status.error}</p>}

            {showMark && (
              <button
                onClick={() => window.redlog.overlay?.quickMark()}
                style={{ ...noDrag, marginTop: 9, width: '100%', padding: '6px 0', fontSize: 10, fontWeight: 600, letterSpacing: '0.05em', color: '#fca5a5', background: 'rgba(239,68,68,0.14)', border: '1px solid rgba(239,68,68,0.28)', borderRadius: 7, cursor: 'pointer', fontFamily: 'inherit', transition: 'background 0.12s' }}
                onMouseEnter={(e) => (e.currentTarget.style.background = 'rgba(239,68,68,0.22)')}
                onMouseLeave={(e) => (e.currentTarget.style.background = 'rgba(239,68,68,0.14)')}
                title="⌘⇧M"
              >
                ⚑ {t('overlay.mark')}
              </button>
            )}
          </div>
        )}

        <style>{`
          @keyframes pulse { 0%,100% { opacity: 1; } 50% { opacity: 0.4; } }
          @keyframes blinkRec { 0%,100% { opacity: 1; } 50% { opacity: 0; } }
        `}</style>
      </div>
    </div>
  )
}
