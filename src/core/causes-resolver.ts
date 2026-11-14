import path from 'node:path'
import { compareCodeUnits } from './code-unit-order'
import { terminalIdentity } from './ingest/terminal'
import { fieldText } from './ingest/field-text'
import type { StoredCommand } from './db/stored-links'

// v0.6.89 P0-A: `_causes` upstream-event lookup for events that arrive via
// /api/events (or any other post-hoc insertion path). Each event pair follows
// a "start emits linker; end refers to linker" pattern:
//
//   http_request_start (flow_id) → http_response / http_error / http_request_dropped
//   shell.command_start (terminal_id + pid, or command text if pid is unset)
//     → shell.command_end
//
// When a "start" event is inserted, `noteStartEvent(agentType, data, eventId)`
// caches the linker → event id. When an "end" event is inserted,
// `resolveIncomingCauses(agentType, data)` reads the cache and returns the
// upstream event id(s) to stamp into `data._causes`.
//
// The cache is bounded — evict the oldest entry when the map hits capacity so
// a long-running instance doesn't leak. TTL is not tracked; the mitmproxy
// addon caps flows at 5 min and shell command lifetime is bounded by the
// operator's terminal session, so eviction by size is enough.
//
// The cache is the fast path, not the record. When it has nothing for a
// command id or a flow id — the app restarted since the start, or the entry
// was evicted — the caller's `stored` answers from the project's rows by the
// same id (db/stored-links.ts), and the answer is the one the cache would have
// given had it never been lost (Spec 071 SC-003). What it finds is put back in
// the cache, so the rest of that command's rows are hits again.

const MAX_ENTRIES = 10_000

class BoundedMap<V> {
  private m = new Map<string, V>()
  set(key: string, value: V): void {
    if (this.m.has(key)) this.m.delete(key)
    this.m.set(key, value)
    if (this.m.size > MAX_ENTRIES) {
      const oldest = this.m.keys().next().value as string | undefined
      if (oldest) this.m.delete(oldest)
    }
  }
  get(key: string): V | undefined { return this.m.get(key) }
  delete(key: string): void { this.m.delete(key) }
  size(): number { return this.m.size }
  values(): V[] { return [...this.m.values()] }
  clear(): void { this.m.clear() }
}

// flow_id → http_request_start event id
const httpFlowMap = new BoundedMap<string>()

// `${terminalId}|${pid}|${command}` → shell.command_start event id
const shellStartMap = new BoundedMap<string>()

// `command_id` → shell.command_start event id. Spec 052: the adapter mints one
// key per command and every row of that command carries it, so correlation is
// an identity rather than a guess. The text key above cannot tell two runs of
// `whoami` in one terminal apart, and once output arrives as its own rows the
// difference stops being academic — a chunk would attach to the wrong command.
// It is also the ONLY thing consulted for a chunk: the bytes are output from
// something hostile, and anything read out of them is attacker-controlled
// (FR-002).
const commandIdMap = new BoundedMap<string>()

// `command_id` → command_start event id, for commands whose `command_end` said
// `late_output: true`: a background job still holds the terminal, and what it
// prints from now on arrives as `command_output` rows after the command ended.
// Those rows belong to that command — attributed by the pty pair the relay
// opened for it, which is an identity, not by anything read from the bytes —
// so the id is kept until the relay's `final` row says the job is done. Kept
// apart from `commandIdMap` so a command that really ended stays ended: a
// chunk for it is still `unattributed`, not a reopened command.
const lateCommandIdMap = new BoundedMap<string>()
// Command ids whose chunks memory knows belong to no open command: no start
// was stored, the end did not say a job keeps printing, or a `final` chunk
// came. Without it, every such chunk — a stream the relay sends once a second —
// asked the database again. Forgotten when a start with that id is stored
// (noteStartEvent) and with the project (resetCausesResolver).
const closedCommandIds = new BoundedMap<true>()
type CommandCorrelation = { eventId: string; cwd: string; endedAt?: number }
export type RelatedCommandCandidate = {
  event_id: string
  method: 'cwd-overlap' | 'cwd-near-command-end'
  state: 'active' | 'recent'
}
const activeShellCommands = new BoundedMap<CommandCorrelation>()
const recentShellCommands = new BoundedMap<CommandCorrelation>()
const RECENT_COMMAND_GRACE_MS = 2_000

/** The command id of a row: the `command_id` string exactly as sent. The
 *  stored lookup (db/stored-links.ts) compares the same string, so memory and
 *  the rows agree on what one command is. Nothing sends it with whitespace or
 *  as `commandId`; an id that is not a non-empty string is no id. */
export function commandIdOf(data: Record<string, unknown>): string | null {
  const value = data.command_id
  return typeof value === 'string' && value !== '' ? value : null
}

function shellKey(data: Record<string, unknown>): string | null {
  // FR-011: derived from `data` by the one function the stamp's `terminal` is
  // written by, not by this module's own reading of the two fields (it used to
  // take `terminal_id` first, the duplicate window `terminalId` first).
  const tid = terminalIdentity(data) ?? ''
  const pid = fieldText(data.pid) ?? ''
  const cmd = fieldText(data.command) ?? ''
  if (!cmd) return null
  // (tid,pid) uniquely identifies a live command within a terminal. If both
  // are absent (external agents), fall back to command text alone — coarser
  // but still useful (agents rarely run the same command twice in 2s).
  return `${tid}|${pid}|${cmd}`
}

/**
 * Called AFTER an event lands in the DB. If it's a "start" event (that later
 * "end" events will want to cite as their cause), stash its id in the cache.
 */
export function noteStartEvent(agentType: string, data: Record<string, unknown>, eventId: string): void {
  if (agentType === 'scanner' && data.subtype === 'http_request_start' && typeof data.flow_id === 'string') {
    httpFlowMap.set(data.flow_id, eventId)
    return
  }
  if (agentType === 'shell' && data.subtype === 'command_start') {
    const commandId = commandIdOf(data)
    if (commandId) { commandIdMap.set(commandId, eventId); closedCommandIds.delete(commandId) }
    const key = shellKey(data)
    if (key) {
      shellStartMap.set(key, eventId)
      if (typeof data.cwd === 'string' && data.cwd.trim()) {
        activeShellCommands.set(key, { eventId, cwd: path.resolve(data.cwd) })
      }
    }
    return
  }
}

/** The project's rows, for when the cache has nothing (see the header).
 *  Handed in by ingest, so this module stays free of the database. */
export interface StoredLinks {
  command: (commandId: string) => StoredCommand | null
  /** The rowid of the newest final chunk of `commandId` after rowid `after`. */
  lastFinal: (commandId: string, after: number) => number | null
  openFlowStart: (flowId: string) => string | null
}

/**
 * Called BEFORE insertEvent for an "end" event. Returns the upstream event
 * id(s) to add to `data._causes`. Empty array when no upstream is known
 * (e.g. we started recording mid-flow).
 *
 * What the row does to the links — a response closing its flow, an end closing
 * its command, a final chunk closing its job — is handed to `settle`, which
 * ingest runs only once the row is stored: a row refused (paused, unrecorded,
 * a duplicate) was never recorded, and the record must still read as if it
 * had not come, which is what the stored rows will say after a restart.
 * Without `settle` it is done at once. The cwd hint below
 * (`activeShellCommands`) is settled at once either way: it is no link, and a
 * command that ended while paused must not be offered as still running.
 */
export function resolveIncomingCauses(agentType: string, data: Record<string, unknown>, stored?: StoredLinks, settle?: (change: () => void) => void): string[] {
  const later = settle ?? ((change: () => void) => change())
  if (agentType === 'scanner') {
    const sub = data.subtype
    if ((sub === 'http_response' || sub === 'http_error' || sub === 'http_request_dropped') && typeof data.flow_id === 'string') {
      const flowId = data.flow_id
      let id = httpFlowMap.get(flowId)
      if (!id && stored) {
        id = stored.openFlowStart(flowId) ?? undefined
        if (id) httpFlowMap.set(flowId, id)
      }
      if (id) {
        // Only clear on response — dropped/error might reference a flow that
        // still receives a real response later (rare but possible via retry).
        if (sub === 'http_response') later(() => httpFlowMap.delete(flowId))
        return [id]
      }
    }
    return []
  }
  // A chunk belongs to its command or to nothing. No fall-back to the text
  // key: a chunk has no command text of its own, and matching on the bytes is
  // the one thing this contract forbids. An empty result is how ingest knows
  // to mark it `unattributed` rather than attach it somewhere plausible.
  if (agentType === 'shell' && data.subtype === 'command_output') {
    const commandId = commandIdOf(data)
    if (!commandId) return []
    const id = commandIdMap.get(commandId) ?? lateCommandIdMap.get(commandId)
      ?? (closedCommandIds.get(commandId) ? undefined : storedChunkCommand(commandId, stored))
    // The relay's last row for this command: nothing more will arrive, so the
    // id is released.
    if (data.final === true) {
      later(() => {
        lateCommandIdMap.delete(commandId)
        if (!commandIdMap.get(commandId)) closedCommandIds.set(commandId, true)
      })
    }
    return id ? [id] : []
  }
  if (agentType === 'shell' && data.subtype === 'command_end') {
    const commandId = commandIdOf(data)
    const key = shellKey(data)
    // The cwd hint settles now, recorded or not.
    if (key) {
      const active = activeShellCommands.get(key)
      activeShellCommands.delete(key)
      if (active) recentShellCommands.set(key, { ...active, endedAt: Date.now() })
    }
    if (commandId) {
      const id = commandIdMap.get(commandId) ?? storedOpenCommand(commandId, stored)
      if (id) {
        // The contract puts `command_end` after the last chunk, so the id has
        // done its work; a chunk arriving after this is late by definition
        // and is recorded as unattributed rather than reopening the command —
        // unless the relay said at the time that a background job would keep
        // printing, in which case the late chunks are that command's.
        const late = data.late_output === true || data.output_streamed === true
        later(() => {
          commandIdMap.delete(commandId)
          if (late) { lateCommandIdMap.set(commandId, id); closedCommandIds.delete(commandId) } else closedCommandIds.set(commandId, true)
          if (key) shellStartMap.delete(key)
        })
        return [id]
      }
    }
    if (key) {
      const id = shellStartMap.get(key)
      if (id) {
        later(() => shellStartMap.delete(key))
        return [id]
      }
    }
    return []
  }
  return []
}

/** The start of command `commandId` that no command_end has closed yet, as
 *  `commandIdMap` would hold it. */
function storedOpenCommand(commandId: string, stored: StoredLinks | undefined): string | undefined {
  const command = stored?.command(commandId)
  return command?.start && !command.end ? command.start.id : undefined
}

/** The command a chunk belongs to, as the maps would hold it: still running
 *  (`commandIdMap`), or ended saying a background job keeps printing with no
 *  final chunk since (`lateCommandIdMap`). Otherwise the id goes in
 *  `closedCommandIds`, so the next chunk does not ask again. What is found
 *  is the stored record, so it is kept whether or not this chunk is. */
function storedChunkCommand(commandId: string, stored: StoredLinks | undefined): string | undefined {
  if (!stored) return undefined
  const command = stored.command(commandId)
  const start = command?.start
  const end = command?.end
  if (start && !end) {
    commandIdMap.set(commandId, start.id)
    return start.id
  }
  // The newest final chunk of this round, asked from its start as ingest asks
  // it (one seek between the two); a final before the end closed nothing.
  const finalAt = start && end?.lateOutput ? stored.lastFinal(commandId, start.rowid) : null
  if (start && end?.lateOutput && (finalAt === null || finalAt < end.rowid)) {
    lateCommandIdMap.set(commandId, start.id)
    return start.id
  }
  closedCommandIds.set(commandId, true)
  return undefined
}

/** Cwd/time overlap is an investigation hint, not proof that a process wrote
 * a file. Keep it out of `_causes` and retain every plausible candidate. */
export function relatedCommandCandidates(data: Record<string, unknown>, now = Date.now()): RelatedCommandCandidate[] {
  if (data.source !== 'file-watcher') return []
  if ((data.subtype !== 'file_created' && data.subtype !== 'file_modified')
    || data.is_dir === true || typeof data.path !== 'string') return []
  const filePath = path.resolve(data.path)
  const inside = ({ cwd }: CommandCorrelation): boolean => {
    const relative = path.relative(cwd, filePath)
    return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
  }
  const active = activeShellCommands.values()
    .filter(inside)
    .map(({ eventId, cwd }) => ({ eventId, cwd, method: 'cwd-overlap' as const, state: 'active' as const }))
  const recent = recentShellCommands.values()
    .filter((candidate) => candidate.endedAt != null && now - candidate.endedAt <= RECENT_COMMAND_GRACE_MS && inside(candidate))
    .map(({ eventId, cwd }) => ({ eventId, cwd, method: 'cwd-near-command-end' as const, state: 'recent' as const }))
  return [...active, ...recent]
    .sort((a, b) => b.cwd.length - a.cwd.length || compareCodeUnits(a.eventId, b.eventId))
    .map(({ eventId, method, state }) => ({ event_id: eventId, method, state }))
}

/** Clear process-local correlation state when an engagement closes. */
export function resetCausesResolver(): void {
  httpFlowMap.clear()
  shellStartMap.clear()
  commandIdMap.clear()
  lateCommandIdMap.clear()
  closedCommandIds.clear()
  activeShellCommands.clear()
  recentShellCommands.clear()
}

/** Test alias. */
export const _resetCausesResolver = resetCausesResolver
