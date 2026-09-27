import { useEffect, useRef, useState } from 'react'
import { useI18n } from '../i18n'
import { createHttpAttempt, httpTestCommand, matchesHttpAttempt, type HttpAttempt, type HttpClient } from '../lib/httpVerification'
import { writeClipboard } from '../lib/clipboard'
import { isWindows } from '../lib/platform'
import { Button } from './Button'

type Result = { attempt: HttpAttempt; timedOut?: boolean; response?: { id: string; status: number } }
const clients = ['browser', 'terminal'] as const
const protocols = ['http', 'https'] as const

export function HttpCaptureVerification({ status, checkStatus }: {
  status: ManagedProxyStatus
  checkStatus: () => Promise<ManagedProxyStatus | null>
}): JSX.Element {
  const { t } = useI18n()
  const [client, setClient] = useState<HttpClient>('browser')
  const [address, setAddress] = useState('')
  const [shell, setShell] = useState<'posix' | 'powershell'>(isWindows ? 'powershell' : 'posix')
  const [results, setResults] = useState<Record<string, Result>>({})
  const [selected, setSelected] = useState<string | null>(null)
  const [error, setError] = useState('')
  const [copied, setCopied] = useState(false)
  const resultsRef = useRef(results)
  resultsRef.current = results

  useEffect(() => {
    let live = true
    const unsubscribe = window.redlog.events.onNewBatch((events) => {
      const matches = Object.entries(resultsRef.current).flatMap(([key, result]) => {
        const event = !result.response && events.find((e) => matchesHttpAttempt(result.attempt, e))
        return event ? [{ key, url: result.attempt.url, event }] : []
      })
      if (!matches.length) return
      void checkStatus().then((current) => {
        if (!live || !current) return
        if (current.state !== 'running' || current.url !== status.url || current.pid !== status.pid) return
        setResults((previous) => {
          const next = { ...previous }
          for (const { key, url, event } of matches) {
            if (next[key]?.attempt.url === url) next[key] = { ...next[key], response: { id: event.id, status: Number(event.data.status) } }
          }
          return next
        })
      })
    })
    const timer = setInterval(() => setResults((previous) => {
      let next = previous
      for (const [key, result] of Object.entries(previous)) {
        if (!result.response && !result.timedOut && Date.now() - result.attempt.startedAt >= 60_000) {
          if (next === previous) next = { ...previous }
          next[key] = { ...result, timedOut: true }
        }
      }
      return next
    }), 1000)
    return () => { live = false; unsubscribe(); clearInterval(timer) }
  }, [status.url, status.pid, checkStatus])

  const generate = (): void => {
    try {
      const attempt = createHttpAttempt(client, address)
      const key = `${client}-${attempt.protocol}`
      setResults((previous) => ({ ...previous, [key]: { attempt } }))
      setSelected(key)
      setError('')
      setCopied(false)
    } catch { setError(t('httpVerify.invalidUrl')) }
  }
  const result = selected ? results[selected] : undefined
  const command = result ? httpTestCommand(result.attempt, status.url!, shell) : ''
  const copy = async (): Promise<void> => {
    if (!result) return
    const ok = await writeClipboard(result.attempt.client === 'terminal' ? command : result.attempt.url)
    setCopied(ok)
    setError(ok ? '' : t('httpVerify.copyFailed'))
  }
  const resultLabel = (r?: Result): string => !r ? t('httpVerify.notTested') : r.response
    ? t('httpVerify.captured', { status: r.response.status }) : t(r.timedOut ? 'httpVerify.timeout' : 'httpVerify.waiting')

  return <div className="space-y-2 border border-redlog-border rounded p-2" data-testid="http-verification">
    <p className="text-redlog-text-dim">{t('httpVerify.instructions')}</p>
    <div className="flex flex-wrap gap-2">
      <label className="space-y-1"><span className="block">{t('httpVerify.client')}</span>
        <select aria-label={t('httpVerify.client')} value={client} onChange={(e) => { setClient(e.target.value as HttpClient); setSelected(null); setCopied(false) }} className="bg-redlog-bg border border-redlog-border rounded p-1">
          {clients.map((c) => <option key={c} value={c}>{t(`httpVerify.${c}`)}</option>)}
        </select>
      </label>
      <label className="flex-1 basis-64 min-w-0 space-y-1"><span className="block">{t('httpVerify.url')}</span>
        <input aria-label={t('httpVerify.url')} placeholder="https://…" value={address} onChange={(e) => { setAddress(e.target.value); setSelected(null); setCopied(false) }} className="w-full bg-redlog-bg border border-redlog-border rounded p-1" />
      </label>
    </div>
    {client === 'terminal' && <label className="flex gap-2 items-center">{t('httpVerify.shell')}
      <select aria-label={t('httpVerify.shell')} value={shell} onChange={(e) => { setShell(e.target.value as typeof shell); setCopied(false) }} className="bg-redlog-bg border border-redlog-border rounded p-1">
        <option value="posix">Bash / Zsh / WSL</option><option value="powershell">PowerShell</option>
      </select>
    </label>}
    <Button level="secondary" disabled={!address.trim()} onClick={generate}>{t('httpVerify.generate')}</Button>
    {error && <p role="alert" className="text-redlog-red">{error}</p>}
    {result && <div className="space-y-1">
      <code data-testid="http-test-url" className="block break-all select-text">{result.attempt.url}</code>
      {result.attempt.client === 'terminal' && <code data-testid="http-test-command" className="block break-all select-text bg-redlog-bg p-2 rounded">{command}</code>}
      <Button level="quiet" onClick={() => void copy()}>{t(copied ? 'httpVerify.copied' : 'firstRun.copy')}</Button>
      <p role="status" data-testid={result.response ? 'first-run-http-verified' : result.timedOut ? 'first-run-http-timeout' : undefined}>
        {resultLabel(result)}
      </p>
      {result.timedOut && !result.response && <p className="text-redlog-text-dim">{t('httpVerify.recovery')}</p>}
    </div>}
    <ul className="grid grid-cols-2 gap-1 text-redlog-text-dim" aria-label={t('httpVerify.results')}>
      {clients.flatMap((c) => protocols.map((p) => <li key={`${c}-${p}`} data-testid={`http-result-${c}-${p}`}>
        {t(`httpVerify.${c}`)} · {p.toUpperCase()}: {resultLabel(results[`${c}-${p}`])}
      </li>))}
    </ul>
    <p className="text-redlog-text-faint">{t('httpVerify.limits')}</p>
  </div>
}
