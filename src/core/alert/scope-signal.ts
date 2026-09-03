// Which stored rows the scope policy was ever able to judge, and what string it
// judged (docs/DESIGN-core-and-capture.md §4b).
//
// This lived inside api-server as a private helper for the live path. It moved
// here when the recompute (design turn 8a) needed to ask the same question of
// rows already on disk: if the two had separate answers, an allowlist change
// would flag events the live path never watched, or quietly miss ones it did —
// and the operator would have no way to tell which.
//
// The SQL mirror below is the same question asked of the database. It exists so
// a recompute can find candidate targets without hydrating and JSON-parsing
// every row; a test asserts it derives exactly what `scopeSignalFor` derives.

/** The (agentType, subtype) pairs a live scope verdict was ever produced for.
 *
 *  Deliberately NOT every row carrying a host. `scanner/connection`,
 *  `http_navigation` and `shell/command_end` all name a remote address and are
 *  all absent, because flagging them for the first time during a recompute
 *  would be a new capability rather than a consequence of changing the
 *  allowlist — and it would make the banner's 「新標」 number describe something
 *  other than what it says.
 *
 *  `agent/tool_call` is absent for a different reason: the target is derived at
 *  dispatch time and never stored on the row, so re-deriving it later would run
 *  today's extractors over yesterday's rows and the row would misdescribe its
 *  own provenance. */
export const SCOPE_ELIGIBLE: ReadonlyArray<{ agentType: string; subtype: string }> = [
  { agentType: 'shell', subtype: 'command_start' },
  { agentType: 'scanner', subtype: 'http_request_start' },
  { agentType: 'scanner', subtype: 'ws_message' },
  { agentType: 'scanner', subtype: 'tcp_message' },
  { agentType: 'dns', subtype: 'dns_query' }
]

/** The SQL expression yielding the judged target for each agent bucket.
 *
 *  NOT `target_id`, which is a different string: the DNS producer stores the
 *  query name with its trailing dot while the live verdict judged the stripped
 *  form, and for shell a client-supplied `target_id` overrides the detected
 *  one. Since `matchesDomain` compares exactly, `evil.example.` and
 *  `evil.example` classify differently — grouping on `target_id` would judge
 *  candidates the live path never saw. */
export const SCOPE_KEY_SQL: Readonly<Record<string, string>> = {
  shell: "json_extract(data, '$.detectedTarget')",
  scanner: "json_extract(data, '$.host')",
  dns: "RTRIM(json_extract(data, '$.query_name'), '.')"
}

export type ScopeSignalSource = 'shell' | 'dns' | 'http' | 'scanner' | 'agent_tool'

export function scopeSignalFor(
  agentType: string,
  data: Record<string, unknown>
): { target: string; source: 'shell' | 'dns' | 'http' | 'scanner' | 'agent_tool'; action: string } | null {
  if (agentType === 'shell' && data.subtype === 'command_start') {
    const target = (data.detectedTarget as string | undefined) ?? null
    if (!target) return null
    return { target, source: 'shell', action: (data.command as string) ?? '' }
  }
  if (agentType === 'scanner' && data.subtype === 'http_request_start') {
    const target = (data.host as string | undefined) ?? null
    if (!target) return null
    return {
      target,
      source: 'http',
      action: `${(data.method as string) ?? 'GET'} ${(data.url as string) ?? ''}`.trim()
    }
  }
  if (agentType === 'scanner' && (data.subtype === 'ws_message' || data.subtype === 'tcp_message')) {
    const target = (data.host as string | undefined) ?? null
    if (!target) return null
    return {
      target,
      source: 'scanner',
      action: `${data.subtype === 'ws_message' ? 'WS' : 'TCP'} ${data.direction ?? ''} ${(data.url as string) ?? target}`.trim()
    }
  }
  if (agentType === 'dns' && data.subtype === 'dns_query') {
    const target = (data.query_name as string | undefined) ?? null
    // Bare `.` shows up on some resolvers as a root-query artifact — skip.
    if (!target || target === '.') return null
    return {
      target: target.replace(/\.$/, ''),  // strip trailing dot from FQDN form
      source: 'dns',
      action: `${(data.query_type as string) ?? 'A'} ${target}`
    }
  }
  return null
}
