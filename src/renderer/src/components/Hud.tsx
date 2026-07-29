import type { ReactNode } from 'react'
import { HUD, hexA, CHAMFER } from '../lib/hud'

type Tone = 'cyan' | 'red' | 'green' | 'amber' | 'neutral'

const TONE: Record<Tone, string> = {
  cyan: HUD.cyan, red: HUD.red, green: HUD.green, amber: HUD.amber, neutral: '#3a3a3d'
}

// A chamfered HUD panel with angular corner brackets (framing without enclosing
// = "active scan"). Content-driven height. Used for status surfaces; work
// surfaces stay flat. Keep it calm — brackets + a hairline edge, glow only when
// `live`, no scanlines unless asked. Tuned desaturated tones (see lib/hud).
export function HudPanel({
  tone = 'cyan', live = false, scan = false, className = '', style, children
}: {
  tone?: Tone
  live?: boolean
  scan?: boolean
  className?: string
  style?: React.CSSProperties
  children: ReactNode
}): JSX.Element {
  const c = TONE[tone]
  const brk = (pos: React.CSSProperties): JSX.Element => (
    <span style={{ position: 'absolute', width: 8, height: 8, pointerEvents: 'none', ...pos }} />
  )
  return (
    <div
      className={className}
      style={{ position: 'relative', clipPath: CHAMFER, background: hexA(c, 0.30), padding: 1, boxShadow: live ? `0 0 14px ${hexA(c, 0.14)}` : undefined, ...style }}
    >
      <div style={{ position: 'relative', clipPath: CHAMFER, background: '#121216', overflow: 'hidden' }}>
        {scan && (
          <div style={{ position: 'absolute', inset: 0, pointerEvents: 'none', background: `repeating-linear-gradient(0deg, ${hexA(c, 0.035)} 0px, ${hexA(c, 0.035)} 1px, transparent 1px, transparent 3px)`, opacity: 0.6 }} />
        )}
        <div style={{ position: 'relative', zIndex: 1 }}>{children}</div>
      </div>
      {brk({ top: 3, left: 3, borderTop: `1.5px solid ${c}`, borderLeft: `1.5px solid ${c}` })}
      {brk({ top: 3, right: 3, borderTop: `1.5px solid ${c}`, borderRight: `1.5px solid ${c}` })}
      {brk({ bottom: 3, left: 3, borderBottom: `1.5px solid ${c}`, borderLeft: `1.5px solid ${c}` })}
      {brk({ bottom: 3, right: 3, borderBottom: `1.5px solid ${c}`, borderRight: `1.5px solid ${c}` })}
    </div>
  )
}

// Small uppercase HUD section label with a leading glyph.
export function HudLabel({ children, tone = 'cyan', glyph }: { children: ReactNode; tone?: Tone; glyph?: string }): JSX.Element {
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, color: TONE[tone], fontSize: 10, fontWeight: 600, letterSpacing: '0.12em', textTransform: 'uppercase' }}>
      {glyph && <span style={{ textShadow: `0 0 6px ${hexA(TONE[tone], 0.4)}` }}>{glyph}</span>}
      {children}
    </span>
  )
}
