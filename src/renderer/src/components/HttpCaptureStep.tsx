// The HTTP(S) half of the first-run screen's core capture (#217). It sits
// beside the Commands step, not after it, and cannot be dismissed: HTTP(S) is
// a core capability, and a step that can be waved away reads as optional. The
// operator can still leave the screen; the Dashboard keeps saying it is not
// done.
//
// It drives the managed proxy the dashboard already owns (httpCapture IPC and
// its stopped/starting/running/unavailable/failed state) and the existing
// proxied-browser launch. The default route is the operator's own browser:
// point it at the listener, trust the CA, open the check address. The browser
// RedLog launches stays as the alternative.
//
// Spec 039: a running proxy is not "capturing". #220: nor is "some HTTP event
// arrived" — the capture browser makes its own requests the moment it starts.
// Each attempt has a nonce; HTTP and HTTPS are verified separately, only by a
// request for that nonce, and each says which client sent it. After 60 s
// without HTTP the card names the reasons that apply and keeps listening, so a
// late request still verifies.

import { useEffect, useRef, useState } from 'react'
import { useI18n } from '../i18n'
import { Button } from './Button'
import { CopyButton } from './CopyButton'
import { toast } from './Toast'
import { requestRunInTerminal } from '../lib/terminalRunner'
import { useRevalidateOnFocus } from '../hooks/useRevalidateOnFocus'
import { isMac, isWindows } from '../lib/platform'
import {
  applyVerifyReport, httpTimeoutReasons, httpsProvesTrust, newAttempt, verifyCommand, type VerifyAttempt
} from '../lib/httpVerification'
import { clientLabel, newVerifyNonce, verifyUrl, type HttpVerifyReport } from '../../../core/http-verify'
import { DEFAULT_BROWSER } from '../../../core/browser-defaults'

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

export function CaCommand({ label, command, t }: {
  label: string
  command: string
  t: (key: string, vars?: Record<string, string | number>) => string
}): JSX.Element {
  return (
    <div className="space-y-0.5">
      <p className="text-redlog-text-dim">{label}</p>
      <code className="block whitespace-pre-wrap break-all font-mono bg-redlog-bg border border-redlog-border rounded px-2 py-1 text-redlog-text">
        {command}
      </code>
      <div className="flex flex-wrap items-center gap-2">
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

export function HttpCaptureStep({ onVerified, onPrepare, paused = false }: {
  /** Current HTTPS proof, including invalidation after restart or retry. */
  onVerified?: (verified: boolean) => void
  onPrepare: () => void
  /** Recording is paused right now: no check can pass, so a timed-out check says so. */
  paused?: boolean
}): JSX.Element {
  const { t } = useI18n()
  const [status, setStatus] = useState<ManagedProxyStatus>({ state: 'stopped', url: null })
  const [mitmMissing, setMitmMissing] = useState(false)
  const [preflightFailed, setPreflightFailed] = useState(false)
  const [busy, setBusy] = useState(false)
  const [config, setConfig] = useState<Record<string, unknown> | null>(null)
  // Closed until asked for (Spec 060 US2.1): the card shows the step the
  // operator is on, and the fingerprint and the trust and untrust commands are
  // reference, not the next action. The one-line cue above the toggle still
  // says the certificate is step two. A client that refused the certificate
  // makes the CA the current step, so it opens itself then (effect below).
  const [showCa, setShowCa] = useState(false)
  const [browserPath, setBrowserPath] = useState<'own' | 'capture'>('own')
  const [attempt, setAttempt] = useState<VerifyAttempt>(() => newAttempt(newVerifyNonce()))
  const [timedOut, setTimedOut] = useState(false)
  const running = status.state === 'running'
  const verified = running && attempt.https !== null
  const certRefused = attempt.rejectedAt !== null
  useEffect(() => { if (certRefused) { setShowCa(true); setBrowserPath('own') } }, [certRefused])

  // Reports arrive for as long as the card is up: HTTPS can verify after
  // HTTP, and a check from a terminal can land at any time.
  useEffect(() => {
    if (!running || verified) return
    return window.redlog.httpCapture.onVerify((r) => setAttempt((a) => applyVerifyReport(a, r)))
  }, [running, verified])

  useEffect(() => {
    if (!running || verified) return
    setTimedOut(false)
    const timer = setTimeout(() => setTimedOut(true), HTTP_VERIFY_TIMEOUT_MS)
    return () => clearTimeout(timer)
  }, [running, verified])

  useEffect(() => { onVerified?.(verified) }, [verified, onVerified])

  const check = async (): Promise<void> => {
    const [pf, st, cfg] = await Promise.all([
      window.redlog.runtime.preflight().catch(() => null),
      window.redlog.httpCapture.status().catch(() => null),
      window.redlog.config.get().catch(() => null)
    ])
    // A failed environment check is not "mitmproxy is installed".
    setPreflightFailed(pf === null)
    if (pf) {
      const mitm = pf.checks.find((c) => c.id === 'mitmdump')
      setMitmMissing(mitm ? !mitm.found : false)
    }
    if (st) setStatus(st)
    if (cfg) setConfig(cfg as Record<string, unknown>)
  }

  useEffect(() => {
    void check()
  }, [])

  // mitmproxy may have been installed in a terminal while RedLog was in the
  // background. The proxy's own status already refreshes on a timer below;
  // this is the other half of the same question.
  useRevalidateOnFocus(() => { void check() })

  // The proxy has other controls — the app-wide toggle beside this screen,
  // Settings — and this card is on screen from the first frame (#217). Read
  // once at mount, it kept offering "Start HTTP capture" for a proxy the
  // operator had already started, and never began listening for the first
  // request. Same cadence as the app-wide toggle.
  useEffect(() => {
    const timer = setInterval(() => {
      window.redlog.httpCapture.status().then(setStatus).catch(() => { /* keep the last known state */ })
    }, 3_000)
    return () => clearInterval(timer)
  }, [])

  const start = async (): Promise<void> => {
    setBusy(true)
    // A rejected start is a failure the operator must see — it used to leave
    // the button as it was, as if nothing had been pressed.
    try {
      setStatus(await window.redlog.httpCapture.start())
    } catch (err) {
      setStatus((prev) => ({ ...prev, state: 'failed', error: err instanceof Error ? err.message : String(err) }))
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
  // Only to name it as a reason a check found nothing; the switch itself
  // lives on Settings ▸ Browser, which owns every other proxy setting.
  const routeTerminals = httpCapture.routeTerminals === true

  // The proxy may still retain its pre-install "unavailable" state. Current
  // preflight decides whether tools need preparation; otherwise offer restart.
  const unavailable = mitmMissing
  const browserCfg = (config?.browser ?? {}) as { ignoreCertErrors?: boolean }
  const ignoresCertErrors = browserCfg.ignoreCertErrors ?? DEFAULT_BROWSER.ignoreCertErrors
  const httpsCaveat = attempt.https && !httpsProvesTrust(attempt.https, ignoresCertErrors)
    ? t('firstRun.http.captureBrowserCaveat')
    : undefined
  const os = thisOs()
  // A check belongs to its endpoint, CA and client policy. Historical success
  // must not light a restarted or reconfigured proxy with the old nonce.
  const verificationContext = JSON.stringify([running, status.url, status.caFingerprint?.sha256, ignoresCertErrors, routeTerminals])
  const lastContext = useRef(verificationContext)
  useEffect(() => {
    if (lastContext.current === verificationContext) return
    lastContext.current = verificationContext
    setAttempt(newAttempt(newVerifyNonce()))
    setTimedOut(false)
  }, [verificationContext])

  // `data-nonce` carries the attempt the card would accept. The per-tool
  // commands that used to be the only place it appeared are now the fallback
  // shown after a check has not landed; nothing reads it off the screen in
  // normal use, because the browser check carries it.
  return (
    <section data-testid="first-run-http" data-nonce={attempt.nonce} className="border border-redlog-border rounded-lg p-3 text-xs space-y-2">
      <div className="flex items-baseline justify-between gap-2">
        <p className="font-semibold text-redlog-text">{t('firstRun.http.title')}</p>
        <span
          data-testid="first-run-http-status"
          className={verified ? 'text-emerald-500' : 'text-redlog-text-faint'}
        >
          {verified ? t('firstRun.core.verified') : t('firstRun.core.pending')}
        </span>
      </div>
      {preflightFailed && (
        <p data-testid="first-run-http-preflight-failed" role="status" className="text-amber-300">
          {t('firstRun.http.preflightFailed')}{' '}
          <button type="button" onClick={() => void check()} className="underline hover:text-amber-200">{t('common.retry')}</button>
        </p>
      )}
      {unavailable ? (
        <div className="space-y-2" data-testid="first-run-http-unavailable">
          <p className="text-redlog-text">{t('firstRun.http.missing')}</p>
          <Button level="secondary" onClick={onPrepare} data-testid="first-run-http-prepare">{t('captureSetup.openPreparation')}</Button>
        </div>
      ) : status.state === 'running' ? (
        <div className="space-y-2">
          <div role="group" aria-label={t('firstRun.http.browserChoice')} className="flex flex-wrap gap-2">
            <Button level="secondary" className="aria-pressed:border-redlog-accent aria-pressed:bg-redlog-accent/10" aria-pressed={browserPath === 'own'} onClick={() => setBrowserPath('own')}>
              {t('firstRun.http.ownBrowser')}
            </Button>
            <Button level="secondary" className="aria-pressed:border-redlog-accent aria-pressed:bg-redlog-accent/10" aria-pressed={browserPath === 'capture'} onClick={() => setBrowserPath('capture')}>
              {t('firstRun.http.captureBrowser')}
            </Button>
          </div>
          {browserPath === 'own' && <div className="space-y-2">
          {/* The default route, as Burp does it, in the order the operator does
              it: a listener to point their own browser at (1), a CA to trust
              once (2), and a check (3). The browser RedLog launches is the
              alternative, not the plan. */}
          <div data-testid="first-run-http-proxy" className="space-y-0.5">
            <p className="text-redlog-text-dim">{t('firstRun.http.proxyLead')}</p>
            <div className="flex flex-wrap items-center gap-2">
              <code className="font-mono bg-redlog-bg border border-redlog-border rounded px-2 py-1 text-redlog-text">{listenAddress(status.url)}</code>
              <CopyButton text={listenAddress(status.url)} />
            </div>
            <p className="text-redlog-text-faint">{t('firstRun.http.proxyHint')}</p>
          </div>
          {status.caPath && (
            <div>
              {status.certReady !== false && status.caFingerprint && (
                <p data-testid="first-run-http-ca-download" className="text-redlog-text-dim">{t('firstRun.http.caDownload')}</p>
              )}
              <button
                type="button"
                data-testid="first-run-http-ca-toggle"
                aria-expanded={showCa}
                onClick={() => setShowCa((v) => !v)}
                className="text-redlog-text-faint underline hover:text-redlog-text"
              >
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
                  {/* Until this CA is trusted, a client that checks certificates
                      — curl, a scanner, an implant, and now the operator's own
                      browser — refuses the connection or is not proxied at all,
                      and the operator reads an HTTP-only timeline as "the
                      target used no TLS". Trusting a root CA is a change to the
                      machine, so it is typed into RedLog's terminal for the
                      operator to read and run, and the command that undoes it
                      — this CA, by fingerprint — is shown beside it. */}
                  {status.certReady !== false && status.caFingerprint && (
                    <>
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
          {!verified && (
            <div data-testid="first-run-http-own-browser" className="space-y-0.5">
              <p className="text-redlog-text-dim">{t('firstRun.http.verifyOwn')}</p>
              <div className="flex flex-wrap items-center gap-2">
                <code className="font-mono bg-redlog-bg border border-redlog-border rounded px-2 py-1 text-redlog-text break-all">{verifyUrl('https', attempt.nonce)}</code>
                <CopyButton text={verifyUrl('https', attempt.nonce)} />
              </div>
            </div>
          )}
          </div>}
          <ul data-testid="first-run-http-checks" className="space-y-1">
            <VerifyRow
              label="HTTPS"
              report={attempt.https}
              caveat={httpsCaveat}
              rejected={attempt.rejectedAt !== null}
              testId="first-run-http-check-https"
              t={t}
            />
          </ul>
          {!verified && timedOut && (
            <div data-testid="first-run-http-timeout" className="space-y-1">
              <p className="text-redlog-text">{t('firstRun.http.timeoutTitle')}</p>
              <ul className="list-disc pl-4 text-redlog-text-dim space-y-0.5">
                {httpTimeoutReasons({ certReady: status.certReady, routeTerminals, rejected: attempt.rejectedAt !== null, paused }).map((r) => (
                  <li key={r}>{t(`firstRun.http.reason.${r}`)}</li>
                ))}
              </ul>
            </div>
          )}
          <div className="flex flex-wrap gap-2">
            {browserPath === 'capture' && <Button level="secondary" onClick={() => void verifyInBrowser()} data-testid="first-run-http-verify-browser">
              {t('firstRun.http.verifyInBrowser')}
            </Button>}
            {(attempt.http || attempt.https || attempt.rejectedAt !== null || timedOut) && (
              <Button level="quiet" onClick={retry} data-testid="first-run-http-retry">{t('firstRun.http.newCheck')}</Button>
            )}
          </div>
          {status.url && timedOut && !verified && (
            <div data-testid="first-run-http-verify-commands" className="space-y-1">
              <p className="text-redlog-text-faint">{t('firstRun.http.verifyFromTool')}</p>
              <CaCommand label="HTTPS" command={verifyCommand('https', attempt.nonce, status.url, os)} t={t} />
              <p className="text-redlog-text-faint">{t('firstRun.http.verifyNoInsecure')}</p>
            </div>
          )}
        </div>
      ) : status.state === 'starting' || busy ? (
        <p className="text-redlog-text-dim">{t('httpCapture.starting')}</p>
      ) : (
        /* Use the same actions as Settings: start a stopped source, retry a
           failed/unavailable attempt. Neither action claims HTTPS is verified. */
        <div className="space-y-2">
          {status.state === 'failed' && (
            <p className="text-redlog-text-dim break-all">{status.error || t('httpCapture.failed')}</p>
          )}
          <Button level="secondary" data-testid="first-run-http-restart" onClick={() => void start()}>
            {t(status.state === 'failed' || status.state === 'unavailable' ? 'common.retry' : 'httpCapture.start')}
          </Button>
        </div>
      )}
    </section>
  )
}
