// The HTTP(S) half of the first-run screen's core capture (#217). It sits
// beside the Commands step, not after it, and cannot be dismissed: HTTP(S) is
// a core capability, and a step that can be waved away reads as optional. The
// operator can still leave the screen; the Dashboard keeps saying it is not
// done.
//
// It drives the managed proxy the dashboard already owns (httpCapture IPC and
// its stopped/starting/running/unavailable/failed state) and the existing
// proxied-browser launch. The CA path stays behind a link: an operator who is
// only proxying the browser RedLog launches never needs it.
//
// Spec 039: a running proxy is not "capturing". While it runs the card listens
// for the first HTTP event and only then says verified; after 60 s it names the
// reasons that apply and keeps listening, so a late request still verifies.

import { useEffect, useState } from 'react'
import { useI18n } from '../i18n'
import { Button } from './Button'
import { toast } from './Toast'
import { writeClipboard } from '../lib/clipboard'
import { requestRunInTerminal } from '../lib/terminalRunner'
import { isMac, isWindows } from '../lib/platform'
import { httpTimeoutReasons, isHttpCaptureEvent } from '../lib/httpVerification'

const MITM_INSTALL = 'uv tool install mitmproxy'
/** Same window as the shell activation: long enough to launch a browser and
 *  load a page, short enough to be named while the operator is watching. */
const HTTP_VERIFY_TIMEOUT_MS = 60_000

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

export function HttpCaptureStep({ onVerified }: {
  /** Called once, when the first HTTP event arrives. */
  onVerified?: () => void
} = {}): JSX.Element {
  const { t } = useI18n()
  const [status, setStatus] = useState<ManagedProxyStatus>({ state: 'stopped', url: null })
  const [mitmMissing, setMitmMissing] = useState(false)
  const [busy, setBusy] = useState(false)
  const [config, setConfig] = useState<Record<string, unknown> | null>(null)
  const [showCa, setShowCa] = useState(false)
  const [verified, setVerified] = useState(false)
  const [timedOut, setTimedOut] = useState(false)
  const running = status.state === 'running'

  useEffect(() => {
    if (!running || verified) return
    setTimedOut(false)
    const timer = setTimeout(() => setTimedOut(true), HTTP_VERIFY_TIMEOUT_MS)
    const unsub = window.redlog.events.onNewBatch((evs) => {
      if (evs.some(isHttpCaptureEvent)) setVerified(true)
    })
    return () => { clearTimeout(timer); unsub() }
  }, [running, verified])

  useEffect(() => { if (verified) onVerified?.() }, [verified, onVerified])

  const check = async (): Promise<void> => {
    const [pf, st] = await Promise.all([
      window.redlog.runtime.preflight().catch(() => null),
      window.redlog.httpCapture.status().catch(() => null)
    ])
    if (pf) setMitmMissing(pf.checks.some((c) => c.id === 'mitmdump' && !c.found))
    if (st) setStatus(st)
  }

  useEffect(() => {
    void check()
    window.redlog.config.get().then((c) => setConfig((c ?? {}) as Record<string, unknown>)).catch(() => {})
  }, [])

  const start = async (): Promise<void> => {
    setBusy(true)
    try { setStatus(await window.redlog.httpCapture.start()) } catch { /* status stays as it was */ }
    setBusy(false)
  }

  const launch = async (): Promise<void> => {
    const r = await window.redlog.browser.launch().catch((e) => ({ ok: false, error: String(e) }))
    toast(r.ok ? t('browser.launched') : (r.error || t('browser.failed')), r.ok ? 'success' : 'error')
  }

  const httpCapture = (config?.httpCapture ?? {}) as Record<string, unknown>
  const routeTerminals = httpCapture.routeTerminals === true
  const setRouteTerminals = (on: boolean): void => {
    if (!config) return
    const next = { ...config, httpCapture: { ...httpCapture, routeTerminals: on } }
    setConfig(next)
    void window.redlog.config.save(next)
  }

  const unavailable = mitmMissing || status.state === 'unavailable'

  return (
    <section data-testid="first-run-http" className="border border-redlog-border rounded-lg p-3 text-xs space-y-2">
      <div className="flex items-baseline justify-between gap-2">
        <p className="font-semibold text-redlog-text">{t('firstRun.http.title')}</p>
        <span
          data-testid="first-run-http-status"
          className={verified ? 'text-emerald-500' : 'text-redlog-text-faint'}
        >
          {verified ? t('firstRun.core.verified') : t('firstRun.core.pending')}
        </span>
      </div>
      {unavailable ? (
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
          {verified ? (
            <p data-testid="first-run-http-verified" className="text-emerald-500 font-medium">{t('firstRun.http.verified')}</p>
          ) : timedOut ? (
            <div data-testid="first-run-http-timeout" className="space-y-1">
              <p className="text-redlog-text">{t('firstRun.http.timeoutTitle')}</p>
              <ul className="list-disc pl-4 text-redlog-text-dim space-y-0.5">
                {httpTimeoutReasons({ certReady: status.certReady, routeTerminals }).map((r) => (
                  <li key={r}>{t(`firstRun.http.reason.${r}`)}</li>
                ))}
              </ul>
            </div>
          ) : (
            <p className="text-redlog-text-dim">{t('firstRun.http.waiting')}</p>
          )}
          <Button level="secondary" onClick={() => void launch()}>{t('firstRun.http.launchBrowser')}</Button>
          <label className="flex items-start gap-2">
            <input
              type="checkbox"
              data-testid="first-run-route-terminals"
              checked={routeTerminals}
              disabled={!config}
              onChange={(e) => setRouteTerminals(e.target.checked)}
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
                      is a change to the machine, so it is typed into RedLog's
                      terminal for the operator to read and run, and the
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
