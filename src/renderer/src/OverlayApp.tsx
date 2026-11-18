import { useEffect, useState, useRef, useLayoutEffect } from 'react'
import { useI18n } from './i18n'
import { HUD, HUD_FONT, hexA } from './lib/hud'
import { usePivotRead } from './lib/usePivots'
import { formatTime, formatFreshness, useDisplayZone } from './lib/time'
import { useTick } from './lib/useTick'
import { hudWindowWidth, hudWindowHeight } from '../../core/overlay-layout'
import { shownIpSafety } from '../../core/alert/ip-safety'

// The simple-1112 HUD (docs/UIUX-STANDARD.md §8; design 10-hud): a near-black
// panel inside a hairline frame, four corner marks in the state colour (dashed
// while click-through is on), vertical ticks for recording and IP state. Colours
// are in lib/hud — the overlay window loads no app stylesheet.

/** The four corner marks: 10px L-shapes sitting on the 1px frame. */
const CORNERS: React.CSSProperties[] = [
  { left: -1, top: -1, borderWidth: '2px 0 0 2px' },
  { right: -1, top: -1, borderWidth: '2px 2px 0 0' },
  { left: -1, bottom: -1, borderWidth: '0 0 2px 2px' },
  { right: -1, bottom: -1, borderWidth: '0 2px 2px 0' }
]

/** Key caps shown beside the form's verbs. Not translated: both locales name
 *  these keys the same way (zh-TW strings already say "Esc"). */
const KEYCAP = { enter: '⏎', esc: 'Esc' } as const

export default function OverlayApp(): JSX.Element {
  // Another window: the display zone reaches it through `storage` (spec 038).
  useDisplayZone()
  const [status, setStatus] = useState<IPStatus | null>(null)
  const [expanded, setExpanded] = useState(false)
  // null until the main process has answered, and again if it cannot: the HUD
  // must not say "recording" before it knows.
  const [recording, setRecording] = useState<boolean | null>(null)
  const [interactive, setInteractive] = useState(false)
  const [showMark, setShowMark] = useState(true)
  const [flashExposed, setFlashExposed] = useState(true)
  const [scale, setScale] = useState(1.0)
  const [emphasizeIp, setEmphasizeIp] = useState(false)
  // Pin: when true, the expanded HUD never auto-collapses. Session-local (not
  // persisted). Toggled by "Keep expanded" in the action row. Audit finding #52.
  const [pinned, setPinned] = useState(false)
  // Pass-through visual state — dims non-critical HUD chrome while keeping the
  // external IP fully readable (user asked for exactly that: "外部IP可以保持
  // 透明度嗎"). Applied per child (`dimStyle`), never on a parent, so the IP
  // row is untouched — window opacity stays at 1 so the ip's colour isn't
  // washed out by the compositor.
  const [passThrough, setPassThrough] = useState(false)
  const [passThroughOpacity, setPassThroughOpacity] = useState(0.4)
  const pivotRead = usePivotRead()
  useTick()   // keeps "last seen" current
  const pivots = pivotRead.status === 'ready' ? pivotRead.pivots : []
  // The last list read, current or not; the expanded panel marks which.
  const listedPivots = pivotRead.pivots
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  // Inline confirmation for the instant mark. Without it the button gives no
  // sign anything happened — there is no dialog and no window change, which is
  // the entire point of it.
  const [justMarked, setJustMarked] = useState(false)
  const [markFailed, setMarkFailed] = useState<false | 'failed' | 'project-changed'>(false)
  // The "Add marker" form lives inside the HUD. `markAt` is taken at the click
  // that opened it, so the marker is timed at that moment, not at save.
  const [markOpen, setMarkOpen] = useState(false)
  const [markMore, setMarkMore] = useState(false)
  const [markTitle, setMarkTitle] = useState('')
  const [markNotes, setMarkNotes] = useState('')
  const markAtRef = useRef(0)
  const markBindRef = useRef<Promise<string | null>>(Promise.resolve(null))
  const markedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const contentRef = useRef<HTMLDivElement | null>(null)
  const { t } = useI18n()

  // Report the exact content height so the window fits it — no clipping, no
  // empty gap. Runs after every layout-affecting change.
  useLayoutEffect(() => {
    const el = contentRef.current
    if (!el) return
    const h = el.offsetHeight
    // Width tracks the clamped scale (the panel renders at the clamped scale,
    // not the raw config value) and stays inside the same band main enforces —
    // see hudWindowWidth. Height is measured; hudWindowHeight adds the chrome.
    if (h) window.redlog.overlay.autosize!(hudWindowHeight(h), hudWindowWidth(scale, emphasizeIp))
  })

  useEffect(() => {
    const cfg = window.redlog.config as {
      getPrefs?: () => Promise<unknown>
      onShowMark?: (cb: (show: boolean) => void) => () => void
      onFlashExposed?: (cb: (on: boolean) => void) => () => void
      onScale?: (cb: (s: number) => void) => () => void
      onEmphasizeIp?: (cb: (on: boolean) => void) => () => void
      onPassThrough?: (cb: (on: boolean, opacity: number) => void) => () => void
    } | undefined
    // The HUD's settings are machine-wide (main/ipc/overlay.ts), not the
    // project's: read once here, then kept current by the channels below.
    cfg?.getPrefs?.().then((p) => {
      const ov = p as { showMarkButton?: boolean; flashOnExposed?: boolean; scale?: number; emphasizeExternalIp?: boolean; passThrough?: boolean; passThroughOpacity?: number } | null
      setShowMark(ov?.showMarkButton !== false)
      setFlashExposed(ov?.flashOnExposed !== false)
      if (typeof ov?.scale === 'number' && ov.scale > 0) setScale(ov.scale)
      setEmphasizeIp(ov?.emphasizeExternalIp === true)
      setPassThrough(ov?.passThrough === true)
      if (typeof ov?.passThroughOpacity === 'number' && ov.passThroughOpacity > 0) setPassThroughOpacity(ov.passThroughOpacity)
    }).catch(() => {})
    // live-update on every change, from Settings or the HUD's own controls
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
    window.redlog.recording.get().then(setRecording).catch(() => setRecording(null))
    return window.redlog.recording.onChange(setRecording)
  }, [])


  // §8: an exposed external IP forces the HUD open and holds it — the topology
  // and last-check must be on screen for the one condition allowed to override
  // the operator's own preferences. The auto-collapse guard below keeps it open.
  useEffect(() => {
    if (status?.ipSafety === 'exposed' && !expanded) {
      setExpanded(true)
    }
  }, [status?.ipSafety])

  // §8: a 3-second hint the instant pass-through turns on, so the operator who
  // just ghosted the HUD sees the click-free way back out (⌘⇧P / menu bar)
  // before the chrome they would otherwise click is gone.
  const [ptHint, setPtHint] = useState(false)
  // The click-through explanation under the action row: only while its button
  // is hovered or focused.
  const [ptExplain, setPtExplain] = useState(false)
  const ptHintTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const ptWas = useRef(passThrough)
  useEffect(() => {
    if (passThrough && !ptWas.current) {
      setPtHint(true)
      if (ptHintTimer.current) clearTimeout(ptHintTimer.current)
      ptHintTimer.current = setTimeout(() => setPtHint(false), 3000)
    }
    ptWas.current = passThrough
  }, [passThrough])

  // Auto-collapse the expanded HUD after 8s of inactivity — but reset the
  // timer while the pointer is on the overlay so a reviewer reading the
  // topology chain / Reveal button doesn't get it yanked out from under
  // them (audit finding P1 #15). `interactive` flips true when the mouse
  // enters the overlay window (main-process tracker). An exposed IP holds it
  // open (§8) — never auto-collapse while the address is out.
  useEffect(() => {
    if (!expanded || interactive || pinned || markOpen || status?.ipSafety === 'exposed') return
    timerRef.current = setTimeout(() => collapse(), 8000)
    return () => { if (timerRef.current) clearTimeout(timerRef.current) }
  }, [expanded, interactive, pinned, markOpen, status?.ipSafety])

  // The window height follows the content through overlay:autosize, so expanding
  // is renderer state only.
  const collapse = (): void => setExpanded(false)
  // §8: while the address is exposed the details stay on screen, so the
  // collapse control does nothing then (and says why).
  const exposedNow = status?.ipSafety === 'exposed'
  const collapseBlocked = expanded && exposedNow
  const toggleExpand = (): void => { if (expanded && exposedNow) return; setExpanded(!expanded) }

  const openMarkForm = (): void => {
    markAtRef.current = Date.now()
    markBindRef.current = (window.redlog.overlay.beginMarker?.() ?? Promise.resolve(null)).catch(() => null)
    setMarkTitle(''); setMarkNotes(''); setMarkMore(false); setMarkFailed(false)
    setMarkOpen(true)
  }
  const closeMarkForm = (): void => {
    setMarkOpen(false)
    window.redlog.overlay.releaseFocus?.()
  }
  // A save in flight. The ref answers a second Enter in the same tick; the state
  // disables the button for the eye.
  const markSavingRef = useRef(false)
  const [markSaving, setMarkSaving] = useState(false)
  const saveMark = async (): Promise<void> => {
    if (markSavingRef.current) return
    markSavingRef.current = true
    setMarkSaving(true)
    try {
      await saveMarkOnce()
    } finally {
      markSavingRef.current = false
      setMarkSaving(false)
    }
  }
  const saveMarkOnce = async (): Promise<void> => {
    // A failed save keeps the form open with what was typed, and says so: it
    // must not look like a recorded marker.
    // The draft belongs to the project that was open when it was started.
    const bind = await markBindRef.current
    const r = await window.redlog.overlay.addMarker!({ title: markTitle, notes: markNotes, at: markAtRef.current, ...(bind ? { bind } : {}) }).catch(() => null)
    if (!r?.ok) { setMarkFailed(r?.reason === 'project-changed' ? 'project-changed' : 'failed'); return }
    setMarkFailed(false)
    setMarkOpen(false)
    setJustMarked(true)
    window.redlog.overlay.releaseFocus?.()
    if (markedTimerRef.current) clearTimeout(markedTimerRef.current)
    markedTimerRef.current = setTimeout(() => setJustMarked(false), 1400)
  }

  // Clamp scale to a sane band so a rogue config can't blow the HUD up beyond
  // useful. `autosize` picks up the new content height on every render so the
  // window still fits without clipping.
  const s = Math.max(0.75, Math.min(1.75, scale))
  // 11px is the HUD's text floor (UIUX-STANDARD §2 — the HUD is the one
  // exception to the app's 13px floor, because it has its own scale setting
  // and sits at arm's length). Sizes under the floor collapse onto it; the
  // hierarchy is carried by weight and colour instead.
  const HUD_MIN_PX = 11
  // fs = font-size scaler; fsIp = the external IP, with its optional emphasis.
  const fs = (n: number): number => Math.round(Math.max(n, HUD_MIN_PX) * s * 10) / 10
  const fsIp = (n: number): number => Math.round(n * s * (emphasizeIp ? 1.4 : 1) * 10) / 10
  // px() scales layout dimensions (padding, gap, separator sizes) with the
  // same factor. Without this the middle gap stays fixed while text shrinks —
  // small scale looks loose, large scale looks cramped.
  const px = (n: number): number => Math.round(n * s)

  const safety = shownIpSafety(status)
  const link = status?.link
  const linkText = link?.type === 'wifi' ? (link.name || 'Wi-Fi')
    : link?.type === 'wired' ? t('overlay.wired') : ''
  const STATE = { safe: HUD.green, exposed: HUD.danger, unknown: HUD.amber }[safety]
  const LABEL = { safe: t('overlay.safeIp'), exposed: t('overlay.exposedIp'), unknown: t('overlay.ipUnknown') }[safety]
  const STATUS_TXT = { safe: t('overlay.safeIpStatus'), exposed: t('overlay.exposedIpStatus'), unknown: t('overlay.unknownIp') }[safety]
  const exposed = safety === 'exposed'
  // The state colour of the corner marks and the relay accents.
  const FRAME = exposed ? HUD.danger : HUD.cyan
  // When EXPOSED, flash the frame as an unmissable alarm (opt-out in Settings).
  const alarm = exposed && flashExposed
  const noDrag = { WebkitAppRegion: 'no-drag' } as React.CSSProperties
  const isMac = navigator.platform?.includes('Mac')
  const ptChord = isMac ? '⌘⇧P' : 'Ctrl+Shift+P'
  const markChord = isMac ? '⌘⇧M' : 'Ctrl+Shift+M'
  // RedLog lives in the menu bar on macOS and in the tray elsewhere.
  const placeKey = (key: string): string => isMac ? key : `${key}Tray`

  // The newest by time, not by position: nothing promises the list is ordered.
  const latestPivot = pivots.reduce<(typeof pivots)[number] | undefined>((a, p) => (!a || p.ts > a.ts ? p : a), undefined)
  // A state is a 3px vertical tick beside its word — the word carries it, the
  // tick only repeats it in colour.
  const tick = (c: string): React.CSSProperties => ({ width: px(3), height: px(14), background: c, flexShrink: 0 })
  const label: React.CSSProperties = { color: HUD.muted, marginRight: px(6), flexShrink: 0 }
  // Text-styled controls: no box, a hit area as tall as the old boxed buttons.
  const textBtn: React.CSSProperties = {
    display: 'inline-flex', alignItems: 'center', gap: px(6), minHeight: px(26), padding: 0,
    fontSize: fs(12), fontFamily: 'inherit', color: 'inherit', background: 'none', border: 0, cursor: 'pointer'
  }
  const on: React.CSSProperties = { color: HUD.text, textDecoration: 'underline', textDecorationColor: FRAME, textUnderlineOffset: px(4) }
  const kbd: React.CSSProperties = { fontFamily: HUD_FONT.mono, fontSize: fs(12), color: HUD.muted }
  // The expand / hide glyphs: never smaller than the 18×16 boxes they replace.
  const iconBtn: React.CSSProperties = {
    ...textBtn, justifyContent: 'center', width: Math.max(18, px(22)), height: Math.max(18, px(24)), minHeight: 0,
    color: HUD.muted
  }
  const note: React.CSSProperties = { fontFamily: HUD_FONT.ui, fontSize: fs(12), margin: `${px(4)}px 0 0` }
  // The relay read-failure line, with its retry. A render helper, not a component.
  const pivotError = (text: string): JSX.Element => (
    <p data-testid="hud-pivot-error" style={{ ...note, color: HUD.amber, marginTop: px(10), display: 'flex', alignItems: 'center', gap: px(8) }}>
      <span>⚠ {text}</span>
      <button type="button" className="hudBtn" data-testid="hud-pivot-retry" onClick={pivotRead.retry} aria-label={t('common.retry')} title={t('common.retry')} style={{ ...noDrag, ...iconBtn, color: HUD.amber, flex: 'none' }}>↻</button>
    </p>
  )

  // Pass-through dimming — applied to individual "chrome" children instead
  // of the outer wrapper. CSS opacity on a parent forces every descendant
  // to composite at the reduced alpha, so children can never opt back to
  // opacity 1. Instead we sprinkle `...dimStyle` on non-critical rows and
  // leave the external IP row untouched, so the whole point of the HUD
  // (the IP) stays fully readable regardless of pass-through state.
  const dimStyle: React.CSSProperties = passThrough ? { opacity: passThroughOpacity } : {}
  return (
    <div
      onMouseEnter={() => window.redlog.overlay.mouseEnter!()}
      onMouseLeave={() => window.redlog.overlay.mouseLeave!()}
      style={{ width: '100%', height: '100%', padding: 3, WebkitAppRegion: 'drag', cursor: interactive ? 'grab' : 'default' } as React.CSSProperties}
    >
      {/* frame: the hairline border; the corner marks sit on it */}
      <div
        data-testid="hud-frame"
        data-state={safety}
        data-pass-through={passThrough || undefined}
        style={{
          position: 'relative', height: '100%',
          background: exposed ? HUD.panelExposed : HUD.panel,
          border: `1px solid ${exposed ? HUD.borderExposed : HUD.border}`,
          opacity: interactive ? 1 : 0.94, transition: 'opacity 0.15s',
          animation: alarm ? 'hudAlarm 0.9s ease-in-out infinite' : undefined,
          color: HUD.text, fontFamily: HUD_FONT.mono, fontVariantNumeric: 'tabular-nums', lineHeight: 1.4
        }}
      >
        {/* panel */}
        <div
          style={{
            position: 'relative', height: '100%', overflow: 'hidden',
            // Vertically centre the measured content: the window autosizes to
            // content + fixed chrome, and with the content anchored to the top
            // that chrome all fell below it (the HUD read "偏上"). Centring
            // splits it evenly. In the expanded state the content fills the
            // panel, so this is a no-op there.
            display: 'flex', flexDirection: 'column', justifyContent: 'center'
          }}
        >
          {/* measured content — window auto-sizes to this */}
          <div ref={contentRef} data-testid="hud-content">
          {/* compact bar: recording → hairline → IP state → external IP
              (largest; any relay capsule beneath it) → internal IP and network
              right-aligned. The expand / hide pair sits over the reserved right
              padding (see the cluster at the end of the panel). */}
          <div style={{ display: 'flex', alignItems: 'center', gap: px(8), padding: `${px(4)}px ${px(58)}px ${px(4)}px ${px(12)}px`, minHeight: px(40), fontSize: fs(12), lineHeight: 1.2, overflow: 'hidden' }}>
            <span style={{ display: 'flex', alignItems: 'center', gap: px(6), flexShrink: 0, ...dimStyle }}>
              <span aria-hidden="true" style={{ ...tick(recording ? HUD.red : HUD.rule), animation: recording ? 'blinkRec 1.1s step-end infinite' : undefined }} />
              <span data-testid="hud-rec" style={{ fontWeight: 600, color: recording ? HUD.recText : HUD.muted }}>{recording === null ? t('overlay.recUnknown') : recording ? t('overlay.rec') : t('overlay.paused')}</span>
            </span>
            <span aria-hidden="true" style={{ width: 1, height: px(18), background: HUD.rule, flexShrink: 0, ...dimStyle }} />
            <span style={{ display: 'flex', alignItems: 'center', gap: px(6), flexShrink: 0, ...dimStyle }}>
              <span aria-hidden="true" style={{ ...tick(STATE), animation: exposed ? 'pulse 1.4s infinite' : undefined }} />
              <span data-testid="hud-ip-state" style={{ color: STATE, fontWeight: 600 }}>{status ? LABEL : '···'}</span>
            </span>
            {/* external IP + relay capsule (left column). When the bar is short
                of room the internal column gives way first: a near-zero shrink
                factor leaves the external IP whole until the internal IP has
                ellipsized away, and only then lets it ellipsize too. */}
            <span style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: px(3), flexShrink: 0.001, minWidth: 0, overflow: 'hidden' }}>
              <span style={{ display: 'flex', alignItems: 'baseline', maxWidth: '100%' }}>
                <span style={label}>{t('overlay.ext')}</span>
                <span style={{ color: HUD.ip, fontWeight: 600, letterSpacing: '0.02em', whiteSpace: 'nowrap', fontSize: fsIp(16), overflow: 'hidden', textOverflow: 'ellipsis' }}>{status?.externalIP ?? '—'}</span>
              </span>
              {latestPivot && (
                <span
                  data-testid="hud-pivot-latest"
                  style={{ display: 'inline-flex', alignItems: 'center', gap: px(6), padding: `1px ${px(8)}px`, maxWidth: '100%', fontSize: fs(11), color: HUD.pivot, border: `1px solid ${FRAME}`, clipPath: 'polygon(5px 0,100% 0,100% calc(100% - 5px),calc(100% - 5px) 100%,0 100%,0 5px)' }}
                  title={pivots.map((p) => `${p.tool} ${p.via}${p.route ? ` (${p.route})` : ''}`).join('\n')}
                >
                  <span aria-hidden="true" style={{ color: FRAME }}>⇄</span>
                  <span style={{ maxWidth: px(120), overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{latestPivot.via}</span>
                  {pivots.length > 1 && <span style={{ color: FRAME, fontWeight: 700 }}>+{pivots.length - 1}</span>}
                </span>
              )}
            </span>
            {/* internal IP + network name (right column) */}
            <span style={{ marginLeft: 'auto', display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: px(3), minWidth: 0, flexShrink: 1, overflow: 'hidden', whiteSpace: 'nowrap', ...dimStyle }}>
              <span style={{ display: 'flex', alignItems: 'baseline', maxWidth: '100%' }}>
                <span style={label}>{t('overlay.int')}</span>
                <span style={{ color: HUD.internal, overflow: 'hidden', textOverflow: 'ellipsis' }}>{status?.internalIP ?? '—'}</span>
              </span>
              {linkText && (
                <span style={{ display: 'flex', alignItems: 'baseline', maxWidth: '100%', minWidth: 0, fontSize: fs(11), color: HUD.link }}>
                  <span style={link?.type === 'wifi' ? { marginRight: px(6), flexShrink: 0 } : label}>{link?.type === 'wifi' ? '⌁' : t('overlay.net')}</span>
                  <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{linkText}</span>
                </span>
              )}
            </span>
          </div>

          {/* expanded — fixed order: key/value → relay nodes → warning →
              marker form → actions (§8) */}
          {expanded && (
            <div style={{ padding: `${px(2)}px ${px(14)}px ${px(12)}px`, fontSize: fs(12), ...dimStyle }}>
              {/* The label column scales with the text (v0.11.1: a fixed column
                  wrapped "Last check" at scale 1.25+). The external address is
                  not repeated here: the bar shows it whole (its column gives way
                  last). Internal and network stay, because the bar can ellipsize
                  them and leaves the network out when none is known. */}
              <div style={{ display: 'grid', gridTemplateColumns: `${px(96)}px 1fr`, rowGap: px(4), alignItems: 'baseline' }}>
                <span style={{ color: HUD.muted }}>{t('overlay.status')}</span>
                <span style={{ color: STATE, fontWeight: 600 }}>{STATUS_TXT}</span>
                <span style={{ color: HUD.muted }}>{t('overlay.internal')}</span>
                <span style={{ color: HUD.value }}>{status?.internalIP ?? '—'}</span>
                <span style={{ color: HUD.muted }}>{t('overlay.network')}</span>
                <span style={{ color: HUD.value }}>{link?.type === 'wifi' ? `⌁ ${linkText}` : linkText || '—'}</span>
                <span style={{ color: HUD.muted }}>{t('overlay.lastCheck')}</span>
                <span style={{ color: HUD.value }}>{status?.lastCheck ? formatTime(status.lastCheck, { seconds: true }) : '—'}</span>
              </div>

              {/* Relay nodes seen in commands, listed — not drawn as a route. The
                  heading names the source; the list draws no arrows, no chain and
                  no tunnel health, which is what keeps it from claiming more
                  (UX-005). A failed read says so instead of looking like "none":
                  with no list it stands alone; with the last list kept it sits
                  under the heading, so "could not read" has its object, and only
                  the rows dim. */}
              {pivotRead.status === 'error' && listedPivots.length === 0 && pivotError(t('pivot.readFailed'))}
              {listedPivots.length > 0 && (
                <div data-testid="hud-pivot-nodes" data-stale={pivotRead.status === 'error' || undefined}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: px(8), margin: `${px(12)}px 0 ${px(6)}px`, color: HUD.section }}>
                    <span>⇄ {t('pivot.detected', { count: listedPivots.length })}</span>
                    <span aria-hidden="true" style={{ flex: 1, height: 1, background: HUD.sectionRule }} />
                  </div>
                  {pivotRead.status === 'error' && pivotError(t('overlay.relayReadFailedStale', { count: listedPivots.length }))}
                  <div style={pivotRead.status === 'error' ? { opacity: 0.55, marginTop: px(6) } : undefined}>
                    {listedPivots.map((p) => {
                      const seen = t('pivot.lastSeen', { when: formatFreshness(p.ts, t) })
                      return (
                        <div key={p.via + p.tool + p.ts} style={{ display: 'grid', gridTemplateColumns: `${px(72)}px minmax(0, 1fr) auto`, columnGap: px(10), padding: `${px(4)}px ${px(8)}px`, marginBottom: px(4), borderLeft: `2px solid ${FRAME}`, background: HUD.nodeBg }}>
                          <span style={{ color: HUD.muted, overflowWrap: 'anywhere' }}>{p.tool}</span>
                          <span style={{ color: HUD.value, fontWeight: 600, overflowWrap: 'anywhere' }}>{p.via}</span>
                          <span style={{ color: HUD.muted }} title={seen} aria-label={seen}>{formatFreshness(p.ts, t)}</span>
                          {p.route && (
                            <span style={{ gridColumn: '2 / -1', overflowWrap: 'anywhere' }}>
                              <span style={label}>{t('overlay.relayRoute')}</span>
                              <span style={{ color: HUD.internal }}>{p.route}</span>
                            </span>
                          )}
                        </div>
                      )
                    })}
                  </div>
                </div>
              )}

              {/* warning line: an unclassified IP, or the IP read's own error */}
              {safety === 'unknown' && (
                <p style={{ ...note, color: HUD.amber, marginTop: px(10) }}>ⓘ {t('overlay.unknownHint', { page: t('settings.pageNetwork') })}</p>
              )}
              {status?.error && <p style={{ ...note, color: HUD.amber, marginTop: px(10) }}>{status.error}</p>}

              {/* One way to add a marker. The click opens a small form here in
                  the HUD: the time is the click's, the title is optional, Enter
                  or "Save marker" finishes, Esc cancels, and "More" adds notes.
                  The global shortcut opens the full dialog. */}
              {showMark && markOpen && (
                <form
                  data-testid="hud-marker-form"
                  className="hudForm"
                  style={{ ...noDrag, marginTop: px(10), padding: `${px(4)}px ${px(10)}px`, border: `1px solid ${HUD.border}` }}
                  onSubmit={(e) => { e.preventDefault(); void saveMark() }}
                  onKeyDown={(e) => { if (e.key === 'Escape') { e.preventDefault(); closeMarkForm() } }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: px(8) }}>
                    <span aria-hidden="true" style={{ color: HUD.red }}>⚑</span>
                    <input
                      data-testid="hud-marker-title"
                      autoFocus
                      value={markTitle}
                      onChange={(e) => setMarkTitle(e.target.value)}
                      placeholder={t('overlay.markTitlePlaceholder')}
                      aria-label={t('overlay.markTitlePlaceholder')}
                      style={{ flex: 1, minWidth: 0, height: px(26), padding: 0, fontSize: fs(12), color: HUD.text, caretColor: HUD.red, background: 'transparent', border: 0, outline: 'none', fontFamily: 'inherit' }}
                    />
                  </div>
                  {markMore && (
                    <textarea
                      data-testid="hud-marker-notes"
                      value={markNotes}
                      onChange={(e) => setMarkNotes(e.target.value)}
                      placeholder={t('overlay.markNotesPlaceholder')}
                      aria-label={t('overlay.markNotesPlaceholder')}
                      rows={3}
                      style={{ display: 'block', width: '100%', padding: `${px(4)}px 0`, fontSize: fs(12), color: HUD.text, caretColor: HUD.red, background: 'transparent', border: 0, borderTop: `1px solid ${HUD.border}`, outline: 'none', resize: 'none', fontFamily: 'inherit' }}
                    />
                  )}
                  {markFailed && (
                    <p role="alert" data-testid="hud-marker-failed" style={{ ...note, color: HUD.red }}>{`✕ ${markFailed === 'project-changed' ? t('overlay.markProjectChanged') : t('overlay.markFailed')}`}</p>
                  )}
                  <div style={{ display: 'flex', alignItems: 'center', gap: px(8), color: HUD.muted }}>
                    {!markMore && (
                      <button type="button" className="hudBtn" data-testid="hud-marker-more" onClick={() => setMarkMore(true)} style={textBtn}>
                        {t('overlay.markMore')} <span aria-hidden="true">›</span>
                      </button>
                    )}
                    <span style={{ flex: 1 }} />
                    <button type="submit" className="hudBtn" data-testid="hud-marker-save" disabled={markSaving} style={{ ...textBtn, color: HUD.action, opacity: markSaving ? 0.5 : 1, cursor: markSaving ? 'default' : 'pointer' }}>
                      {t('overlay.markSave')} <kbd style={kbd}>{KEYCAP.enter}</kbd>
                    </button>
                    <span aria-hidden="true">·</span>
                    <button type="button" className="hudBtn" data-testid="hud-marker-cancel" onClick={closeMarkForm} style={textBtn}>
                      {t('common.cancel')} <kbd style={kbd}>{KEYCAP.esc}</kbd>
                    </button>
                  </div>
                </form>
              )}

              {/* The action row: a quiet line of words, not boxes. */}
              <div style={{ ...noDrag, display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: `0 ${px(16)}px`, marginTop: px(12), paddingTop: px(4), borderTop: `1px solid ${HUD.border}`, color: HUD.action }}>
                {showMark && !markOpen && (
                  <button
                    type="button"
                    className="hudBtn"
                    data-testid="hud-add-marker"
                    onClick={openMarkForm}
                    style={{ ...textBtn, ...(justMarked ? { color: HUD.green } : {}) }}
                    title={t('overlay.addMarkerHint')}
                  >
                    {justMarked ? `✓ ${t('overlay.marked')}` : t('overlay.addMarker')}
                    {!justMarked && <kbd style={kbd}>{markChord}</kbd>}
                  </button>
                )}
                {/* Pass-through (§8): the way IN to ghost mode. Once on, the HUD
                    is click-through so this button cannot turn it off; the way
                    back is the shortcut or the menu bar (both wired in main),
                    so the tooltip and the line below name it BEFORE it is
                    pressed — the line appears under the row while the button is
                    hovered or focused (owner, 2026-11-18: not always on). The
                    chord only releases, so it is not shown as this button's
                    shortcut. */}
                <button
                  type="button"
                  className="hudBtn"
                  data-testid="hud-pass-through"
                  onClick={() => window.redlog.overlay.setPassThrough!(true)}
                  onMouseEnter={() => setPtExplain(true)}
                  onMouseLeave={() => setPtExplain(false)}
                  onFocus={() => setPtExplain(true)}
                  onBlur={() => setPtExplain(false)}
                  aria-describedby={ptExplain ? 'hud-pt-explain' : undefined}
                  style={textBtn}
                  title={`${t('overlay.passThrough')} — ${t(placeKey('overlay.passThroughHint'), { chord: ptChord })}`}
                >
                  {t('overlay.passThrough')}
                </button>
                {/* Keep expanded: controls the 8s auto-collapse. The box glyph
                    carries the state in words, not only the underline. */}
                <button
                  type="button"
                  className="hudBtn"
                  data-testid="hud-keep-open"
                  onClick={() => setPinned((p) => !p)}
                  style={{ ...textBtn, ...(pinned ? on : {}) }}
                  title={pinned ? t('overlay.keepOpenOnHint') : t('overlay.keepOpenOffHint')}
                  aria-pressed={pinned}
                >
                  {pinned ? '☑' : '☐'} {t('overlay.keepOpen')}
                </button>
              </div>
              {ptExplain && (
                <p id="hud-pt-explain" data-testid="hud-pass-through-hint" style={{ ...noDrag, ...note, color: HUD.muted }}>
                  {t(placeKey('overlay.passThroughHint'), { chord: ptChord })}
                </p>
              )}
            </div>
          )}
          </div>

          {/* buttons (bar, right end): expand + hide only.

              Rendered LAST inside the panel, and it has to stay last. Chromium
              inherits `-webkit-app-region`, so every descendant of the dragging
              root declares `drag` too, and Electron replays those rects in tree
              order — union for drag, difference for no-drag. A `drag` rect that
              comes after this cluster and overlaps it hands the area back to the
              window, and the compact bar (full width, the button row's own row)
              did exactly that: WM_NCHITTEST over ✕ answered HTCAPTION, so every
              click started a window drag and the HUD could only be moved.
              Playwright cannot see this — CDP clicks are delivered straight to
              the renderer, below the hit test — so the guard is the region-order
              test in renderer-smoke.

              Placed over the bar's reserved right padding, centred on its
              minimum height (the content starts 5px down: hudWindowHeight's
              chrome less the 3px root padding and 1px frame, split in two). */}
          <div style={{ position: 'absolute', top: 5 + Math.round((px(40) - Math.max(18, px(24))) / 2), right: px(8), display: 'flex', alignItems: 'center', gap: px(2), ...noDrag, ...dimStyle }}>
            {/* Real <button>s, not onClick divs: keyboard-reachable and
                announced as controls (§21 — icon-only controls must be
                focusable; the focus ring is the .hudBtn rule below). */}
            <button data-testid="hud-expand" type="button" aria-disabled={collapseBlocked ? true : undefined} className="hudBtn" onClick={toggleExpand} style={{ ...iconBtn, ...(collapseBlocked ? { opacity: 0.45, cursor: 'default' } : {}) }} title={expanded ? (exposedNow ? t('overlay.collapseBlocked') : t('overlay.collapse')) : t('overlay.expand')} aria-label={expanded ? t('overlay.collapse') : t('overlay.expand')}>{expanded ? '▲' : '▼'}</button>
            <button data-testid="hud-hide" type="button" className="hudBtn" onClick={() => window.redlog.overlay.hide()} style={iconBtn} title={t(placeKey('overlay.hide'))} aria-label={t(placeKey('overlay.hide'))}>✕</button>
          </div>
        </div>

        {/* §8 pass-through hint — opaque and outside the dimmed chrome so it
            stays readable exactly when everything else has just gone ghost.
            Auto-hides after 3s (ptHint effect). */}
        {ptHint && (
          <div style={{ position: 'absolute', left: 0, right: 0, bottom: px(6), display: 'flex', justifyContent: 'center', pointerEvents: 'none', zIndex: 30, ...noDrag }}>
            <span data-testid="hud-pass-through-active" style={{ padding: `${px(2)}px ${px(10)}px`, fontFamily: HUD_FONT.ui, fontSize: fs(11), color: HUD.text, background: HUD.panelSolid, border: `1px solid ${HUD.cyan}` }}>
              {t(placeKey('overlay.passThroughActive'), { chord: ptChord })}
            </span>
          </div>
        )}

        {/* corner marks: the state colour; dashed while click-through is on */}
        {CORNERS.map((pos, i) => (
          <span key={i} aria-hidden="true" data-testid="hud-corner" style={{ position: 'absolute', width: 10, height: 10, borderStyle: passThrough ? 'dashed' : 'solid', borderColor: FRAME, pointerEvents: 'none', ...noDrag, ...pos }} />
        ))}

        <style>{`
          /* §21: every HUD control shows a focus ring. The controls are bare
             text, so the ring is an outline in the frame colour. */
          .hudBtn:focus-visible { outline: 2px solid ${hexA(HUD.cyan, 0.8)}; outline-offset: 1px; }
          .hudBtn:not([aria-disabled]):not(:disabled):hover { color: ${HUD.text} !important; }
          .hudForm:focus-within { border-color: ${hexA(HUD.cyan, 0.6)} !important; }
          .hudForm input::placeholder, .hudForm textarea::placeholder { color: ${HUD.muted}; }
          @keyframes pulse { 0%,100% { opacity: 1; } 50% { opacity: 0.35; } }
          @keyframes blinkRec { 0%,100% { opacity: 1; } 50% { opacity: 0.15; } }
          @keyframes hudAlarm { 0%,100% { border-color: ${HUD.borderExposed}; } 50% { border-color: ${HUD.danger}; } }
        `}</style>
      </div>
    </div>
  )
}
