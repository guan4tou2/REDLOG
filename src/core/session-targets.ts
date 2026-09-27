// Session target (#219).
//
// The current target is one global value. With three terminals testing three
// hosts, switching it for pane 2 silently re-attributes whatever pane 1 and 3
// record next — a command with no host in it, a marker, a screenshot, a late
// command_end. So a session can carry its own target, and it outranks the
// global one.
//
// Precedence, most specific first:
//   1. the event names its own target (`target_id` on the post);
//   2. enrichment finds one in the event (a host in the command line);
//   3. the session's target — bound to a built-in terminal tab here, or set by
//      the shell itself (`REDLOG_TARGET`, sent as `data.session_target`);
//   4. the global current target.
//
// A session binding lives as long as the app does: terminal ids are not
// reused across runs, and a stale binding outliving its pane would be the
// same silent re-attribution this exists to prevent.

type EventData = Record<string, unknown>

const bindings = new Map<string, string>()

/** The session an event came from, or null when it names none. A built-in
 *  terminal pane by its id; an external shell has no stable id beyond its
 *  pid, and is bound only through REDLOG_TARGET, which travels on the event. */
export function sessionKeyOf(data: EventData): string | null {
  return typeof data.terminalId === 'string' && data.terminalId ? `terminal:${data.terminalId}` : null
}

function clean(target: unknown): string | null {
  if (typeof target !== 'string') return null
  const t = target.trim()
  return t ? t.slice(0, 253) : null
}

/** Bind (or, with null, unbind) a built-in terminal's target. Returns the
 *  previous binding so the caller can record the change. */
export function bindSessionTarget(terminalId: string, target: string | null): { previous: string | null; target: string | null } {
  const key = `terminal:${terminalId}`
  const previous = bindings.get(key) ?? null
  const next = clean(target)
  if (next) bindings.set(key, next)
  else bindings.delete(key)
  return { previous, target: next }
}

export function sessionTargetOf(terminalId: string): string | null {
  return bindings.get(`terminal:${terminalId}`) ?? null
}

/** The session's target for this event: what the shell declared on the event
 *  itself, else the binding of the pane it came from. */
export function sessionTargetFor(data: EventData): string | null {
  const declared = clean(data.session_target)
  if (declared) return declared
  const key = sessionKeyOf(data)
  return key ? bindings.get(key) ?? null : null
}

/** Forget every binding — on project close. */
export function clearSessionTargets(): void {
  bindings.clear()
}
