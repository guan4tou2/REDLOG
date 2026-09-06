// The single wordmark REDL(●)G (docs/UIUX-STANDARD.md §4).
//
// The O is the recording indicator: a ring with a filled dot at its centre,
// like a record button. It replaces the old "image + plain text REDLOG" pair
// that §4 said was superseded eight months before this shipped — and that still
// used the softened red #cf5459 (Tailwind red-500 in this config) instead
// of the brand #d75f63.
//
// Geometry is in em so it scales with the type and never needs re-measuring
// (the hand-placed SVG wordmark broke in three places; see §16). Relative to
// the cap height: outer 0.72em, ring width 0.115em (16% of outer), inner dot
// 0.216em (30%), nudged up 0.02em. box-sizing:border-box, or content-box would
// add two ring-widths to the outer diameter. Below 16px the ring is a smudge,
// so it collapses to a solid dot (`dotOnly`). Always #d75f63 — never the danger
// red, never animated.

export function Wordmark({ className = '', dotOnly = false }: { className?: string; dotOnly?: boolean }): JSX.Element {
  const ring = dotOnly
    ? { background: 'currentColor', border: 'none' }
    : {
        border: '0.115em solid currentColor',
        // inner dot: filled circle of radius 0.108em (diameter 0.216em) centred.
        background: 'radial-gradient(circle at center, currentColor 0 0.108em, transparent 0.108em)'
      }
  return (
    <span
      className={`font-bold ${className}`}
      style={{ color: '#d75f63', letterSpacing: '0.12em', whiteSpace: 'nowrap' }}
      aria-label="REDLOG"
      role="img"
    >
      REDL
      <span
        aria-hidden
        style={{
          display: 'inline-block',
          width: '0.72em',
          height: '0.72em',
          boxSizing: 'border-box',
          borderRadius: '50%',
          position: 'relative',
          top: '-0.02em',
          margin: '0 0.03em',
          ...ring
        }}
      />
      G
    </span>
  )
}
