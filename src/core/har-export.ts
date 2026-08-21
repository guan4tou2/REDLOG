import { queryEvents, type RedLogEvent } from './db/events'
import { readBody, type BodyRef } from './http-body-store'

interface HarEntry {
  startedDateTime: string
  time: number
  request: {
    method: string
    url: string
    httpVersion: string
    cookies: unknown[]
    headers: { name: string; value: string }[]
    queryString: { name: string; value: string }[]
    postData?: { mimeType: string; text: string }
    headersSize: number
    bodySize: number
  }
  response: {
    status: number
    statusText: string
    httpVersion: string
    cookies: unknown[]
    headers: { name: string; value: string }[]
    content: { size: number; mimeType: string; text?: string; encoding?: string }
    redirectURL: string
    headersSize: number
    bodySize: number
  }
  cache: Record<string, never>
  timings: { send: number; wait: number; receive: number; connect?: number; ssl?: number }
}

function headersToHar(raw: unknown): { name: string; value: string }[] {
  if (Array.isArray(raw)) {
    return (raw as string[][]).map(([n, v]) => ({ name: n, value: v }))
  }
  if (raw && typeof raw === 'object') {
    return Object.entries(raw as Record<string, string>).map(([name, value]) => ({ name, value }))
  }
  return []
}

function resolveBody(
  inlineBody: { data?: string; encoding?: string; size?: number } | undefined,
  bodyRef: BodyRef | undefined
): { text: string; encoding?: string; size: number } | null {
  if (inlineBody?.data) {
    return {
      text: inlineBody.data,
      encoding: inlineBody.encoding === 'base64' ? 'base64' : undefined,
      size: inlineBody.size ?? inlineBody.data.length
    }
  }
  if (bodyRef) {
    const content = readBody(bodyRef)
    if (content !== null) {
      return {
        text: content,
        encoding: bodyRef.encoding === 'base64' ? 'base64' : undefined,
        size: bodyRef.size
      }
    }
  }
  return null
}

function parseQueryString(url: string): { name: string; value: string }[] {
  try {
    const u = new URL(url)
    const result: { name: string; value: string }[] = []
    u.searchParams.forEach((value, name) => result.push({ name, value }))
    return result
  } catch {
    return []
  }
}

export function exportHar(opts?: {
  since?: number
  before?: number
  targetId?: string
  limit?: number
}): string {
  const events = queryEvents({
    agentType: 'scanner',
    tier: 'logged',
    limit: opts?.limit ?? 50000,
    since: opts?.since,
    ...(opts?.targetId ? { targetId: opts.targetId } : {})
  })

  const requests = new Map<string, RedLogEvent>()
  const responses = new Map<string, RedLogEvent>()

  for (const ev of events) {
    const d = ev.data as Record<string, unknown> | undefined
    if (!d) continue
    const flowId = d.flow_id as string | undefined
    if (!flowId) continue
    if (d.subtype === 'http_request_start') requests.set(flowId, ev)
    else if (d.subtype === 'http_response') responses.set(flowId, ev)
  }

  const entries: HarEntry[] = []

  for (const [flowId, reqEv] of requests) {
    const rd = reqEv.data as Record<string, unknown>
    const respEv = responses.get(flowId)
    const rsd = respEv?.data as Record<string, unknown> | undefined

    const reqBody = resolveBody(
      rd.request_body as { data?: string; encoding?: string; size?: number } | undefined,
      rd.request_body_ref as BodyRef | undefined
    )
    const respBody = resolveBody(
      rsd?.response_body as { data?: string; encoding?: string; size?: number } | undefined,
      rsd?.response_body_ref as BodyRef | undefined
    )

    const timing = rsd?.timing as Record<string, number> | undefined

    const entry: HarEntry = {
      startedDateTime: new Date(reqEv.timestamp).toISOString(),
      time: (rsd?.duration_ms as number) ?? -1,
      request: {
        method: String(rd.method ?? 'GET'),
        url: String(rd.url ?? ''),
        httpVersion: 'HTTP/1.1',
        cookies: [],
        headers: headersToHar(rd.request_headers),
        queryString: parseQueryString(String(rd.url ?? '')),
        ...(reqBody ? { postData: { mimeType: String(rd.content_type ?? 'application/octet-stream'), text: reqBody.text } } : {}),
        headersSize: -1,
        bodySize: reqBody?.size ?? -1,
      },
      response: {
        status: (rsd?.status as number) ?? 0,
        statusText: '',
        httpVersion: 'HTTP/1.1',
        cookies: [],
        headers: headersToHar(rsd?.response_headers),
        content: {
          size: (rsd?.content_length as number) ?? 0,
          mimeType: String(rsd?.content_type ?? 'application/octet-stream'),
          ...(respBody ? { text: respBody.text, ...(respBody.encoding ? { encoding: respBody.encoding } : {}) } : {})
        },
        redirectURL: '',
        headersSize: -1,
        bodySize: (rsd?.content_length as number) ?? -1,
      },
      cache: {},
      timings: {
        send: timing?.send_ms ?? -1,
        wait: timing?.wait_ms ?? -1,
        receive: timing?.receive_ms ?? -1,
        ...(timing?.connect_ms !== undefined ? { connect: timing.connect_ms } : {}),
        ...(timing?.tls_ms !== undefined ? { ssl: timing.tls_ms } : {})
      }
    }

    entries.push(entry)
  }

  entries.sort((a, b) => a.startedDateTime.localeCompare(b.startedDateTime))

  const har = {
    log: {
      version: '1.2',
      creator: { name: 'RedLog', version: '1.0.0' },
      entries
    }
  }

  return JSON.stringify(har, null, 2)
}
