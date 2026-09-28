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
// Spec 039: a running proxy is not "capturing". #220: nor is "some HTTP event
// arrived" — the capture browser makes its own requests the moment it starts.
// Each attempt has a nonce; HTTP and HTTPS are verified separately, only by a
// request for that nonce, and each says which client sent it. After 60 s
// without HTTP the card names the reasons that apply and keeps listening, so a
// late request still verifies.

import { useCallback, useEffect, useRef, useState } from 'react'
import { useI18n } from '../i18n'
import { HttpCaptureVerification } from './HttpCaptureVerification'
import { Button } from './Button'
import { CopyButton } from './CopyButton'
import { toast } from './Toast'
import { requestRunInTerminal } from '../lib/terminalRunner'
import { isMac, isWindows } from '../lib/platform'
import {
  applyVerifyReport, httpTimeoutReasons, httpsProvesTrust, newAttempt, verifyCommand, type VerifyAttempt
} from '../lib/httpVerification'
import { clientLabel, newVerifyNonce, type HttpVerifyReport } from '../../../core/http-verify'
import { DEFAULT_BROWSER } from '../../../core/browser-defaults'

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

export interface CaFingerprint { sha1: string; sha256: string }

/** The file name RedLog gives the CA in the Linux trust directory. It carries
 *  the fingerprint so it can never overwrite, or be confused with, another
 *  tool's `mitmproxy.crt` (#220). */
export function linuxCaFile(fp: CaFingerprint): string {
  return `/usr/local/share/ca-certificates/redlog-mitmproxy-${fp.sha1.slice(0, 16).toLowerCase()}.crt`
}

/** Empty without a fingerprint: RedLog does not offer to trust a CA it could
 *  not later remove by identity. */
export function caTrustCommand(caPath: string, fp: CaFingerprint | null | undefined, os: TrustOs = thisOs()): string {
  if (!fp) return ''
  if (os === 'win32') return `certutil -addstore -user Root "${caPath}"`
  if (os === 'darwin') return `sudo security add-trusted-cert -d -r trustRoot -k /Library/Keychains/System.keychain "${caPath}"`
  return `sudo cp "${caPath}" ${linuxCaFile(fp)} && sudo update-ca-certificates`
}

/** And take it out again — this CA, by its fingerprint. Removing by the name
 *  "mitmproxy" would also remove a CA another tool (a separate mitmproxy
 *  install, Burp's own setup scripts) had put there for its own use. Shown
 *  beside the command that added it: a root certificate left behind after an
 *  engagement is the longest-lived thing RedLog can leave on a machine. */
export function caUntrustCommand(caPath: string, fp: CaFingerprint | null | undefined, os: TrustOs = thisOs()): string {
  if (!fp) return ''
  if (os === 'win32') return `certutil -delstore -user Root ${fp.sha1}`
  if (os === 'darwin') return `sudo security remove-trusted-cert -d "${caPath}"; sudo security delete-certificate -Z ${fp.sha1} /Library/Keychains/System.keychain`
  return `sudo rm -f ${linuxCaFile(fp)} && sudo update-ca-certificates --fresh`
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
        <CopyButton text={command} />
        <Button level="quiet" onClick={() => requestRunInTerminal(command)}>{t('settings.hookRun')}</Button>
      </div>
    </div>
  )
}

function VerifyRow({ label, report, caveat, rejected, testId, t }: {
  label: string
  report: HttpVerifyReport | null
  caveat?: string
  rejected?: boolean
  testId: string
  t: (key: string, vars?: Record<string, string | number>) => string
}): JSX.Element {
  return (
    <li data-testid={testId} data-verified={report ? 'true' : 'false'} className="flex items-baseline gap-2">
      <span className="w-12 shrink-0 font-medium text-redlog-text">{label}</span>
      {report ? (
        <span className="text-emerald-500">
          {t('firstRun.http.verifiedVia', { client: clientLabel(report.userAgent) })}
          {caveat && <span className="block text-amber-400">{caveat}</span>}
        </span>
      ) : rejected ? (
        <span className="text-amber-400">{t('firstRun.http.rejected')}</span>
      ) : (
        <span className="text-redlog-text-faint">{t('firstRun.core.pending')}</span>
      )}
    </li>
  )
}

export function HttpCaptureStep({ onVerified }: {
  /** Current local probe state, invalidated when its proxy instance changes. */
  onVerified?: (verified: boolean) => void
} = {}): JSX.Element {
  const { t } = useI18n()
  const [status, setStatus] = useState<ManagedProxyStatus>({ state: 'stopped', url: null })
  const [mitmMissing, setMitmMissing] = useState(false)
  const [preflightFailed, setPreflightFailed] = useState(false)
  const [busy, setBusy] = useState(false)
  const [config, setConfig] = useState<Record<string, unknown> | null>(null)
  const [statusError, setStatusError] = useState('')
  const [configError, setConfigError] = useState('')
  const [startError, setStartError] = useState('')
  const [routeError, setRouteError] = useState('')
  const [routing, setRouting] = useState(false)
  const [showCa, setShowCa] = useState(false)
  const [attempt, setAttempt] = useState<VerifyAttempt>(() => newAttempt(newVerifyNonce()))
  const [timedOut, setTimedOut] = useState(false)
  const running = status.state === 'running' && !statusError
  const verified = attempt.http !== null
  const complete = attempt.http !== null && attempt.https !== null

  const proxyIdentity = `${status.state}:${status.url}:${status.pid}:${statusError}`
  const previousProxy = useRef('stopped:null:undefined')
  const acceptStatus = useCallback((next: ManagedProxyStatus): void => {
    const identity = `${next.state}:${next.url}:${next.pid}`
    if (previousProxy.current !== identity) {
      previousProxy.current = identity
      setAttempt(newAttempt(newVerifyNonce()))
      setTimedOut(false)
    }
    setStatus(next)
    setStatusError('')
  }, [])

  const checkStatus = useCallback(async (): Promise<ManagedProxyStatus | null> => {
    try {
      const next = await window.redlog.httpCapture.status()
      acceptStatus(next)
      return next
    } catch (err) {
      previousProxy.current = ''
      setAttempt(newAttempt(newVerifyNonce()))
      setStatusError(err instanceof Error ? err.message : String(err))
      return null
    }
  }, [])

  const readConfig = async (): Promise<void> => {
    try {
      const next = await window.redlog.config.get()
      if (!next) throw new Error('No project configuration')
      setConfig(next as Record<string, unknown>)
      setConfigError('')
    } catch (err) {
      setConfig(null)
      setConfigError(err instanceof Error ? err.message : String(err))
    }
  }

  // Reports arrive for as long as the card is up: HTTPS can verify after
  // HTTP, and a check from a terminal can land at any time.
  useEffect(() => {
    if (!running || complete) return
    return window.redlog.httpCapture.onVerify((r) => setAttempt((a) => applyVerifyReport(a, r)))
  }, [running, complete])

  useEffect(() => {
    if (!running || verified) return
    setTimedOut(false)
    const timer = setTimeout(() => setTimedOut(true), HTTP_VERIFY_TIMEOUT_MS)
    return () => clearTimeout(timer)
  }, [running, verified])

  useEffect(() => { onVerified?.(running && verified) }, [running, verified, onVerified])

  const check = async (): Promise<void> => {
    const [pf, st] = await Promise.all([
      window.redlog.runtime.preflight().catch(() => null),
      checkStatus()
    ])
    // A failed environment check is not "mitmproxy is installed".
    setPreflightFailed(pf === null)
    if (pf) setMitmMissing(pf.checks.some((c) => c.id === 'mitmdump' && !c.found))
    if (st) setStatus(st)
  }

  useEffect(() => {
    void check()
    void readConfig()
  }, [])

  // The proxy has other controls — the app-wide toggle beside this screen,
  // Settings — and this card is on screen from the first frame (#217). Read
  // once at mount, it kept offering "Start HTTP capture" for a proxy the
  // operator had already started, and never began listening for the first
  // request. Same cadence as the app-wide toggle.
  useEffect(() => {
    const timer = setInterval(() => {
      void checkStatus()
    }, 2_000)
    return () => clearInterval(timer)
  }, [])

  const start = async (): Promise<void> => {
    setBusy(true)
    setStartError('')
    // A rejected start is a failure the operator must see — it used to leave
    // the button as it was, as if nothing had been pressed.
    try {
      acceptStatus(await window.redlog.httpCapture.start())
      setStatusError('')
    } catch (err) {
      setStartError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  const verifyInBrowser = async (): Promise<void> => {
    const r = await window.redlog.httpCapture.verifyInBrowser(attempt.nonce).catch((e) => ({ ok: false, error: String(e) }))
    if (!r.ok) toast(r.error || t('browser.failed'), 'error')
  }

  // A new nonce: an earlier attempt's requests can no longer count.
  const retry = (): void => { setAttempt(newAttempt(newVerifyNonce())); setTimedOut(false) }

  const httpCapture = (config?.httpCapture ?? {}) as Record<string, unknown>
  const routeTerminals = httpCapture.routeTerminals === true
  const setRouteTerminals = async (on: boolean): Promise<void> => {
    if (!config || routing) return
    setRouting(true)
    setRouteError('')
    try {
      const current = await window.redlog.config.get() as Record<string, unknown> | null
      if (!current) throw new Error('No project configuration')
      const next = { ...current, httpCapture: { ...(current.httpCapture as Record<string, unknown>), routeTerminals: on } }
      if (await window.redlog.config.save(next) === false) throw new Error(t('firstRun.http.routeSaveFailed'))
      setConfig(next)
      window.dispatchEvent(new CustomEvent('redlog:config-saved'))
    } catch (err) {
      setRouteError(err instanceof Error ? err.message : String(err))
    } finally { setRouting(false) }
  }

  const unavailable = mitmMissing || status.state === 'unavailable'
  const browserCfg = (config?.browser ?? {}) as { ignoreCertErrors?: boolean }
  const ignoresCertErrors = browserCfg.ignoreCertErrors ?? DEFAULT_BROWSER.ignoreCertErrors
  const httpsCaveat = attempt.https && !httpsProvesTrust(attempt.https, ignoresCertErrors)
    ? t('firstRun.http.captureBrowserCaveat')
    : undefined
  const os = thisOs()

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
      {(statusError || configError) && <div role="alert" className="text-redlog-danger break-all">
        {statusError || configError}{' '}
        <button className="underline" onClick={() => { void check(); void readConfig() }}>{t('firstRun.recheck')}</button>
      </div>}
      {startError && <p role="alert" className="text-redlog-danger break-all">{startError}</p>}
      {routeError && <p role="alert" className="text-redlog-danger break-all">{routeError}</p>}
      {preflightFailed && (
        <p data-testid="first-run-http-preflight-failed" role="status" className="text-amber-300">
          {t('firstRun.http.preflightFailed')}{' '}
          <button type="button" onClick={() => void check()} className="underline hover:text-amber-200">{t('common.retry')}</button>
        </p>
      )}
      {statusError || configError ? null : unavailable ? (
        <div className="space-y-2">
          <p className="text-redlog-text">{t('firstRun.http.missing')}</p>
          <div className="flex items-center gap-2">
            <code className="font-mono text-redlog-text-dim">{MITM_INSTALL}</code>
            <CopyButton text={MITM_INSTALL} />
          </div>
          <Button level="secondary" onClick={() => void check()}>{t('firstRun.recheck')}</Button>
        </div>
      ) : status.state === 'running' ? (
        <div className="space-y-2">
          <p className="text-redlog-text-dim">{t('firstRun.http.listening', { address: listenAddress(status.url) })}</p>
          <p className="text-redlog-text-faint">{t('httpVerify.localProbeLimit')}</p>
          <ul data-testid="first-run-http-checks" className="space-y-1">
            <VerifyRow label="HTTP" report={attempt.http} testId="first-run-http-check-http" t={t} />
            <VerifyRow
              label="HTTPS"
              report={attempt.https}
              caveat={httpsCaveat}
              rejected={attempt.rejectedAt !== null}
              testId="first-run-http-check-https"
              t={t}
            />
          </ul>
          {verified && <p data-testid="first-run-http-verified" className="text-emerald-500 font-medium">{t('firstRun.http.verified')}</p>}
          {!verified && timedOut ? (
            <div data-testid="first-run-http-timeout" className="space-y-1">
              <p className="text-redlog-text">{t('firstRun.http.timeoutTitle')}</p>
              <ul className="list-disc pl-4 text-redlog-text-dim space-y-0.5">
                {httpTimeoutReasons({ certReady: status.certReady, routeTerminals, rejected: attempt.rejectedAt !== null }).map((r) => (
                  <li key={r}>{t(`firstRun.http.reason.${r}`)}</li>
                ))}
              </ul>
            </div>
          ) : !verified && (
            <p className="text-redlog-text-dim">{t('firstRun.http.waiting')}</p>
          )}
          <div className="flex flex-wrap gap-2">
            <Button level="secondary" onClick={() => void verifyInBrowser()} data-testid="first-run-http-verify-browser">
              {t('firstRun.http.verifyInBrowser')}
            </Button>
            {(attempt.http || attempt.https || attempt.rejectedAt !== null || timedOut) && (
              <Button level="quiet" onClick={retry} data-testid="first-run-http-retry">{t('firstRun.http.newCheck')}</Button>
            )}
          </div>
          {status.url && (
            <div data-testid="first-run-http-verify-commands" className="space-y-1">
              <p className="text-redlog-text-faint">{t('firstRun.http.verifyFromTool')}</p>
              <CaCommand label="HTTP" command={verifyCommand('http', attempt.nonce, status.url, os)} t={t} />
              <CaCommand label="HTTPS" command={verifyCommand('https', attempt.nonce, status.url, os)} t={t} />
              <p className="text-redlog-text-faint">{t('firstRun.http.verifyNoInsecure')}</p>
            </div>
          )}
          <p className="text-redlog-text-faint">{t('httpVerify.trustLimit')}</p>
          {ignoresCertErrors && <p className="text-amber-400">{t('httpVerify.browserBypass')}</p>}
          <details data-testid="http-real-request-check">
            <summary className="cursor-pointer text-redlog-text-dim">{t('httpVerify.realRequest')}</summary>
            <HttpCaptureVerification key={proxyIdentity} status={status} checkStatus={checkStatus} />
          </details>
          <label className="flex items-start gap-2">
            <input
              type="checkbox"
              data-testid="first-run-route-terminals"
              checked={routeTerminals}
              disabled={!config || routing}
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
                <div data-testid="first-run-http-ca" className="mt-1 space-y-1.5">
                  <p className="font-mono text-redlog-text-faint break-all">
                    {status.certReady === false
                      ? t('httpCapture.caMissing', { path: status.caPath })
                      : t('httpCapture.caReady', { path: status.caPath })}
                  </p>
                  {status.caFingerprint && (
                    <p data-testid="first-run-http-ca-fingerprint" className="font-mono text-redlog-text-faint break-all">
                      SHA-256 {status.caFingerprint.sha256}
                    </p>
                  )}
                  {/* Without this, HTTPS capture covers only the browser
                      RedLog launches, which is told to ignore certificate
                      errors. Every other tool on the machine — curl, a
                      scanner, an implant — refuses the connection or is not
                      proxied at all, and the operator reads an HTTP-only
                      timeline as "the target used no TLS". Trusting a root CA
                      is a change to the machine, so it is typed into RedLog's
                      terminal for the operator to read and run, and the
                      command that undoes it — this CA, by fingerprint — is
                      shown beside it. */}
                  {status.certReady !== false && status.caFingerprint && (
                    <>
                      <p className="text-redlog-text-dim">{t('httpCapture.caTrustWhy')}</p>
                      <p className="text-redlog-text-dim">{t('httpCapture.caTrustStores')}</p>
                      <CaCommand
                        label={t('httpCapture.caTrust')}
                        command={caTrustCommand(status.caPath, status.caFingerprint, os)}
                        t={t}
                      />
                      <CaCommand
                        label={t('httpCapture.caUntrust')}
                        command={caUntrustCommand(status.caPath, status.caFingerprint, os)}
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
            {status.state === 'failed' || startError ? t('firstRun.record.retry') : t('httpCapture.start')}
          </Button>
        </div>
      )}
    </section>
  )
}
