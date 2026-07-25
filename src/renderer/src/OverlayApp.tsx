import { useEffect, useState, useRef } from 'react'

const VPN_STYLES = {
  connected: {
    bg: 'rgba(22,163,74,0.12)',
    border: 'rgba(34,197,94,0.35)',
    dot: '#22c55e',
    label: 'VPN',
    labelColor: '#86efac',
    statusText: 'VPN Connected',
    statusColor: '#22c55e'
  },
  disconnected: {
    bg: 'rgba(220,38,38,0.15)',
    border: 'rgba(239,68,68,0.5)',
    dot: '#ef4444',
    label: 'NO VPN',
    labelColor: '#fca5a5',
    statusText: 'Daily IP — No VPN',
    statusColor: '#ef4444'
  },
  unknown: {
    bg: 'rgba(234,179,8,0.12)',
    border: 'rgba(234,179,8,0.35)',
    dot: '#eab308',
    label: 'IP?',
    labelColor: '#fde047',
    statusText: 'Unknown IP',
    statusColor: '#eab308'
  }
}

export default function OverlayApp(): JSX.Element {
  const [status, setStatus] = useState<IPStatus | null>(null)
  const [expanded, setExpanded] = useState(false)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    window.redlog.ip.getStatus().then(setStatus)
    return window.redlog.ip.onStatus(setStatus)
  }, [])

  useEffect(() => {
    if (expanded) {
      timerRef.current = setTimeout(() => collapse(), 8000)
    }
    return () => { if (timerRef.current) clearTimeout(timerRef.current) }
  }, [expanded])

  const collapse = (): void => {
    setExpanded(false)
    window.redlog.overlay?.setExpanded(false)
  }

  const toggleExpand = (): void => {
    const next = !expanded
    setExpanded(next)
    window.redlog.overlay?.setExpanded(next)
  }

  const vpn = status?.vpnStatus ?? 'unknown'
  const s = VPN_STYLES[vpn]

  return (
    <div
      style={{
        background: s.bg,
        border: `1px solid ${s.border}`,
        borderRadius: 12,
        backdropFilter: 'blur(16px)',
        overflow: 'hidden',
        margin: 4,
        height: 'calc(100% - 8px)',
        userSelect: 'none',
        fontFamily: 'ui-monospace, SFMono-Regular, "SF Mono", Menlo, monospace'
      }}
    >
      {/* Compact bar — clickable to toggle */}
      <div
        onClick={toggleExpand}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          padding: '0 14px',
          height: 42,
          fontSize: 12,
          cursor: 'pointer',
          WebkitAppRegion: 'no-drag'
        } as React.CSSProperties}
      >
        <span
          style={{
            width: 8,
            height: 8,
            borderRadius: '50%',
            background: s.dot,
            boxShadow: `0 0 6px ${s.dot}`,
            animation: vpn === 'disconnected' ? 'pulse 1.5s infinite' : undefined,
            flexShrink: 0
          }}
        />
        <span style={{ color: s.labelColor, fontWeight: 700, fontSize: 11, letterSpacing: '0.05em' }}>
          {status ? s.label : '...'}
        </span>
        <span style={{ color: '#525252', fontSize: 10 }}>外</span>
        <span style={{ color: '#e5e5e5', fontWeight: 500 }}>
          {status?.externalIP ?? '—'}
        </span>
        <span style={{ color: '#333' }}>│</span>
        <span style={{ color: '#525252', fontSize: 10 }}>內</span>
        <span style={{ color: '#e5e5e5', fontWeight: 500 }}>
          {status?.internalIP ?? '—'}
        </span>
        {expanded && (
          <span
            onClick={(e) => { e.stopPropagation(); collapse() }}
            style={{ marginLeft: 'auto', color: '#737373', fontSize: 14, cursor: 'pointer', padding: '0 2px' }}
          >
            ✕
          </span>
        )}
      </div>

      {/* Expanded details */}
      {expanded && (
        <div
          onClick={collapse}
          style={{
            padding: '2px 14px 12px',
            fontSize: 11,
            color: '#a3a3a3',
            cursor: 'pointer',
            WebkitAppRegion: 'no-drag'
          } as React.CSSProperties}
        >
          <div style={{ display: 'grid', gridTemplateColumns: '80px 1fr', gap: '5px 0' }}>
            <span style={{ color: '#737373' }}>Status</span>
            <span style={{ color: s.statusColor, fontWeight: 600 }}>{s.statusText}</span>
            <span style={{ color: '#737373' }}>External</span>
            <span style={{ color: '#e5e5e5' }}>{status?.externalIP ?? '—'}</span>
            <span style={{ color: '#737373' }}>Internal</span>
            <span style={{ color: '#e5e5e5' }}>{status?.internalIP ?? '—'}</span>
            <span style={{ color: '#737373' }}>Last check</span>
            <span style={{ color: '#a3a3a3' }}>{status?.lastCheck ? new Date(status.lastCheck).toLocaleTimeString() : '—'}</span>
          </div>
          {status?.error && (
            <p style={{ color: '#ef4444', marginTop: 6, fontSize: 10 }}>{status.error}</p>
          )}
        </div>
      )}

      <style>{`
        @keyframes pulse {
          0%, 100% { opacity: 1; }
          50% { opacity: 0.4; }
        }
      `}</style>
    </div>
  )
}
