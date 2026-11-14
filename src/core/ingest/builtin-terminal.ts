// Which session rows are the built-in terminal's recordings (Spec 071 FR-012).
//
// A session row (`session_start` / `session_end`) names a cast by `castPath`,
// and reading that cast, replaying it or hashing it is a decision that the row
// is the built-in terminal's. Those rows are written by RedLog's own code
// (main/terminal-manager.ts), in-process. `data.source` is the producer's own
// word: any holder of the API token can post that same `source`, and a spool
// file can carry it.
//
// So for a row that carries the receiver's stamp, the stamp decides: the row
// is the terminal's when `_ingest.producer` is in-process. A row written before
// Spec 071 has no stamp, and is read as it always was, by `data.source`.
//
// The terminal's COMMAND rows are another matter: the shell hook in the pane
// posts them through the API with the same token as every other hook, so their
// stamp says `legacy` and cannot tell the pane from any other shell until the
// pane has its own credential (Phase 4, T044). Those checks still read
// `data.source`; what they lead to is read only through a session row.

// stamp.ts IN_PROCESS.producer. Not imported: stamp.ts takes the database in
// with it, and the queries that use this are part of the database layer.
const IN_PROCESS_PRODUCER = 'in-process'

/** What the terminal's own rows say in `data.source`. The one place this module
 *  spells it: the coupling baseline counts every occurrence of the name. */
const TERMINAL_SOURCE = 'builtin-terminal'

/** True when `data`, a session row's, names a recording of the built-in
 *  terminal: written in-process, or written before the stamp existed and
 *  saying so itself. */
export function isBuiltinTerminalRecording(data: Record<string, unknown>): boolean {
  if (data.source !== TERMINAL_SOURCE) return false
  if (!Object.prototype.hasOwnProperty.call(data, '_ingest')) return true
  const stamp = data._ingest
  return stamp !== null && typeof stamp === 'object' && (stamp as Record<string, unknown>).producer === IN_PROCESS_PRODUCER
}

/** isBuiltinTerminalRecording as an SQL condition on the JSON column `column`. */
export function builtinTerminalRecordingSql(column = 'data'): string {
  return `json_extract(${column},'$.source') = '${TERMINAL_SOURCE}'`
    + ` AND (json_type(${column},'$._ingest') IS NULL OR json_extract(${column},'$._ingest.producer') = '${IN_PROCESS_PRODUCER}')`
}
