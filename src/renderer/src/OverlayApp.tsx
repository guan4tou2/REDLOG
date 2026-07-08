import { useEffect, useState } from 'react'

export default function OverlayApp(): JSX.Element {
  const [status, setStatus] = useState<IPStatus | null>(null)
  const [expanded, setExpanded] = useState(false)

  useEffect(() => {
    window.redlog.ip.getStatus().then(setStatus)
    return window.redlog.ip.onStatus(setStatus)
  }, [])

  const toggleExpand = () => {
    const next = !expanded
    setExpanded(next)
    window.redlog.overlay?.setExpanded(next)
  }

  const safe = status?.isAllowed ?? true
  const bg = safe ? 'rgba(22,163,74,0.15)' : 'rgba(220,38,38,0.2)'
  const border = safe ? 'rgba(34,197,94,0.4)' : 'rgba(239,68,68,0.6)'
  const dot = safe ? '#22c55e' : '#ef4444'

  return (
    <div
      onClick={toggleExpand}
      style={{
        background: bg,
        border: `1px solid ${border}`,
        borderRadius: 10,
        backdropFilter: 'blur(12px)',
        WebkitAppRegion: 'drag',
        cursor: 'pointer',
        overflow: 'hidden',
        height: '100%',
        userSelect: 'none',
        fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif'
      } as React.CSSProperties}
    >
      {/* Compact bar */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          padding: '0 14px',
          height: 42,
          fontSize: 13
        }}
      >
        <span
          style={{
            width: 8,
            height: 8,
            borderRadius: '50%',
            background: dot,
            boxShadow: `0 0 6px ${dot}`,
            animation: safe ? undefined : 'pulse 1.5s infinite',
            flexShrink: 0
          }}
        />
        <span style={{ color: safe ? '#86efac' : '#fca5a5', fontWeight: 600, fontSize: 11 }}>
          {status ? (safe ? 'VPN' : '⚠') : '…'}
        </span>
        <span style={{ color: '#a3a3a3', fontSize: 11 }}>外</span>
        <span style={{ color: '#e5e5e5', fontFamily: 'monospace', fontWeight: 500 }}>
          {status?.externalIP ?? '—'}
        </span>
        <span style={{ color: '#404040' }}>│</span>
        <span style={{ color: '#a3a3a3', fontSize: 11 }}>內</span>
        <span style={{ color: '#e5e5e5', fontFamily: 'monospace', fontWeight: 500 }}>
          {status?.internalIP ?? '—'}
        </span>
      </div>

      {/* Expanded details */}
      {expanded && (
        <div style={{ padding: '4px 14px 12px', fontSize: 12, color: '#a3a3a3' }}>
          <div style={{ display: 'grid', gridTemplateColumns: '100px 1fr', gap: '6px 0' }}>
            <span>Status</span>
            <span style={{ color: safe ? '#22c55e' : '#ef4444', fontWeight: 600 }}>
              {safe ? 'IP Allowed' : 'IP NOT in allowedIPs'}
            </span>
            <span>External</span>
            <span style={{ color: '#e5e5e5', fontFamily: 'monospace' }}>
              {status?.externalIP ?? '—'}
            </span>
            <span>Internal</span>
            <span style={{ color: '#e5e5e5', fontFamily: 'monospace' }}>
              {status?.internalIP ?? '—'}
            </span>
            <span>Last check</span>
            <span>{status?.lastCheck ? new Date(status.lastCheck).toLocaleTimeString() : '—'}</span>
          </div>
          {status?.error && (
            <p style={{ color: '#ef4444', marginTop: 8 }}>{status.error}</p>
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
