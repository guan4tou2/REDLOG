// The one terminal identity of a row (Spec 071 FR-011), as `_ingest.terminal`
// records it. A module of its own, with no imports, so the readers that need
// it (the causal link, the duplicate window, ingest's per-terminal state) do
// not take the database in with it.

// FR-011: a new row has one terminal identity, `_ingest.terminal`, and every
// reader in core that needs it derives it here. Before this the causal link
// read `terminal_id` first and the duplicate window `terminalId` first, so a
// row carrying both was two terminals at once.
//
// Kept as sent apart from its length: the same id sits in `data` beside it and
// in the readers that join on it (cast replay, the built-in terminal's
// sessions), so rewriting its characters would make two ids of one. 128 is
// FR-002's bound for an id a source supplies.
const TERMINAL_MAX = 128

function terminalValue(value: unknown): string | null {
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  if (typeof value !== 'string' || value === '') return null
  if (value.length <= TERMINAL_MAX) return value
  // Never cut a surrogate pair in half: a lone surrogate is serialised
  // differently by the two verifiers.
  const cut = value.slice(0, TERMINAL_MAX)
  return /[\uD800-\uDBFF]$/.test(cut) ? cut.slice(0, -1) : cut
}

/** The terminal identity of a new row (FR-011). An item that says where it was
 *  observed (contract 1, `observed`) is taken at its word there and only
 *  there; a legacy door's item is read from `data.terminalId`, then
 *  `data.terminal_id`. Null: no terminal. */
export function terminalIdentity(data: Record<string, unknown>, observed?: { terminal?: unknown }): string | null {
  if (observed !== undefined) return terminalValue(observed.terminal)
  return terminalValue(data.terminalId) ?? terminalValue(data.terminal_id)
}

/** The terminal identity of a stored row: its stamp's. A row whose stamp has
 *  none was written before the stamp carried it (pre-071, or the first slice
 *  of Phase 3) and is read as terminalIdentity reads a legacy item — except a
 *  contract-1 row, whose stamp omits `terminal` only when none was observed. */
export function rowTerminal(data: Record<string, unknown>): string | null {
  const stamp = data._ingest
  if (stamp !== null && typeof stamp === 'object' && !Array.isArray(stamp)) {
    const { terminal, door } = stamp as Record<string, unknown>
    if (typeof terminal === 'string') return terminal
    if (door === 'api' || door === 'handoff') return null
  }
  return terminalIdentity(data)
}
