// The one terminal identity of a row (Spec 071 FR-011), as `_ingest.terminal`
// records it. A module of its own, without the database, so the readers that
// need it (the causal link, the duplicate window, ingest's per-terminal state)
// do not take the database in with it.
//
// FR-011: a new row has one terminal identity, `_ingest.terminal`, and every
// reader in core that needs it derives it here. Before this the causal link
// read `terminal_id` first and the duplicate window `terminalId` first, so a
// row carrying both was two terminals at once.
//
// It is the SENDER's value in normal form, not something the receiver
// determined: a legacy item's `terminalId` is whatever its producer wrote. A
// reader must not take it as proof of which terminal produced the row.
//
// The normal form keeps distinct ids distinct and the stored value bounded in
// bytes. An id whose stored form — its JSON string, in UTF-8, which is what
// the row holds — is within TERMINAL_MAX bytes is kept verbatim: every id the
// hooks send today is (a uuid, `ps-<pid>-<guid>`), and the same id sits in
// `data` beside it, where readers join on it. A longer one is a prefix cut on a
// character boundary, `#`, and the first 16 hex of the sha256 of the whole id's
// UTF-8 bytes, within the same bound. 128 is FR-002's bound for an id a source
// supplies; 64 bits of digest make two long ids that share a prefix collide
// only by accident.

import crypto from 'node:crypto'

const TERMINAL_MAX = 128
const DIGEST_HEX = 16
const PREFIX_MAX = TERMINAL_MAX - 1 - DIGEST_HEX

/** Bytes `text` takes in the row: its JSON string form, quotes left out. */
const storedBytes = (text: string): number => Buffer.byteLength(JSON.stringify(text), 'utf8') - 2

function normalForm(id: string): string {
  if (storedBytes(id) <= TERMINAL_MAX) return id
  let prefix = ''
  let used = 0
  // By code point, so neither a surrogate pair nor a UTF-8 sequence is split.
  for (const ch of id) {
    const n = storedBytes(ch)
    if (used + n > PREFIX_MAX) break
    prefix += ch
    used += n
  }
  return `${prefix}#${crypto.createHash('sha256').update(Buffer.from(id, 'utf8')).digest('hex').slice(0, DIGEST_HEX)}`
}

function terminalValue(value: unknown): string | null {
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  if (typeof value !== 'string' || value === '') return null
  return normalForm(value)
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
