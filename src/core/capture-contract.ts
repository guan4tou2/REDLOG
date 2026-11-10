/** Configuration, process state, observed saved data and read freshness are
 * independent facts. A historical event never proves a service is still live. */
export interface CaptureFactSource {
  installed?: boolean
  enabled?: boolean
  state: 'ready' | 'unset' | 'off' | 'error'
  lastEventAt: number | null
}
export interface CaptureFactRuntime {
  state: 'stopped' | 'starting' | 'running' | 'unavailable' | 'failed'
  connected?: boolean
}
export function captureFacts(source: CaptureFactSource | undefined, runtime?: CaptureFactRuntime, read: 'ok' | 'unknown' = 'ok') {
  const lastStoredAt = typeof source?.lastEventAt === 'number' && Number.isFinite(source.lastEventAt) ? source.lastEventAt : null
  return {
    read,
    configuration: read === 'unknown' ? 'unknown' as const
      : source?.state === 'off' || source?.enabled === false ? 'off' as const
        : source?.installed === false || source?.state === 'unset' ? 'unconfigured' as const
          : source ? 'configured' as const : 'unknown' as const,
    service: read === 'ok' && runtime ? runtime.state : 'unknown' as const,
    connection: read !== 'ok' || runtime?.connected === undefined ? 'unknown' as const : runtime.connected ? 'connected' as const : 'disconnected' as const,
    capability: read === 'ok' && source ? source.state : 'unknown' as const,
    data: lastStoredAt !== null ? (read === 'ok' ? 'observed' as const : 'history' as const) : read === 'ok' ? 'none-observed' as const : 'unknown' as const,
    lastStoredAt
  }
}
