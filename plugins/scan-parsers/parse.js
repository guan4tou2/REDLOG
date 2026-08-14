// scan-parsers — pure parsers for structured scanner output (SPEC-AI-ERA-PLUGINS
// Gap 1). Self-contained CommonJS, ZERO dependencies: this module ships inside a
// bundled plugin and runs in the operator's shell (out-of-process), so it can't
// import from RedLog's src/core. Kept pure + unit-tested (test/scan-parsers.test.ts).
//
// Each parser turns a tool's structured output into normalized `scan_result`
// events. The captured facts (host, port, service, template id, the tool's own
// severity label) are recorded verbatim; RedLog adds no interpretation of its
// own here — severity is "what the tool reported", not a RedLog verdict.

'use strict'

/** Parse nmap greppable output (`nmap -oG -`). One record per host, with its
 *  open ports. Malformed / comment lines are skipped, never thrown on. */
function parseNmapGreppable(text) {
  const hosts = []
  for (const line of String(text || '').split('\n')) {
    if (!line.startsWith('Host: ')) continue
    // Host: 10.0.0.5 (name)\tPorts: 22/open/tcp//ssh//OpenSSH//, 80/open/tcp//http//nginx//\tStatus: Up
    const hostMatch = line.match(/^Host:\s+(\S+)\s+\(([^)]*)\)/)
    if (!hostMatch) continue
    const host = hostMatch[1]
    const hostname = hostMatch[2] || ''
    const portsSeg = line.split(/\tPorts:\s*/)[1]
    const ports = []
    if (portsSeg) {
      for (const spec of portsSeg.split(',')) {
        // port/state/proto/owner/service/rpc/version/
        const parts = spec.trim().split('/')
        if (parts.length < 3) continue
        const portNum = parseInt(parts[0], 10)
        if (!Number.isFinite(portNum)) continue
        const state = parts[1] || ''
        if (state !== 'open') continue   // only surface open ports
        ports.push({
          port: portNum,
          proto: parts[2] || '',
          service: parts[4] || '',
          version: (parts[6] || '').trim()
        })
      }
    }
    hosts.push({ host, hostname, ports })
  }
  return hosts
}

/** Parse nuclei JSON-lines output (`nuclei -jsonl` / `-json`). One record per
 *  finding. Skips blank / unparseable lines. */
function parseNucleiJsonl(text) {
  const out = []
  for (const line of String(text || '').split('\n')) {
    const s = line.trim()
    if (!s) continue
    let obj
    try { obj = JSON.parse(s) } catch { continue }
    if (!obj || typeof obj !== 'object') continue
    const info = obj.info || {}
    out.push({
      templateId: obj['template-id'] || obj.templateID || '',
      name: info.name || '',
      severity: info.severity || 'unknown',   // the tool's own label, recorded verbatim
      host: obj.host || '',
      matchedAt: obj['matched-at'] || obj.matched || '',
      type: obj.type || ''
    })
  }
  return out
}

/** Normalize parsed records into RedLog event payloads (POST /api/events shape).
 *  `agent_type: 'scanner'`, `subtype: 'scan_result'`; `target_id` is the host so
 *  the timeline's target axis groups them. One event per host (nmap) / finding
 *  (nuclei). */
function toScanEvents(tool, parsed) {
  if (tool === 'nmap') {
    return parsed.map((h) => ({
      agent_type: 'scanner',
      target_id: h.host,
      data: {
        subtype: 'scan_result',
        tool: 'nmap',
        host: h.host,
        hostname: h.hostname || undefined,
        detectedTarget: h.host,
        ports: h.ports,
        open_port_count: h.ports.length,
        summary: h.ports.map((p) => `${p.port}/${p.proto} ${p.service}`.trim()).join(', ')
      }
    }))
  }
  if (tool === 'nuclei') {
    return parsed.map((f) => ({
      agent_type: 'scanner',
      target_id: f.host,
      data: {
        subtype: 'scan_result',
        tool: 'nuclei',
        host: f.host,
        detectedTarget: f.host,
        template_id: f.templateId,
        name: f.name,
        severity: f.severity,      // nuclei's own severity — a fact about the tool output
        matched_at: f.matchedAt,
        result_type: f.type
      }
    }))
  }
  return []
}

/** One-shot: raw tool output → event payloads. */
function parse(tool, text) {
  if (tool === 'nmap') return toScanEvents('nmap', parseNmapGreppable(text))
  if (tool === 'nuclei') return toScanEvents('nuclei', parseNucleiJsonl(text))
  return []
}

module.exports = { parseNmapGreppable, parseNucleiJsonl, toScanEvents, parse }
