// Spec 037: the optional HTTP step on the first-run screen. It never gates
// "done" — a host-only engagement has no web traffic to record — so it sits
// after the terminal step and can be dismissed.
//
// It drives the managed proxy the dashboard already owns (httpCapture IPC and
// its stopped/starting/running/unavailable/failed state) and the existing
// proxied-browser launch. The CA path stays behind a link: an operator who is
// only proxying the browser RedLog launches never needs it.
//
// Spec 040: a running proxy is not verified. Only a response belonging to an
// explicit client/protocol attempt verifies that route; lifecycle changes reset it.

import { useCallback, useEffect, useRef, useState } from 'react'
import { useI18n } from '../i18n'
import { Button } from './Button'
import { toast } from './Toast'
import { writeClipboard } from '../lib/clipboard'
import { requestRunInTerminal } from '../lib/terminalRunner'
import { isMac, isWindows } from '../lib/platform'
import { HttpCaptureVerification } from './HttpCaptureVerification'

const MITM_INSTALL = 'uv tool install mitmproxy'
function listenAddress(url: string | null): string {
  if (!url) return ''
  try { return new URL(url).host } catch { return url }
}

/** Add the generated mitmproxy CA to this machine's trust store. */
export type TrustOs = 'win32' | 'darwin' | 'linux'
export const thisOs = (): TrustOs => (isWindows ? 'win32' : isMac ? 'darwin' : 'linux')

export function caTrustCommand(caPath: string, os: TrustOs = thisOs()): string {
  if (os === 'win32') return `certutil -addstore -user Root "${caPath}"`
  if (os === 'darwin') return `sudo security add-trusted-cert -d -r trustRoot -k /Library/Keychains/System.keychain "${caPath}"`
  return `sudo cp "${caPath}" /usr/local/share/ca-certificates/mitmproxy.crt && sudo update-ca-certificates`
}

/** And take it out again. Shown beside the command that put it there: a root
 *  certificate left behind after an engagement is the longest-lived thing
 *  RedLog can leave on a machine, and the one nobody remembers. */
export function caUntrustCommand(os: TrustOs = thisOs()): string {
  if (os === 'win32') return 'certutil -delstore -user Root mitmproxy'
  if (os === 'darwin') return 'sudo security delete-certificate -c mitmproxy /Library/Keychains/System.keychain'
  return 'sudo rm -f /usr/local/share/ca-certificates/mitmproxy.crt && sudo update-ca-certificates --fresh'
}

function CaCommand({ label, command, t }: {
  label: string
  command: string
  t: (key: string, vars?: Record<string, string | number>) => string
}): JSX.Element {
  return (
    <div className="space-y-0.5">
      <p className="text-redlog-text-dim">{label}</p>
      <div className="flex items-center gap-2">
        <code title={command} className="flex-1 min-w-0 truncate font-mono bg-redlog-bg border border-redlog-border rounded px-2 py-1 text-redlog-text">
          {command}
        </code>
        <Button level="quiet" onClick={() => void writeClipboard(command)}>{t('firstRun.copy')}</Button>
        <Button level="quiet" onClick={() => requestRunInTerminal(command)}>{t('settings.hookRun')}</Button>
      </div>
    </div>
  )
}

export function HttpCaptureStep(): JSX.Element | null {
  const { t } = useI18n()
  const [dismissed, setDismissed] = useState(false)
  const [status, setStatus] = useState<ManagedProxyStatus>({ state: 'stopped', url: null })
  const [mitmMissing, setMitmMissing] = useState(false)
  const [busy, setBusy] = useState(false)
  const [config, setConfig] = useState<Record<string, unknown> | null>(null)
  const [showCa, setShowCa] = useState(false)
  const [statusError, setStatusError] = useState('')
  const [startError, setStartError] = useState('')
  const [statusLoaded, setStatusLoaded] = useState(false)
  const [configError, setConfigError] = useState('')
  const [saveError, setSaveError] = useState('')
  const [saving, setSaving] = useState(false)
  const live = useRef(false)
  const statusRequest = useRef(0)
  const statusInFlight = useRef<Promise<ManagedProxyStatus | null> | null>(null)
  const readStatus = useCallback((): Promise<ManagedProxyStatus | null> => {
    if (statusInFlight.current) return statusInFlight.current
    const request = ++statusRequest.current
    const pending = window.redlog.httpCapture.status().then((next) => {
      if (!live.current || request !== statusRequest.current) return null
      setStatus(next)
      setStatusLoaded(true)
      setStatusError('')
      return next
    }).catch((error) => {
      if (live.current && request === statusRequest.current) setStatusError(String(error))
      return null
    }).finally(() => { if (statusInFlight.current === pending) statusInFlight.current = null })
    statusInFlight.current = pending
    return pending
  }, [])

  const check = useCallback(async (): Promise<void> => {
    await Promise.all([
      readStatus(),
      Promise.all([window.redlog.runtime.preflight(), window.redlog.config.get()]).then(([pf, c]) => {
        if (!live.current) return
        setMitmMissing(pf.checks.some((item) => item.id === 'mitmdump' && !item.found))
        setConfig((c ?? {}) as Record<string, unknown>)
        setConfigError('')
      }).catch((error) => { if (live.current) setConfigError(String(error)) })
    ])
  }, [readStatus])

  useEffect(() => {
    if (dismissed) return
    live.current = true
    void check()
    const timer = setInterval(() => void readStatus(), 2000)
    return () => { live.current = false; ++statusRequest.current; statusInFlight.current = null; clearInterval(timer) }
  }, [check, readStatus, dismissed])

  const start = async (): Promise<void> => {
    setBusy(true)
    setStartError('')
    const request = ++statusRequest.current
    try {
      const next = await window.redlog.httpCapture.start()
      if (live.current && request === statusRequest.current) { setStatus(next); setStatusError('') }
    } catch (error) {
      if (live.current) setStartError(String(error))
    } finally { if (live.current) setBusy(false) }
  }

  const launch = async (): Promise<void> => {
    const r = await window.redlog.browser.launch().catch((e) => ({ ok: false, error: String(e) }))
    toast(r.ok ? t('browser.launched') : (r.error || t('browser.failed')), r.ok ? 'success' : 'error')
  }

  const httpCapture = (config?.httpCapture ?? {}) as Record<string, unknown>
  const routeTerminals = httpCapture.routeTerminals === true
  const setRouteTerminals = async (on: boolean): Promise<void> => {
    if (!config || saving) return
    setSaving(true)
    setSaveError('')
    try {
      const current = await window.redlog.config.get() as Record<string, unknown>
      if (!live.current) return
      const next = { ...current, httpCapture: { ...((current.httpCapture ?? {}) as Record<string, unknown>), routeTerminals: on } }
      if (!await window.redlog.config.save(next)) throw new Error(t('httpVerify.saveFailed'))
      if (live.current) setConfig(next)
    } catch (error) { if (live.current) setSaveError(String(error)) }
    finally { if (live.current) setSaving(false) }
  }

  if (dismissed) return null
  const unavailable = mitmMissing || status.state === 'unavailable'

  return (
    <section data-testid="first-run-http" className="border border-redlog-border rounded-lg p-3 text-xs space-y-2">
      <div className="flex items-baseline justify-between gap-2">
        <p className="font-semibold text-redlog-text">{t('firstRun.http.title')}</p>
        <button onClick={() => setDismissed(true)} className="text-redlog-text-faint hover:text-redlog-text">
          {t('firstRun.http.skip')}
        </button>
      </div>
      {(statusError || configError || saveError || startError) && <div role="alert" className="text-redlog-red space-y-1">
        <p>{statusError || configError || saveError || startError}</p>
        {(statusError || configError) && <Button level="quiet" onClick={() => void check()}>{t('firstRun.recheck')}</Button>}
      </div>}
      {statusError ? null : !statusLoaded ? <p>{t('common.loading')}</p> : unavailable ? (
        <div className="space-y-2">
          <p className="text-redlog-text">{t('firstRun.http.missing')}</p>
          <div className="flex items-center gap-2">
            <code className="font-mono text-redlog-text-dim">{MITM_INSTALL}</code>
            <Button level="quiet" onClick={() => void writeClipboard(MITM_INSTALL)}>{t('firstRun.copy')}</Button>
          </div>
          <Button level="secondary" onClick={() => void check()}>{t('firstRun.recheck')}</Button>
        </div>
      ) : status.state === 'running' ? (
        <div className="space-y-2">
          <p className="text-redlog-text-dim">{t('firstRun.http.listening', { address: listenAddress(status.url) })}</p>
          {config && !configError && status.url && <HttpCaptureVerification
            key={`${status.pid}:${status.url}`}
            status={status}
            checkStatus={readStatus}
          />}
          <p className="text-redlog-text-faint">{t('httpVerify.trustLimit')}</p>
          {((config?.browser ?? {}) as Record<string, unknown>).ignoreCertErrors === true &&
            <p className="text-redlog-text-dim">{t('httpVerify.browserBypass')}</p>}
          <Button level="secondary" onClick={() => void launch()}>{t('firstRun.http.launchBrowser')}</Button>
          <label className="flex items-start gap-2">
            <input
              type="checkbox"
              data-testid="first-run-route-terminals"
              checked={routeTerminals}
              disabled={!config || !!configError || saving}
              onChange={(e) => void setRouteTerminals(e.target.checked)}
            />
            <span>
              <span className="text-redlog-text-dim">{t('firstRun.http.routeTerminals')}</span>
              <span className="block text-redlog-text-faint">{t('firstRun.http.routeTerminalsLimit')}</span>
            </span>
          </label>
          {status.caPath && (
            <div>
              <button onClick={() => setShowCa((v) => !v)} className="text-redlog-text-faint underline hover:text-redlog-text">
                {t('firstRun.http.caLink')}
              </button>
              {showCa && (
                <div className="mt-1 space-y-1.5">
                  <p className="font-mono text-redlog-text-faint break-all">
                    {status.certReady === false
                      ? t('httpCapture.caMissing', { path: status.caPath })
                      : t('httpCapture.caReady', { path: status.caPath })}
                  </p>
                  {/* Without this, HTTPS capture covers only the browser
                      RedLog launches, which is told to ignore certificate
                      errors. Every other tool on the machine — curl, a
                      scanner, an implant — refuses the connection or is not
                      proxied at all, and the operator reads an HTTP-only
                      timeline as "the target used no TLS". Trusting a root CA
                      is a change to the machine, so it is offered as a draft
                      beside the terminal for the operator to review and copy, and the
                      command that undoes it is shown beside it. */}
                  {status.certReady !== false && (
                    <>
                      <p className="text-redlog-text-dim">{t('httpCapture.caTrustWhy')}</p>
                      <CaCommand
                        label={t('httpCapture.caTrust')}
                        command={caTrustCommand(status.caPath)}
                        t={t}
                      />
                      <CaCommand
                        label={t('httpCapture.caUntrust')}
                        command={caUntrustCommand()}
                        t={t}
                      />
                    </>
                  )}
                </div>
              )}
            </div>
          )}
        </div>
      ) : status.state === 'starting' || busy ? (
        <p className="text-redlog-text-dim">{t('httpCapture.starting')}</p>
      ) : (
        <div className="space-y-2">
          {status.state === 'failed' && (
            <p className="text-redlog-text-dim break-all">{status.error || t('httpCapture.failed')}</p>
          )}
          <Button level="secondary" onClick={() => void start()}>
            {status.state === 'failed' ? t('firstRun.record.retry') : t('httpCapture.start')}
          </Button>
        </div>
      )}
    </section>
  )
}
