import { Button } from './Button'
import { useState, useEffect, useCallback } from 'react'
import { useI18n } from '../i18n'
import { toast } from './Toast'

// ---------------------------------------------------------------------------
// Shared constants & helpers
// ---------------------------------------------------------------------------

export const BODY_GONE = '\u0000__redlog_body_gone__'

export const STREAM_ACCENTS: Record<'emerald' | 'amber' | 'zinc', { label: string; bar: string; bg: string; badge: string }> = {
  emerald: { label: 'text-emerald-400', bar: 'border-emerald-600/40', bg: 'bg-emerald-900/10', badge: 'text-emerald-300 bg-emerald-900/30' },
  amber:   { label: 'text-amber-400',   bar: 'border-amber-600/40',   bg: 'bg-amber-900/10',   badge: 'text-amber-300 bg-amber-900/30' },
  zinc:    { label: 'text-redlog-text',    bar: 'border-redlog-border/60',    bg: 'bg-redlog-surface/40',    badge: 'text-redlog-text bg-redlog-elevated/60' }
}

const INLINE_PREVIEW_BYTES = 4096

import { formatSize } from '../lib/time'
const formatBytes = formatSize
export { formatBytes }

export function safePretty(v: unknown): string {
  try { return JSON.stringify(v, null, 2) } catch { return String(v) }
}

// ---------------------------------------------------------------------------
// CollapsibleStream
// ---------------------------------------------------------------------------

export function CollapsibleStream({
  label,
  content,
  bytes,
  truncated,
  accent,
  startOpen
}: {
  label: string
  content: string
  bytes?: number
  truncated?: boolean
  accent: 'emerald' | 'amber' | 'zinc'
  startOpen?: boolean
}): JSX.Element {
  const { t } = useI18n()
  const [open, setOpen] = useState(!!startOpen)
  const [copied, setCopied] = useState(false)
  const acc = STREAM_ACCENTS[accent]
  const shownBytes = typeof bytes === 'number' ? bytes : content.length
  const isLarge = content.length > INLINE_PREVIEW_BYTES
  const preview = isLarge ? content.slice(0, INLINE_PREVIEW_BYTES) : content
  const copyFull = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(content)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
      toast(t('toast.copied'), 'success')
    } catch { /* ignore */ }
  }
  return (
    <div className={`border ${acc.bar} rounded ${acc.bg}`}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="w-full flex items-center gap-2 px-2 py-1 text-left"
      >
        <span className="text-xs text-redlog-text-dim font-mono w-3">{open ? '▼' : '▶'}</span>
        <span className={`text-xs font-mono font-semibold uppercase tracking-wider ${acc.label}`}>{label}</span>
        <span className={`text-xs font-mono px-1.5 py-0.5 rounded ${acc.badge}`}>
          {formatBytes(shownBytes)}
        </span>
        {truncated && (
          <span className="text-xs font-mono text-amber-400" title={t('timeline.detail.truncatedHint')}>
            {t('timeline.detail.truncated')}
          </span>
        )}
        {isLarge && (
          <span
            role="button"
            tabIndex={0}
            onClick={(e) => { e.stopPropagation(); void copyFull() }}
            onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.stopPropagation(); e.preventDefault(); void copyFull() } }}
            className="ml-auto text-xs font-mono px-1.5 py-0.5 rounded bg-redlog-elevated text-redlog-text-dim hover:bg-redlog-elevated-hover hover:text-redlog-text cursor-pointer"
          >
            {copied ? t('timeline.detail.copied') : t('timeline.detail.copyFull')}
          </span>
        )}
      </button>
      {open && content.length > 0 && (
        <pre className="mx-2 mb-2 p-2 bg-redlog-bg rounded border border-redlog-border/60 text-xs text-redlog-text font-mono max-h-80 overflow-y-auto whitespace-pre-wrap break-all">
          {preview}
          {isLarge && (
            <span className="block mt-2 text-xs text-redlog-text-dim">
              {t('timeline.detail.previewCut', { shown: formatBytes(preview.length), total: formatBytes(shownBytes) })}
            </span>
          )}
        </pre>
      )}
      {open && content.length === 0 && (
        <p className="mx-2 mb-2 px-2 py-1 text-xs text-redlog-text-faint font-mono italic">{t('timeline.detail.empty')}</p>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// MetadataGrid
// ---------------------------------------------------------------------------

export function MetadataGrid({ entries }: { entries: Array<[string, unknown]> }): JSX.Element {
  const rows = entries.filter(([, v]) => v !== undefined && v !== null && v !== '')
  if (rows.length === 0) return <></>
  return (
    <div className="rounded border border-redlog-border/60 bg-redlog-bg/40 px-2 py-1.5">
      <div className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-xs font-mono">
        {rows.map(([k, v]) => (
          <div key={k} className="contents">
            <span className="text-redlog-text-dim">{k}</span>
            <span className="text-redlog-text break-all">{String(v)}</span>
          </div>
        ))}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// HttpDetail — HTTP exchange detail, shared by Timeline and HttpHistoryPanel
// ---------------------------------------------------------------------------

export function HttpDetail({ data, eventId }: { data: Record<string, unknown>; eventId: string }): JSX.Element {
  const { t } = useI18n()
  const subtype = String(data.subtype ?? '')
  const isRequest = subtype === 'http_request_start'
  const isResponse = subtype === 'http_response'
  const flowId = typeof data.flow_id === 'string' ? data.flow_id : ''
  const ownHalf = isRequest ? 'request' : 'response'
  const [half, setHalf] = useState<'request' | 'response'>(ownHalf)
  const [partner, setPartner] = useState<{ eventId: string; data: Record<string, unknown> } | null>(null)
  const [pairedLoading, setPairedLoading] = useState(false)
  const [pairedError, setPairedError] = useState(false)
  const [attempt, setAttempt] = useState(0)

  useEffect(() => { setHalf(ownHalf) }, [ownHalf, eventId])
  useEffect(() => {
    setPartner(null)
    setPairedError(false)
    setPairedLoading(false)
    if (!flowId || (!isRequest && !isResponse)) return
    let cancelled = false
    setPairedLoading(true)
    window.redlog.events.queryByFlowId(flowId).then(events => {
      if (cancelled) return
      const found = events.find(event => event.id !== eventId && (
        isRequest ? event.data?.subtype === 'http_response' : event.data?.subtype === 'http_request_start'
      ))
      setPartner(found ? { eventId, data: found.data } : null)
    }).catch(() => { if (!cancelled) setPairedError(true) })
      .finally(() => { if (!cancelled) setPairedLoading(false) })
    return () => { cancelled = true }
  }, [flowId, eventId, isRequest, isResponse, attempt])

  // Both tabs use the same body reader. A separate preview-only partner view
  // hid captured inline/sidecar bodies, cookies and capture truncation.
  const pairedData = partner?.eventId === eventId ? partner.data : null
  const selected = half !== ownHalf && pairedData ? pairedData : data
  return (
    <div className="mt-2 space-y-1.5">
      {pairedData && (
        <div role="tablist" className="flex gap-1 border-b border-redlog-border/60 -mx-1 px-1">
          {(['request', 'response'] as const).map(side => (
            <button
              key={side}
              role="tab"
              data-testid={`http-tab-${side}`}
              aria-selected={half === side}
              onClick={() => setHalf(side)}
              className={`px-3 py-1.5 text-xs -mb-px border-b-2 transition-colors ${half === side ? 'border-redlog-cyan text-redlog-text' : 'border-transparent text-redlog-text-faint hover:text-redlog-text-dim'}`}
            >{t(side === 'request' ? 'timeline.detail.tabRequest' : 'timeline.detail.tabResponse')}</button>
          ))}
        </div>
      )}
      <HttpHalf key={`${eventId}:${half}`} data={selected} />
      {pairedLoading && <p role="status" className="text-xs text-redlog-text-dim">{t('http.loadingPaired')}</p>}
      {pairedError && <div role="alert" className="flex flex-wrap items-center gap-2 text-xs text-amber-400">
        <span>{t('http.pairedFailed')}</span>
        <button type="button" className="min-h-8 underline" onClick={() => setAttempt(value => value + 1)}>{t('common.retry')}</button>
      </div>}
    </div>
  )
}

function HttpHalf({ data }: { data: Record<string, unknown> }): JSX.Element {
  const { t } = useI18n()
  const subtype = String(data.subtype ?? '')
  const isResponse = subtype === 'http_response'
  const isRequest = subtype === 'http_request_start'
  const isWs = subtype === 'ws_message'
  const isTcp = subtype === 'tcp_message'
  const tlsInfo = data.tls as Record<string, unknown> | undefined
  const timingInfo = data.timing as Record<string, number> | undefined
  const params = data.params as Record<string, unknown> | undefined
  const preview = typeof data.response_preview === 'string' ? (data.response_preview as string) : ''
  const reqPreview = typeof data.request_body_preview === 'string' ? (data.request_body_preview as string) : ''
  const wsPreview = typeof data.ws_preview === 'string' ? (data.ws_preview as string) : ''
  const tcpPreview = typeof data.tcp_preview === 'string' ? (data.tcp_preview as string) : ''
  const contentType = String(data.content_type ?? '')
  const contentLength = typeof data.content_length === 'number' ? (data.content_length as number) : null

  const inlineReqBody = data.request_body as { data?: string; encoding?: string; size?: number; truncated?: boolean } | undefined
  const inlineRespBody = data.response_body as { data?: string; encoding?: string; size?: number; truncated?: boolean } | undefined
  const inlineWsBody = data.ws_body as { data?: string; encoding?: string; size?: number; truncated?: boolean } | undefined
  const inlineTcpBody = data.tcp_body as { data?: string; encoding?: string; size?: number; truncated?: boolean } | undefined
  const reqBodyRef = data.request_body_ref as { sha256: string; size: number; file: string; encoding: 'text' | 'base64'; truncated?: boolean } | undefined
  const respBodyRef = data.response_body_ref as { sha256: string; size: number; file: string; encoding: 'text' | 'base64'; truncated?: boolean } | undefined
  const wsBodyRef = data.ws_body_ref as { sha256: string; size: number; file: string; encoding: 'text' | 'base64'; truncated?: boolean } | undefined
  const tcpBodyRef = data.tcp_body_ref as { sha256: string; size: number; file: string; encoding: 'text' | 'base64'; truncated?: boolean } | undefined

  const hasFullReqBody = !!(inlineReqBody?.data || reqBodyRef)
  const hasFullRespBody = !!(inlineRespBody?.data || respBodyRef)
  const hasFullWsBody = !!(inlineWsBody?.data || wsBodyRef)
  const hasFullTcpBody = !!(inlineTcpBody?.data || tcpBodyRef)

  const reqBodyTruncated = inlineReqBody?.truncated === true || reqBodyRef?.truncated === true
  const respBodyTruncated = inlineRespBody?.truncated === true || respBodyRef?.truncated === true
  const wsBodyTruncated = inlineWsBody?.truncated === true || wsBodyRef?.truncated === true
  const tcpBodyTruncated = inlineTcpBody?.truncated === true || tcpBodyRef?.truncated === true

  const [requestedReqBody, setLoadedReqBody] = useState<string | null>(null)
  const [requestedRespBody, setLoadedRespBody] = useState<string | null>(null)
  const [requestedWsBody, setLoadedWsBody] = useState<string | null>(null)
  const [requestedTcpBody, setLoadedTcpBody] = useState<string | null>(null)
  // Inline text has already arrived with the event. Render it immediately;
  // the explicit load action is for sidecars and encoded binary payloads.
  const inlineText = (body: { data?: string; encoding?: string } | undefined): string | null =>
    body?.encoding === 'text' && typeof body.data === 'string' ? body.data : null
  const loadedReqBody = inlineText(inlineReqBody) ?? requestedReqBody
  const loadedRespBody = inlineText(inlineRespBody) ?? requestedRespBody
  const loadedWsBody = inlineText(inlineWsBody) ?? requestedWsBody
  const loadedTcpBody = inlineText(inlineTcpBody) ?? requestedTcpBody
  const [loadingReq, setLoadingReq] = useState(false)
  const [loadingResp, setLoadingResp] = useState(false)
  const [loadingWs, setLoadingWs] = useState(false)
  const [loadingTcp, setLoadingTcp] = useState(false)

  const loadFullBody = useCallback(async (
    ref: { sha256: string; size: number; file: string; encoding: 'text' | 'base64' } | undefined,
    inline: { data?: string; encoding?: string; size?: number } | undefined,
    setter: (v: string | null) => void,
    setLoading: (v: boolean) => void
  ) => {
    if (inline?.data) {
      setter(inline.encoding === 'base64'
        ? `[base64, ${inline.size ?? inline.data.length} bytes]\n${inline.data}`
        : inline.data)
      return
    }
    if (!ref) return
    setLoading(true)
    try {
      const content = await window.redlog.httpBody.read(ref)
      setter(content === null ? BODY_GONE : content)
    } catch { setter(BODY_GONE) }
    setLoading(false)
  }, [])

  const headers = data.request_headers ?? data.response_headers
  const headersText = (() => {
    if (!headers) return ''
    if (Array.isArray(headers)) {
      return (headers as string[][]).map(([n, v]) => `${n}: ${v}`).join('\n')
    }
    return safePretty(headers)
  })()

  const bodyless = isResponse && !preview && !hasFullRespBody && contentLength !== null && contentLength > 0
  const binaryish = bodyless && !!contentType && !/json|html|text|xml|javascript/i.test(contentType)

  const ownBlock = (
    <>
      {isRequest && params && Object.keys(params).length > 0 && (
        <CollapsibleStream
          label={t('timeline.detail.httpRequestParams')}
          content={safePretty(params)}
          accent="zinc"
          startOpen
        />
      )}
      {isRequest && reqPreview.length > 0 && !loadedReqBody && (
        <CollapsibleStream
          label={t('timeline.detail.httpRequestBody')}
          content={reqPreview}
          bytes={inlineReqBody?.size ?? reqPreview.length}
          truncated={reqBodyTruncated}
          accent="zinc"
          startOpen
        />
      )}
      {isRequest && hasFullReqBody && !loadedReqBody && (
        <Button size="compact" level="quiet" className="font-mono"
          onClick={() => loadFullBody(reqBodyRef, inlineReqBody, setLoadedReqBody, setLoadingReq)}
          disabled={loadingReq}
        >
          {loadingReq ? '...' : t('timeline.detail.httpLoadFullBody')}
          {' '}({formatBytes(inlineReqBody?.size ?? reqBodyRef?.size ?? 0)})
        </Button>
      )}
      {isRequest && loadedReqBody && loadedReqBody !== BODY_GONE && (
        <CollapsibleStream
          label={t('timeline.detail.httpRequestBody')}
          content={loadedReqBody}
          bytes={inlineReqBody?.size ?? reqBodyRef?.size}
          truncated={reqBodyTruncated}
          accent="zinc"
          startOpen
        />
      )}
      {isResponse && (preview.length > 0 || (loadedRespBody && loadedRespBody !== BODY_GONE)) && (
        <CollapsibleStream
          label={t('timeline.detail.httpResponseBody')}
          content={(loadedRespBody && loadedRespBody !== BODY_GONE) ? loadedRespBody : preview}
          bytes={contentLength ?? ((loadedRespBody && loadedRespBody !== BODY_GONE) ? loadedRespBody : preview).length}
          truncated={respBodyTruncated}
          accent="emerald"
          startOpen
        />
      )}
      {isResponse && hasFullRespBody && !loadedRespBody && (
        <Button size="compact" level="quiet" className="font-mono"
          onClick={() => loadFullBody(respBodyRef, inlineRespBody, setLoadedRespBody, setLoadingResp)}
          disabled={loadingResp}
        >
          {loadingResp ? '...' : t('timeline.detail.httpLoadFullBody')}
          {' '}({formatBytes(inlineRespBody?.size ?? respBodyRef?.size ?? contentLength ?? 0)})
        </Button>
      )}
      {isWs && (wsPreview.length > 0 || (loadedWsBody && loadedWsBody !== BODY_GONE)) && (
        <CollapsibleStream
          label={t('timeline.detail.wsPayload')}
          content={(loadedWsBody && loadedWsBody !== BODY_GONE) ? loadedWsBody : wsPreview}
          bytes={data.size as number ?? ((loadedWsBody && loadedWsBody !== BODY_GONE) ? loadedWsBody : wsPreview).length}
          truncated={wsBodyTruncated}
          accent={data.direction === 'client' ? 'zinc' : 'emerald'}
          startOpen
        />
      )}
      {isWs && hasFullWsBody && !loadedWsBody && (
        <Button size="compact" level="quiet" className="font-mono"
          onClick={() => loadFullBody(wsBodyRef, inlineWsBody, setLoadedWsBody, setLoadingWs)}
          disabled={loadingWs}
        >
          {loadingWs ? '...' : t('timeline.detail.httpLoadFullBody')}
          {' '}({formatBytes(inlineWsBody?.size ?? wsBodyRef?.size ?? 0)})
        </Button>
      )}
      {isTcp && (tcpPreview.length > 0 || (loadedTcpBody && loadedTcpBody !== BODY_GONE)) && (
        <CollapsibleStream
          label={t('timeline.detail.tcpPayload')}
          content={(loadedTcpBody && loadedTcpBody !== BODY_GONE) ? loadedTcpBody : tcpPreview}
          bytes={data.size as number ?? ((loadedTcpBody && loadedTcpBody !== BODY_GONE) ? loadedTcpBody : tcpPreview).length}
          truncated={tcpBodyTruncated}
          accent={data.direction === 'client' ? 'zinc' : 'emerald'}
          startOpen
        />
      )}
      {isTcp && hasFullTcpBody && !loadedTcpBody && (
        <Button size="compact" level="quiet" className="font-mono"
          onClick={() => loadFullBody(tcpBodyRef, inlineTcpBody, setLoadedTcpBody, setLoadingTcp)}
          disabled={loadingTcp}
        >
          {loadingTcp ? '...' : t('timeline.detail.httpLoadFullBody')}
          {' '}({formatBytes(inlineTcpBody?.size ?? tcpBodyRef?.size ?? 0)})
        </Button>
      )}
      {bodyless && (
        <p className="text-xs text-amber-400/80 font-mono px-2 py-1 rounded border border-amber-600/30 bg-amber-900/10">
          {t(binaryish ? 'timeline.detail.httpBodyBinary' : 'timeline.detail.httpBodyNotCaptured', {
            type: contentType || '—', size: formatBytes(contentLength ?? 0)
          })}
        </p>
      )}
      {[loadedReqBody, loadedRespBody, loadedWsBody, loadedTcpBody].includes(BODY_GONE) && (
        <p className="text-xs text-amber-400/80 font-mono px-2 py-1 rounded border border-amber-600/30 bg-amber-900/10">
          {t('timeline.detail.httpBodyEvicted')}
        </p>
      )}
      {headersText && (
        <CollapsibleStream
          label={t('timeline.detail.httpHeaders')}
          content={headersText}
          accent="zinc"
        />
      )}
      <MetadataGrid
        entries={[
          ...(isWs ? [
            ['direction', data.direction],
            ['message_type', data.message_type],
            ['size', formatBytes(data.size as number ?? 0)],
            ['message_#', data.message_count],
          ] as [string, unknown][] : isTcp ? [
            ['direction', data.direction],
            ['size', formatBytes(data.size as number ?? 0)],
            ['port', data.port],
            ['message_#', data.message_count],
            ['tls_version', data.tls_version],
          ] as [string, unknown][] : [
            ['method', data.method],
            ['url', isRequest ? data.url : undefined],
            ['status', data.status],
            ['content_type', contentType || undefined],
            ['content_length', contentLength !== null ? formatBytes(contentLength) : undefined],
            ['duration_ms', data.duration_ms],
            ['http_version', data.http_version],
            ['stream_id', data.stream_id],
          ] as [string, unknown][]),
          ['host', data.host],
          ['flow_id', data.flow_id]
        ]}
      />
      {tlsInfo && (
        <CollapsibleStream
          label={t('timeline.detail.tlsInfo')}
          content={Object.entries(tlsInfo).map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(', ') : v}`).join('\n')}
          accent="zinc"
        />
      )}
      {timingInfo && (
        <CollapsibleStream
          label={t('timeline.detail.timing')}
          content={Object.entries(timingInfo).map(([k, v]) => `${k}: ${v}ms`).join('\n')}
          accent="zinc"
        />
      )}
      {isRequest && Array.isArray(data.cookies) && (data.cookies as Array<{name: string; value: string}>).length > 0 && (
        <CollapsibleStream
          label={t('timeline.detail.cookies')}
          content={(data.cookies as Array<{name: string; value: string}>).map(c => `${c.name}=${c.value}`).join('\n')}
          accent="zinc"
        />
      )}
      {isResponse && Array.isArray(data.set_cookies) && (data.set_cookies as Array<Record<string, unknown>>).length > 0 && (
        <CollapsibleStream
          label={t('timeline.detail.setCookies')}
          content={(data.set_cookies as Array<Record<string, unknown>>).map(c => {
            const parts = [`${c.name}=${c.value}`]
            if (c.domain) parts.push(`Domain=${c.domain}`)
            if (c.path) parts.push(`Path=${c.path}`)
            if (c.secure) parts.push('Secure')
            if (c.httponly) parts.push('HttpOnly')
            if (c.samesite) parts.push(`SameSite=${c.samesite}`)
            return parts.join('; ')
          }).join('\n')}
          accent="zinc"
        />
      )}
    </>
  )

  return <div className="space-y-1.5">{ownBlock}</div>
}
