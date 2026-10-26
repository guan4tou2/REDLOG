type PairEvent = { engagementId?: string; sessionId?: string; agentType: string; data?: Record<string, unknown> }

/** A conservative source namespace. Capture Session limits the namespace;
 * it never substitutes for the producer's own terminal/conversation Session. */
export function sourceSessionKey(event: PairEvent): string | null {
  const d = event.data
  if (typeof event.engagementId !== 'string' || !event.engagementId || typeof event.sessionId !== 'string' || !event.sessionId || !d) return null
  const source = event.agentType === 'agent' ? d.agent : event.agentType === 'shell' ? d.shell : null
  const session = event.agentType === 'agent' ? d.session_id : d.terminalId
  if (![source, session].every(value => typeof value === 'string' && value.length > 0)) return null
  return JSON.stringify(['source1', event.engagementId, event.sessionId, event.agentType, source, session])
}

/** Internal pairing tuple, not an Activity ID or a proof of execution.
 * Opaque identifiers are never trimmed, lowercased or delimiter-concatenated. */
export function operationPairKey(event: PairEvent): string | null {
  const scope = sourceSessionKey(event)
  const id = event.agentType === 'agent' ? event.data?.tool_use_id : event.data?.command_id
  return scope && typeof id === 'string' && id.length > 0 ? JSON.stringify(['pair1', scope, id]) : null
}
