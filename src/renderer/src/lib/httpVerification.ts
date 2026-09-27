import type { RedLogEvent } from '../../../core/db/events'

export type HttpClient = 'browser' | 'terminal'
export interface HttpAttempt {
  client: HttpClient
  protocol: 'http' | 'https'
  url: string
  startedAt: number
}

/** One operator-initiated GET probe; never sends traffic or changes trust. */
export function createHttpAttempt(client: HttpClient, address: string): HttpAttempt {
  if (address.length > 4096 || /[\x00-\x1f\x7f]/.test(address)) throw new Error('Invalid test URL')
  const url = new URL(address)
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('Invalid test URL')
  url.hash = ''
  url.searchParams.set('__redlog_verify', crypto.randomUUID())
  return { client, protocol: url.protocol === 'https:' ? 'https' : 'http', url: url.href, startedAt: Date.now() }
}

/** A response code proves capture, including HTTP errors; request-only does not. */
export function matchesHttpAttempt(attempt: HttpAttempt, event: Pick<RedLogEvent, 'agentType' | 'data'>): boolean {
  return event.agentType === 'scanner' && event.data.subtype === 'http_response' &&
    event.data.url === attempt.url && Number.isInteger(event.data.status) &&
    Number(event.data.status) >= 100 && Number(event.data.status) <= 599
}

export function httpTestCommand(attempt: HttpAttempt, proxy: string, shell: 'posix' | 'powershell'): string {
  const quote = (s: string): string => "'" + s.replace(/'/g, shell === 'powershell' ? "''" : "'\"'\"'") + "'"
  // A comma denotes no bypass hosts and survives PowerShell's legacy native
  // argument handling, which drops an empty quoted argument.
  return `${shell === 'powershell' ? 'curl.exe' : 'curl'} --proxy ${quote(proxy)} --noproxy ',' --globoff --max-time 30 --url ${quote(attempt.url)}`
}
