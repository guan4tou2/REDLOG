import { useEffect, useState, useRef, useCallback } from 'react'
import { useI18n } from './i18n'

export default function OverlayApp(): JSX.Element {
  const [status, setStatus] = useState<IPStatus | null>(null)
  const [expanded, setExpanded] = useState(false)
  const [recording, setRecording] = useState(true)
  const [interactive, setInteractive] = useState(false)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const { t } = useI18n()

  const handleMouseEnter = useCallback(() => {
    setInteractive(true)
    ;(window.redlog.overlay as { mouseEnter?: () => void })?.mouseEnter?.()
  }, [])

  const handleMouseLeave = useCallback(() => {
    setInteractive(false)
    ;(window.redlog.overlay as { mouseLeave?: () => void })?.mouseLeave?.()
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

  const VPN_STYLES = {
    connected: {
      bg: 'rgba(22,163,74,0.12)',
      border: 'rgba(34,197,94,0.35)',
      dot: '#22c55e',
      label: t('overlay.vpn'),
      labelColor: '#86efac',
      statusText: t('overlay.vpnConnected'),
      statusColor: '#22c55e'
    },
    disconnected: {
      bg: 'rgba(220,38,38,0.15)',
      border: 'rgba(239,68,68,0.5)',
      dot: '#ef4444',
      label: t('overlay.noVpn'),
      labelColor: '#fca5a5',
      statusText: t('overlay.dailyIp'),
      statusColor: '#ef4444'
    },
    unknown: {
      bg: 'rgba(234,179,8,0.12)',
      border: 'rgba(234,179,8,0.35)',
      dot: '#eab308',
      label: t('overlay.ipUnknown'),
      labelColor: '#fde047',
      statusText: t('overlay.unknownIp'),
      statusColor: '#eab308'
    }
  }

  const s = VPN_STYLES[vpn]

  return (
    <div
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
      style={{
        background: s.bg,
        border: `1px solid ${interactive ? 'rgba(255,255,255,0.3)' : s.border}`,
        borderRadius: 12,
        backdropFilter: 'blur(16px)',
        overflow: 'hidden',
        margin: 4,
        height: 'calc(100% - 8px)',
        userSelect: 'none',
        fontFamily: 'ui-monospace, SFMono-Regular, "SF Mono", Menlo, monospace',
        position: 'relative',
        opacity: interactive ? 1 : 0.85,
        transition: 'opacity 0.15s, border-color 0.15s',
        WebkitAppRegion: 'drag'
      } as React.CSSProperties}
    >
      {/* Close button */}
      <div
        onClick={() => window.redlog.overlay?.hide()}
        style={{
          position: 'absolute', top: 6, right: 8, zIndex: 10,
          color: '#a3a3a3', fontSize: 10, cursor: 'pointer',
          width: 18, height: 18, borderRadius: '50%',
          background: 'rgba(50,50,50,0.9)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          WebkitAppRegion: 'no-drag'
        } as React.CSSProperties}
        title={t('overlay.hide')}
      >
        ✕
      </div>
      {/* Compact bar */}
      <div
        onClick={toggleExpand}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          padding: '0 24px 0 14px',
          height: 42,
          fontSize: 12,
          cursor: 'pointer',
          WebkitAppRegion: 'no-drag'
        } as React.CSSProperties}
      >
        {/* Recording indicator */}
        <span
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 4,
            marginRight: 2,
            flexShrink: 0
          }}
        >
          <span
            style={{
              width: 7,
              height: 7,
              borderRadius: '50%',
              background: recording ? '#ef4444' : '#52525b',
              boxShadow: recording ? '0 0 6px #ef4444' : 'none',
              animation: recording ? 'blinkRec 1s step-end infinite' : undefined,
              flexShrink: 0
            }}
          />
          <span
            style={{
              fontSize: 9,
              fontWeight: 700,
              letterSpacing: '0.08em',
              color: recording ? '#fca5a5' : '#71717a'
            }}
          >
            {recording ? t('overlay.rec') : t('overlay.paused')}
          </span>
        </span>

        <span style={{ color: '#333', fontSize: 14 }}>│</span>

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
        <span style={{ color: '#525252', fontSize: 10 }}>{t('overlay.ext')}</span>
        <span style={{ color: '#e5e5e5', fontWeight: 500 }}>
          {status?.externalIP ?? '—'}
        </span>
        <span style={{ color: '#333' }}>│</span>
        <span style={{ color: '#525252', fontSize: 10 }}>{t('overlay.int')}</span>
        <span style={{ color: '#e5e5e5', fontWeight: 500 }}>
          {status?.internalIP ?? '—'}
        </span>
        {expanded && (
          <span
            onClick={(e) => { e.stopPropagation(); collapse() }}
            style={{ marginLeft: 'auto', color: '#737373', fontSize: 14, cursor: 'pointer', padding: '0 2px' }}
          >
            ▴
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
            <span style={{ color: '#737373' }}>{t('overlay.status')}</span>
            <span style={{ color: s.statusColor, fontWeight: 600 }}>{s.statusText}</span>
            <span style={{ color: '#737373' }}>{t('overlay.external')}</span>
            <span style={{ color: '#e5e5e5' }}>{status?.externalIP ?? '—'}</span>
            <span style={{ color: '#737373' }}>{t('overlay.internal')}</span>
            <span style={{ color: '#e5e5e5' }}>{status?.internalIP ?? '—'}</span>
            <span style={{ color: '#737373' }}>{t('overlay.lastCheck')}</span>
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
        @keyframes blinkRec {
          0%, 100% { opacity: 1; }
          50% { opacity: 0; }
        }
      `}</style>
    </div>
  )
}
