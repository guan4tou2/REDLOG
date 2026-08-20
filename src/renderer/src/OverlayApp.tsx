import { useEffect, useState, useRef, useLayoutEffect } from 'react'
import { useI18n } from './i18n'
import { HUD, hexA } from './lib/hud'
import { usePivots } from './lib/usePivots'

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
  const [flashExposed, setFlashExposed] = useState(true)
  const [scale, setScale] = useState(1.0)
  const [emphasizeIp, setEmphasizeIp] = useState(false)
  // Pin: when true, the expanded HUD never auto-collapses. Session-local (not
  // persisted). Toggle via a pin button in the compact bar. Audit finding #52.
  const [pinned, setPinned] = useState(false)
  // Pass-through visual state — dims non-critical HUD chrome while keeping the
  // external IP fully readable (user asked for exactly that: "外部IP可以保持
  // 透明度嗎"). Applied via CSS opacity on the root, IP nodes opt back to 1
  // via `data-critical` — window opacity stays at 1 so the ip's colour isn't
  // washed out by the compositor.
  const [passThrough, setPassThrough] = useState(false)
  const [passThroughOpacity, setPassThroughOpacity] = useState(0.4)
  const pivots = usePivots()
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  // Inline confirmation for the instant mark. Without it the button gives no
  // sign anything happened — there is no dialog and no window change, which is
  // the entire point of it.
  const [justMarked, setJustMarked] = useState(false)
  const markedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const contentRef = useRef<HTMLDivElement | null>(null)
  const { t } = useI18n()

  // Report the exact content height so the window fits it — no clipping, no
  // empty gap. Runs after every layout-affecting change.
  useLayoutEffect(() => {
    const el = contentRef.current
    if (!el) return
    const h = el.offsetHeight
    const w = Math.round(440 * scale) + (emphasizeIp ? Math.round(44 * scale) : 0)
    if (h) (window.redlog.overlay as { autosize?: (h: number, w?: number) => void })?.autosize?.(h + 18, w)
  })

  useEffect(() => {
    const cfg = window.redlog.config as {
      get?: () => Promise<unknown>
      onShowMark?: (cb: (show: boolean) => void) => () => void
      onFlashExposed?: (cb: (on: boolean) => void) => () => void
      onScale?: (cb: (s: number) => void) => () => void
      onEmphasizeIp?: (cb: (on: boolean) => void) => () => void
      onPassThrough?: (cb: (on: boolean, opacity: number) => void) => () => void
    } | undefined
    cfg?.get?.().then((c) => {
      const ov = (c as { overlay?: { showMarkButton?: boolean; flashOnExposed?: boolean; scale?: number; emphasizeExternalIp?: boolean; passThrough?: boolean; passThroughOpacity?: number } } | null)?.overlay
      setShowMark(ov?.showMarkButton !== false)
      setFlashExposed(ov?.flashOnExposed !== false)
      if (typeof ov?.scale === 'number' && ov.scale > 0) setScale(ov.scale)
      setEmphasizeIp(ov?.emphasizeExternalIp === true)
      setPassThrough(ov?.passThrough === true)
      if (typeof ov?.passThroughOpacity === 'number' && ov.passThroughOpacity > 0) setPassThroughOpacity(ov.passThroughOpacity)
    }).catch(() => {})
    // live-update when the settings are toggled in Settings
    const off1 = cfg?.onShowMark?.(setShowMark)
    const off2 = cfg?.onFlashExposed?.(setFlashExposed)
    const off3 = cfg?.onScale?.(setScale)
    const off4 = cfg?.onEmphasizeIp?.(setEmphasizeIp)
    const off5 = cfg?.onPassThrough?.((on, op) => { setPassThrough(on); if (op > 0) setPassThroughOpacity(op) })
    return () => { off1?.(); off2?.(); off3?.(); off4?.(); off5?.() }
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


  // Auto-collapse the expanded HUD after 8s of inactivity — but reset the
  // timer while the pointer is on the overlay so a reviewer reading the
  // topology chain / Reveal button doesn't get it yanked out from under
  // them (audit finding P1 #15). `interactive` flips true when the mouse
  // enters the overlay window (main-process tracker).
  useEffect(() => {
    if (!expanded || interactive || pinned) return
    timerRef.current = setTimeout(() => collapse(), 8000)
    return () => { if (timerRef.current) clearTimeout(timerRef.current) }
  }, [expanded, interactive, pinned])

  const collapse = (): void => { setExpanded(false); window.redlog.overlay?.setExpanded(false) }
  const toggleExpand = (): void => {
    const next = !expanded
    setExpanded(next)
    window.redlog.overlay?.setExpanded(next)
  }

  // fs = font-size scaler; ip = extra emphasis for the external IP.
  // Clamp scale to a sane band so a rogue config can't blow the HUD up beyond
  // useful. `autosize` picks up the new content height on every render so the
  // window still fits without clipping.
  const doInstantMark = async (): Promise<void> => {
    const api = window.redlog.overlay as { instantMark?: () => Promise<{ ok: boolean }> } | undefined
    const r = await api?.instantMark?.()
    if (!r?.ok) return
    setJustMarked(true)
    if (markedTimerRef.current) clearTimeout(markedTimerRef.current)
    markedTimerRef.current = setTimeout(() => setJustMarked(false), 1400)
  }

  const s = Math.max(0.75, Math.min(1.75, scale))
  // 11px is the HUD's text floor (UIUX-STANDARD §2 — the HUD is the one
  // exception to the app's 13px floor, because it has its own scale setting
  // and sits at arm's length). The ladder used to run down to 8px, which is
  // below the size at which a label is legible at any distance. Sizes under
  // the floor collapse onto it; the hierarchy they used to carry is carried by
  // weight and colour instead, which is how §2 says it should have worked.
  const HUD_MIN_PX = 11
  const fs = (n: number): number => Math.round(Math.max(n, HUD_MIN_PX) * s * 10) / 10
  const fsIp = (n: number): number => Math.round(n * s * (emphasizeIp ? 1.4 : 1) * 10) / 10
  // px() scales layout dimensions (padding, gap, separator sizes) with the
  // same factor. Without this the middle gap stays fixed while text shrinks —
  // small scale looks loose, large scale looks cramped.
  const px = (n: number): number => Math.round(n * s)
  const hair = <span style={{ width: 1, height: px(13), background: 'rgba(34,211,238,0.25)', flexShrink: 0 }} />

  const safety = status?.ipSafety ?? 'unknown'
  const link = status?.link
  const linkText = link?.type === 'wifi' ? (link.name || 'Wi-Fi')
    : link?.type === 'wired' ? t('overlay.wired') : ''
  const STATE = { safe: HUD.green, exposed: HUD.red, unknown: HUD.amber }[safety]
  const LABEL = { safe: t('overlay.safeIp'), exposed: t('overlay.exposedIp'), unknown: t('overlay.ipUnknown') }[safety]
  const STATUS_TXT = { safe: t('overlay.safeIpStatus'), exposed: t('overlay.exposedIpStatus'), unknown: t('overlay.unknownIp') }[safety]
  // exposure turns the whole frame into a red-alert scan; otherwise cyan HUD.
  const FRAME = safety === 'exposed' ? HUD.red : CYAN
  // when EXPOSED, flash the whole frame as an unmissable alarm (opt-out in Settings).
  const alarm = safety === 'exposed' && flashExposed
  const noDrag = { WebkitAppRegion: 'no-drag' } as React.CSSProperties
  const BTN_CLIP = 'polygon(6px 0,100% 0,100% calc(100% - 6px),calc(100% - 6px) 100%,0 100%,0 6px)'

  const bracket = (pos: React.CSSProperties): JSX.Element => (
    <span style={{ position: 'absolute', width: 9, height: 9, borderColor: FRAME, boxShadow: `0 0 4px ${FRAME}55`, pointerEvents: 'none', ...pos }} />
  )
  const iconBtn: React.CSSProperties = {
    color: CYAN, fontSize: fs(10), cursor: 'pointer', width: 18, height: 16,
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    background: interactive ? 'rgba(34,211,238,0.10)' : 'transparent',
    border: `1px solid ${interactive ? 'rgba(34,211,238,0.35)' : 'transparent'}`,
    transition: 'background 0.12s, border-color 0.12s'
  }
  const latestPivot = pivots[0]
  const tick = (c: string): React.CSSProperties => ({ width: 6, height: 6, borderRadius: '50%', background: c, boxShadow: `0 0 7px ${c}, 0 0 3px ${c}`, flexShrink: 0 })

  // Pass-through dimming — applied to individual "chrome" children instead
  // of the outer wrapper. CSS opacity on a parent forces every descendant
  // to composite at the reduced alpha, so children can never opt back to
  // opacity 1. Instead we sprinkle `...dimStyle` on non-critical rows and
  // leave the external IP row untouched, so the whole point of the HUD
  // (the IP) stays fully readable regardless of pass-through state.
  const dimStyle: React.CSSProperties = passThrough ? { opacity: passThroughOpacity } : {}
  return (
    <div
      style={{ width: '100%', height: '100%', padding: 3, WebkitAppRegion: 'drag', cursor: interactive ? 'grab' : 'default' } as React.CSSProperties}
    >
      {/* frame (neon edge) */}
      <div style={{ position: 'relative', height: '100%', borderRadius: 5, background: FRAME, opacity: interactive ? 1 : 0.94, transition: 'background 0.2s, opacity 0.15s', boxShadow: `0 0 16px ${FRAME}44`, animation: alarm ? 'alarm 0.9s ease-in-out infinite' : undefined }}>
        {/* panel (inset fill) */}
        <div
          style={{
            position: 'absolute', inset: 1, borderRadius: 4,
            background: 'rgba(7,12,17,0.65)',
            backdropFilter: 'blur(16px) saturate(1.5)',
            overflow: 'hidden',
            fontFamily: '"JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, Consolas, monospace'
          }}
        >
          {/* scanlines */}
          <div style={{ position: 'absolute', inset: 0, pointerEvents: 'none', background: 'repeating-linear-gradient(0deg, rgba(34,211,238,0.035) 0px, rgba(34,211,238,0.035) 1px, transparent 1px, transparent 3px)', opacity: 0.6 }} />

          {/* buttons (top-right): expand + hide only. The pin toggle used to
              live here too, but the operator asked to move it into the
              expanded pane's bottom row — it's a low-frequency action and
              a fixed-position icon in the corner competed with the more
              important expand button for glances. */}
          <div style={{ position: 'absolute', top: 5, right: 7, zIndex: 10, display: 'flex', alignItems: 'center', gap: 3, ...noDrag, ...dimStyle }}>
            <div onClick={toggleExpand} style={iconBtn} title={expanded ? t('overlay.collapse') : t('overlay.expand')} aria-label={expanded ? t('overlay.collapse') : t('overlay.expand')}>{expanded ? '▲' : '▼'}</div>
            <div onClick={() => window.redlog.overlay?.hide()} style={iconBtn} title={t('overlay.hide')} aria-label={t('overlay.hide')}>✕</div>
          </div>

          {/* measured content — window auto-sizes to this */}
          <div ref={contentRef}>
          {/* compact bar — two columns: external IP (left) with any active pivot
              stacked beneath it, and internal IP (right) with the Wi-Fi/wired name
              beneath it. Keeping the pivot in the external column stops it crowding
              the internal IP. */}
          <div style={{ display: 'flex', alignItems: 'center', gap: px(8), padding: `${px(4)}px ${px(54)}px ${px(4)}px ${px(12)}px`, minHeight: px(40), fontSize: fs(12), position: 'relative', zIndex: 2, overflow: 'hidden' }}>
            <span style={{ display: 'flex', alignItems: 'center', gap: 4, flexShrink: 0, ...dimStyle }}>
              <span style={{ ...tick(recording ? HUD.red : '#3a4a52'), animation: recording ? 'blinkRec 1.1s step-end infinite' : undefined }} />
              <span style={{ fontSize: fs(9), fontWeight: 700, letterSpacing: '0.14em', color: recording ? '#e39aa0' : '#4a5a62', textShadow: recording ? `0 0 7px ${hexA(HUD.red, 0.4)}` : 'none' }}>{recording ? t('overlay.rec') : t('overlay.paused')}</span>
            </span>
            <span style={dimStyle}>{hair}</span>
            <span style={{ ...tick(STATE), animation: safety === 'exposed' ? 'pulse 1.4s infinite' : undefined, ...dimStyle }} />
            <span style={{ color: STATE, fontWeight: 700, fontSize: fs(10.5), letterSpacing: '0.09em', textShadow: `0 0 8px ${STATE}55`, flexShrink: 0, ...dimStyle }}>{status ? LABEL : '···'}</span>
            {/* external IP + pivot (left column) */}
            <span style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: 1, flexShrink: 1, minWidth: 0, lineHeight: 1.15, overflow: 'hidden' }}>
              <span style={{ display: 'flex', alignItems: 'baseline', gap: 4, maxWidth: '100%' }}>
                <span style={{ color: MUTED, fontSize: fs(8.5), letterSpacing: '0.1em', flexShrink: 0 }}>{t('overlay.ext')}</span>
                <span style={{ color: VALUE, fontWeight: 600, whiteSpace: 'nowrap', fontSize: fsIp(12), overflow: 'hidden', textOverflow: 'ellipsis' }}>{status?.externalIP ?? '—'}</span>
              </span>
              {latestPivot && (
                <span
                  style={{ display: 'inline-flex', alignItems: 'center', gap: 4, padding: '1px 6px', clipPath: 'polygon(4px 0,100% 0,100% calc(100% - 4px),calc(100% - 4px) 100%,0 100%,0 4px)', background: hexA(CYAN, 0.2), border: `1px solid ${hexA(CYAN, 0.6)}`, boxShadow: `0 0 5px ${hexA(CYAN, 0.2)}`, maxWidth: 160 }}
                  title={pivots.map((p) => `${p.tool} → ${p.via}${p.route ? ` (${p.route})` : ''}`).join('\n')}
                >
                  <span style={{ color: CYAN, fontSize: fs(9), textShadow: `0 0 6px ${CYAN}` }}>⇄</span>
                  <span style={{ color: '#bff2ff', fontSize: fs(9.5), fontWeight: 600, maxWidth: 100, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{latestPivot.via}</span>
                  {pivots.length > 1 && <span style={{ color: CYAN, fontSize: fs(8.5), fontWeight: 700 }}>+{pivots.length - 1}</span>}
                </span>
              )}
            </span>
            {/* internal IP + network name (right column) */}
            <span style={{ marginLeft: 'auto', display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 1, minWidth: 0, lineHeight: 1.15, flexShrink: 1, overflow: 'hidden', ...dimStyle }}>
              <span style={{ display: 'flex', alignItems: 'baseline', gap: 4, maxWidth: '100%' }}>
                <span style={{ color: MUTED, fontSize: fs(8.5), letterSpacing: '0.1em', flexShrink: 0 }}>{t('overlay.int')}</span>
                <span style={{ color: '#9fd8e6', fontWeight: 500, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{status?.internalIP ?? '—'}</span>
              </span>
              {linkText && (
                <span style={{ display: 'flex', alignItems: 'baseline', gap: 4, maxWidth: '100%', minWidth: 0 }}>
                  <span style={{ color: MUTED, fontSize: fs(8), letterSpacing: '0.1em', flexShrink: 0 }}>{link?.type === 'wifi' ? '⌁' : t('overlay.net')}</span>
                  <span style={{ color: '#7fb8c6', fontWeight: 500, fontSize: fs(10), overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{linkText}</span>
                </span>
              )}
            </span>
          </div>

          {/* expanded */}
          {expanded && (
            <div style={{ padding: '0 14px 11px', fontSize: fs(11), position: 'relative', zIndex: 2, ...dimStyle }}>
              <div style={{ height: 1, background: `linear-gradient(90deg, ${FRAME}55, transparent)`, margin: '0 0 8px' }} />
              {/* v0.11.1: the label column scales with the text. It was a hard
                  70px while the labels render at fs(11), so "Last check" sat
                  right on the boundary at scale 1 and wrapped to two lines —
                  and at scale 1.25/1.5 every label wrapped. `px()` ties the
                  column to the same factor as the type, which is what the
                  rest of the panel already does. */}
              <div style={{ display: 'grid', gridTemplateColumns: `${px(78)}px 1fr`, rowGap: px(5), alignItems: 'baseline' }}>
                <span style={{ color: MUTED, letterSpacing: '0.06em' }}>{t('overlay.status')}</span>
                <span style={{ color: STATE, fontWeight: 600, textShadow: `0 0 8px ${STATE}55` }}>{STATUS_TXT}</span>
                <span style={{ color: MUTED, letterSpacing: '0.06em' }}>{t('overlay.external')}</span>
                <span style={{ color: VALUE, fontSize: fsIp(11) }}>{status?.externalIP ?? '—'}</span>
                <span style={{ color: MUTED, letterSpacing: '0.06em' }}>{t('overlay.internal')}</span>
                <span style={{ color: VALUE }}>{status?.internalIP ?? '—'}</span>
                <span style={{ color: MUTED, letterSpacing: '0.06em' }}>{t('overlay.network')}</span>
                <span style={{ color: VALUE }}>{link?.type === 'wifi' ? `⌁ ${linkText}` : linkText || '—'}</span>
                <span style={{ color: MUTED, letterSpacing: '0.06em' }}>{t('overlay.lastCheck')}</span>
                <span style={{ color: '#9fd8e6' }}>{status?.lastCheck ? new Date(status.lastCheck).toLocaleTimeString() : '—'}</span>
              </div>

              {safety === 'unknown' && (
                <p style={{ color: '#ffcc44', fontSize: fs(9), marginTop: 6, letterSpacing: '0.02em', opacity: 0.85 }}>ⓘ {t('overlay.unknownHint')}</p>
              )}

              {pivots.length > 0 && (() => {
                const chain = [...pivots].sort((a, b) => a.ts - b.ts)
                const arrow = <span style={{ color: hexA(CYAN, 0.8), fontSize: fs(11), flexShrink: 0 }}>▸</span>
                const nodeClip = 'polygon(5px 0,100% 0,100% calc(100% - 5px),calc(100% - 5px) 100%,0 100%,0 5px)'
                const pill = (color: string, bg: string, brd: string, top: string, sub: string): JSX.Element => (
                  <span style={{ display: 'inline-flex', flexDirection: 'column', alignItems: 'flex-start', padding: '3px 8px', clipPath: nodeClip, background: bg, border: `1px solid ${brd}`, flexShrink: 0, maxWidth: 150 }}>
                    <span style={{ color, fontSize: fs(10), fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 134 }}>{top}</span>
                    <span style={{ color: MUTED, fontSize: fs(8), letterSpacing: '0.08em' }}>{sub.toUpperCase()}</span>
                  </span>
                )
                return (
                  <>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6, margin: '9px 0 6px' }}>
                      <span style={{ color: CYAN, fontSize: fs(10), textShadow: `0 0 6px ${CYAN}` }}>⇄</span>
                      <span style={{ color: '#7fe6f7', fontSize: fs(8.5), fontWeight: 700, letterSpacing: '0.14em' }}>{t('overlay.topology').toUpperCase()}</span>
                      <span style={{ flex: 1, height: 1, background: `linear-gradient(90deg, ${CYAN}44, transparent)` }} />
                    </div>
                    {/* our host outward: internal → external egress → pivot hops */}
                    <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 5, rowGap: 6 }}>
                      {pill('#a6e8c6', hexA(HUD.green, 0.2), hexA(HUD.green, 0.6), status?.internalIP ?? t('overlay.internalNet'), t('overlay.internalNet'))}
                      {arrow}
                      {pill('#eaf7fb', 'rgba(255,255,255,0.09)', 'rgba(150,170,180,0.6)', status?.externalIP ?? '—', t('overlay.external'))}
                      {chain.map((p) => (
                        <span key={p.via + p.ts} style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                          {arrow}
                          {pill('#d6f7fd', hexA(CYAN, 0.22), hexA(CYAN, 0.6), p.route ? `${p.via} (${p.route})` : p.via, p.tool)}
                        </span>
                      ))}
                    </div>
                  </>
                )
              })()}

              {status?.error && <p style={{ color: '#e39aa0', marginTop: 6, fontSize: fs(10) }}>{status.error}</p>}

              {/* Bottom action row — two marks + the keep-open toggle.
                  v0.9.7: the single MARK button opened the full dialog in the
                  main window, which raises and focuses it — the one thing a
                  heads-up display should never do to note that something just
                  happened. Split in two:
                    quick   — timestamped marker straight into the chain, no
                              dialog, no focus change; the HUD confirms inline
                    detail  — the previous behaviour, for when a title and
                              notes are worth stopping for
                  Both are kept out of the top-right chrome so ▲/✕ stay
                  uncluttered for glance operation. */}
              <div style={{ ...noDrag, display: 'flex', gap: 6, marginTop: 10 }}>
                {showMark && (
                  <>
                    <button
                      onClick={() => { void doInstantMark() }}
                      style={{ flex: 1, padding: '6px 0', fontSize: fs(10), fontWeight: 700, letterSpacing: '0.12em', color: justMarked ? HUD.green : CYAN, background: justMarked ? hexA(HUD.green, 0.18) : hexA(CYAN, 0.09), border: `1px solid ${justMarked ? HUD.green : CYAN}55`, clipPath: BTN_CLIP, cursor: 'pointer', fontFamily: 'inherit', textShadow: `0 0 7px ${justMarked ? HUD.green : CYAN}55`, transition: 'background 0.12s, color 0.12s' }}
                      title={t('overlay.markQuickHint')}
                    >
                      {justMarked ? `✓ ${t('overlay.marked').toUpperCase()}` : `⚡ ${t('overlay.markQuick').toUpperCase()}`}
                    </button>
                    <button
                      onClick={() => window.redlog.overlay?.quickMark()}
                      style={{ flex: 1, padding: '6px 0', fontSize: fs(10), fontWeight: 700, letterSpacing: '0.12em', color: CYAN, background: hexA(CYAN, 0.09), border: `1px solid ${CYAN}55`, clipPath: BTN_CLIP, cursor: 'pointer', fontFamily: 'inherit', textShadow: `0 0 7px ${CYAN}55`, transition: 'background 0.12s' }}
                      title={`${t('overlay.markDetailHint')} · ${navigator.platform?.includes('Mac') ? '⌘⇧M' : 'Ctrl+Shift+M'}`}
                    >
                      ✎ {t('overlay.markDetail').toUpperCase()}
                    </button>
                  </>
                )}
                {/* Keep-open. This always controlled the 8s auto-collapse, but
                    a bare 📌 did not say so — relabelled to name the thing it
                    actually does. */}
                {/* v0.11.1: back to a compact icon. Spelling out "KEEP OPEN"
                    made this the widest control in the row and squeezed the
                    two mark buttons that are the reason the row exists — the
                    v0.9.3 layout gave MARK the full width for good reason.
                    The label lives in the tooltip; the filled/hollow square
                    carries the state, and the border colour reinforces it. */}
                <button
                  onClick={() => setPinned((p) => !p)}
                  style={{ padding: `${px(6)}px ${px(11)}px`, fontSize: fs(11), fontWeight: 700, color: pinned ? HUD.green : MUTED, background: pinned ? hexA(HUD.green, 0.14) : 'rgba(255,255,255,0.05)', border: `1px solid ${pinned ? hexA(HUD.green, 0.55) : 'rgba(150,170,180,0.35)'}`, clipPath: BTN_CLIP, cursor: 'pointer', fontFamily: 'inherit', transition: 'background 0.12s, color 0.12s' }}
                  title={`${t('overlay.keepOpen')} — ${pinned ? t('overlay.keepOpenOnHint') : t('overlay.keepOpenOffHint')}`}
                  aria-label={t('overlay.keepOpen')}
                  aria-pressed={pinned}
                >
                  {pinned ? '▣' : '▢'}
                </button>
              </div>
            </div>
          )}
          </div>
        </div>

        {/* L-brackets on all four (now square) corners — no chamfered triangles. */}
        {bracket({ top: 4, left: 4, borderTop: `1.5px solid ${FRAME}`, borderLeft: `1.5px solid ${FRAME}` })}
        {bracket({ top: 4, right: 4, borderTop: `1.5px solid ${FRAME}`, borderRight: `1.5px solid ${FRAME}` })}
        {bracket({ bottom: 4, left: 4, borderBottom: `1.5px solid ${FRAME}`, borderLeft: `1.5px solid ${FRAME}` })}
        {bracket({ bottom: 4, right: 4, borderBottom: `1.5px solid ${FRAME}`, borderRight: `1.5px solid ${FRAME}` })}

        <style>{`
          @keyframes pulse { 0%,100% { opacity: 1; } 50% { opacity: 0.35; } }
          @keyframes blinkRec { 0%,100% { opacity: 1; } 50% { opacity: 0.15; } }
          @keyframes alarm {
            0%,100% { box-shadow: 0 0 16px ${HUD.red}44; filter: brightness(1); }
            50% { box-shadow: 0 0 26px ${HUD.red}dd, 0 0 44px ${HUD.red}88; filter: brightness(1.5); }
          }
        `}</style>
      </div>
    </div>
  )
}
