// Historical proof and current reachability are independent facts. A UA names
// a client family, never a stable process identity or a shared trust grant.
export interface HttpVerificationEvidence {
  version: 1
  projectId: string
  clientIdentity: string | null
  clientLabel: string
  endpoint: string
  caFingerprint: string
  routing: string
  sourceInstance: string
  verifiedAt: number
  captureVerified: true
  caTrustVerified: boolean
}

export type HttpVerificationState = 'not-configured' | 'ready-to-verify' | 'previously-verified'
  | 'verified-current-configuration' | 'invalidated' | 'failed' | 'unknown'

export interface HttpVerificationContext {
  projectId: string
  endpoint: string | null
  caFingerprint: string | null
  routing: string
  sourceInstance: string | null
  running: boolean
  failed: boolean
  clientIdentity: string | null
}

export function httpVerificationState(evidence: HttpVerificationEvidence | null, current: HttpVerificationContext, unreadable = false): HttpVerificationState {
  if (unreadable) return 'unknown'
  if (current.failed) return 'failed'
  if (!current.projectId || !current.endpoint) return 'not-configured'
  if (!evidence) return current.running ? 'ready-to-verify' : 'not-configured'
  if (evidence.projectId !== current.projectId || evidence.endpoint !== current.endpoint
    || evidence.routing !== current.routing || (current.caFingerprint && evidence.caFingerprint !== current.caFingerprint)) return 'invalidated'
  if (!current.caFingerprint) return 'unknown'
  if (!current.running || !current.clientIdentity || evidence.clientIdentity !== current.clientIdentity
    || evidence.sourceInstance !== current.sourceInstance) return 'previously-verified'
  return 'verified-current-configuration'
}
