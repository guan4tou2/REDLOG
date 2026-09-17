// Tier classifier badge — v0.13.0 introduced the split; v0.13.1 shipped it in the
// detail panel only; v0.14 §9.1 promotes it to per-row so reviewers scanning
// the timeline can see the classifier at a glance. Two variants share the
// same semantics and tooltip; `row` is icon-only for visual density, `detail`
// is the full chip. Rendered for BOTH tiers by design — a reviewer needs to
// see "this row is chained" as much as "this row is logged"; the design doc
// (docs/DESIGN-two-tier-chain.md §9.1) calls out that dropping the chained
// glyph would hide the classifier from most of the timeline.

export const TIER_TOOLTIPS = {
  chained: 'Chained tier — audit chain. SHA-256-linked to the previous row, Ed25519-signed by the operator key, and covered by the OTS anchor.',
  logged: 'Logged tier — supporting evidence. Not hash-chained, not signed, not covered by the OTS anchor. Retention policy deletes rows past keepDays. See docs/DESIGN-two-tier-chain.md.'
} as const

export function TierBadge({ tier, variant, show = true }: {
  tier?: 'chained' | 'logged'
  variant: 'row' | 'detail'
  /** §22: a project that has only ever had one tier gains nothing from being
   *  told which one. Gates the DETAIL chip only — the row spacer stays
   *  unconditional, so the densest view on screen does not reflow sideways the
   *  moment the first logged row lands. */
  show?: boolean
}): JSX.Element | null {
  // Rows written before v0.13.0 have no tier field; treat them as chained
  // (the historical default) so the migration doesn't paint them a different
  // colour than what the audit chain actually contains.
  const t: 'chained' | 'logged' = tier === 'logged' ? 'logged' : 'chained'
  const glyph = t === 'logged' ? '⌇' : '⛓'
  if (variant === 'row') {
    // Exception reporting (UIUX-STANDARD §5.2). Chained is what 99%+ of rows
    // are, so it is the default and draws nothing: the previous rendering put
    // a glyph on every row at 1.7:1 against the background, which paid the
    // layout cost of a column without being visible enough to convey anything.
    // Only the exception is marked, and it is marked legibly.
    if (t === 'chained') {
      return <span className="w-3 shrink-0" title={TIER_TOOLTIPS.chained} aria-label="tier: chained" />
    }
    return (
      <span
        className="font-mono text-xs shrink-0 text-redlog-text-dim"
        title={TIER_TOOLTIPS.logged}
        aria-label="tier: logged"
      >
        {glyph}
      </span>
    )
  }
  // Detail-panel chip: icon + label, matches the surrounding badge stack.
  if (!show) return null
  return (
    <span
      className={`text-xs font-mono px-1.5 py-0.5 rounded ${
        t === 'logged' ? 'text-redlog-text-dim bg-redlog-elevated/60' : 'text-redlog-text-faint bg-redlog-elevated/40'
      }`}
      title={TIER_TOOLTIPS[t]}
    >
      {glyph} {t}
    </span>
  )
}
