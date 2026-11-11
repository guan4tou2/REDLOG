// c2-tailers — pure parsers for C2 framework logs (SPEC-AI-ERA-PLUGINS Gap 2).
// Dependency-free CommonJS, ships inside a bundled plugin and runs shell-side
// (out-of-process), so no imports from RedLog core. Unit-tested in
// test/c2-tailers.test.ts.
//
// C2 beacons are an out-of-band channel the substrate capture never sees — the
// check-ins, task results and pivots live in the framework's own log. This maps
// a followed log line into a RedLog event (scanner.c2_checkin / c2_task /
// c2_pivot), so the operator's C2 activity lands on the same timeline as
// everything else. A pivot is `scanner.c2_pivot`, not a `pivot` event: the
// `pivot` type is RedLog's own conclusion and the local API refuses it from
// outside tools (src/core/external-event-policy.ts). Nothing here is a RedLog verdict — the fields are the
// framework's own record, recorded verbatim (DESIGN-PRINCIPLES §3).
//
// Two input shapes:
//   - 'generic': a documented RedLog-C2 JSONL contract (the pack owns it, so it
//     is stable + fully tested). Emit these from any framework's scripting.
//   - 'sliver' : best-effort mapping of Sliver session/beacon JSON objects.

'use strict'

/** Generic RedLog-C2 line → event payload, or null to skip.
 *  Contract: { kind: 'checkin'|'task'|'pivot', session, host, ... }. */
function fromGeneric(o) {
  const host = o.host || o.remote_addr || ''
  switch (o.kind) {
    case 'checkin':
    case 'session':
      return {
        agent_type: 'scanner',
        target_id: host || undefined,
        data: {
          subtype: 'c2_checkin', framework: o.framework || 'generic',
          session: o.session || o.id || '', host, detectedTarget: host || undefined,
          os: o.os || undefined, user: o.user || undefined,
          remote_addr: o.remote_addr || undefined, is_beacon: o.is_beacon === true || undefined
        }
      }
    case 'task':
      return {
        agent_type: 'scanner',
        target_id: host || undefined,
        data: {
          subtype: 'c2_task', framework: o.framework || 'generic',
          session: o.session || '', host, detectedTarget: host || undefined,
          command: o.command || '', output_len: typeof o.output_len === 'number' ? o.output_len : undefined
        }
      }
    case 'pivot': {
      const via = o.via || host
      return {
        agent_type: 'scanner',
        target_id: via || undefined,
        data: {
          subtype: 'c2_pivot', framework: o.framework || 'generic',
          state: o.closed ? 'closed' : 'open',
          session: o.session || undefined, host: host || undefined,
          via: via || undefined, detectedTarget: via || undefined, route: o.route || undefined,
          description: `C2 pivot via ${o.framework || 'c2'}${o.via ? ` → ${o.via}` : ''}`
        }
      }
    }
    default:
      return null
  }
}

/** Best-effort Sliver session/beacon object → event payload. Sliver session
 *  objects carry ID/Name/Hostname/Username/OS/RemoteAddress/IsBeacon. */
function fromSliver(o) {
  const host = o.Hostname || o.RemoteAddress || ''
  if (!o.ID && !o.Name && !host) return null
  return {
    agent_type: 'scanner',
    target_id: host || undefined,
    data: {
      subtype: 'c2_checkin', framework: 'sliver',
      session: o.Name || o.ID || '', host, detectedTarget: host || undefined,
      os: o.OS || undefined, user: o.Username || undefined,
      remote_addr: o.RemoteAddress || undefined, is_beacon: o.IsBeacon === true || undefined
    }
  }
}

/** Parse one log line for a framework. Returns an event payload or null. */
function parseC2Line(line, framework) {
  const s = String(line || '').trim()
  if (!s) return null
  let o
  try { o = JSON.parse(s) } catch { return null }
  if (!o || typeof o !== 'object') return null
  return framework === 'sliver' ? fromSliver(o) : fromGeneric(o)
}

/** Parse a whole log blob (JSONL) → event payloads, skipping junk lines. */
function parseC2Log(text, framework) {
  const out = []
  for (const line of String(text || '').split('\n')) {
    const ev = parseC2Line(line, framework)
    if (ev) out.push(ev)
  }
  return out
}

module.exports = { parseC2Line, parseC2Log, fromGeneric, fromSliver }
