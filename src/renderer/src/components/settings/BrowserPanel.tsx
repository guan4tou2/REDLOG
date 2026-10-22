import { useState, useEffect } from 'react'
import { toast } from '../Toast'
import { DEFAULT_CDP_PORT, DEFAULT_CAPTURE_PORT, DEFAULT_CAPTURE_HOST } from '../../lib/defaults'
import { FieldGroup, Field, type ConfigState } from './SettingsShared'
import { CheckRow } from './CheckRow'
import { followCaptureEndpoint, isLoopbackHost } from '../../../../core/managed-proxy-url'
import { DEFAULT_BROWSER } from '../../../../core/browser-defaults'
import { CaCommand, caTrustCommand, caUntrustCommand, thisOs } from '../HttpCaptureStep'
import { CopyButton } from '../CopyButton'
import { useReadState } from '../../lib/readState'
import { useRevalidateOnFocus } from '../../hooks/useRevalidateOnFocus'

const listenerOf = (url: string): string => { try { return new URL(url).host } catch { return url } }

export default function BrowserPanel({
  t, config, setConfig
}: {
  t: (key: string, vars?: Record<string, string | number>) => string
  config: ConfigState
  setConfig: (c: ConfigState) => void
}): JSX.Element {
  const b = config.browser ?? { ...DEFAULT_BROWSER, extraArgs: [] }
  const httpCapture = config.httpCapture ?? { port: DEFAULT_CAPTURE_PORT, listenHost: DEFAULT_CAPTURE_HOST }
  const listenHost = (httpCapture.listenHost ?? DEFAULT_CAPTURE_HOST) || DEFAULT_CAPTURE_HOST
  const exposed = !isLoopbackHost(listenHost)
  const [detected, setDetected] = useState<string | null>(null)
  const proxyRead = useReadState(async () => {
    const status = await window.redlog.httpCapture.status()
    if (!status || !['stopped', 'starting', 'running', 'unavailable', 'failed'].includes(status.state)) throw new Error(t('httpCapture.statusUnknown'))
    return status
  })
  const proxyStatus = proxyRead.state.value ?? { state: 'stopped' as const, url: null }
  const proxyKnown = proxyRead.state.phase === 'loaded'
  const [proxyBusy, setProxyBusy] = useState(false)
  const [proxyActionError, setProxyActionError] = useState<string | null>(null)
  const [staleTerminals, setStaleTerminals] = useState(0)
  const [portDraft, setPortDraft] = useState(String(httpCapture.port))
  const [portError, setPortError] = useState<string | null>(null)

  useRevalidateOnFocus(() => { if (!proxyBusy) proxyRead.retry() })
  // Opening Settings may catch an auto-start already in progress. Recheck
  // that transition rather than leaving its disabled button stuck forever.
  useEffect(() => {
    if (!proxyKnown || proxyBusy || proxyStatus.state !== 'starting') return
    const timer = setTimeout(proxyRead.retry, 1000)
    return () => clearTimeout(timer)
  }, [proxyKnown, proxyBusy, proxyStatus.state, proxyRead.retry])

  useEffect(() => {
    setPortDraft(String(httpCapture.port))
    setPortError(null)
  }, [httpCapture.port, config.engagement?.id])

  useEffect(() => {
    window.redlog.browser.detect().then(setDetected).catch(() => setDetected(null))
  }, [])

  const patch = (delta: Partial<typeof b>): void => {
    setConfig({ ...config, browser: { ...b, ...delta } })
  }

  const commitPort = (): void => {
    const port = Number(portDraft)
    if (!/^\d+$/.test(portDraft) || !Number.isInteger(port) || port < 1024 || port > 65535) {
      setPortError(t('settings.httpCapturePortInvalid'))
      return
    }
    setPortError(null)
    setPortDraft(String(port))
    if (port === httpCapture.port) return
    setConfig({
      ...config,
      httpCapture: { ...httpCapture, port },
      browser: {
        ...b,
        proxy: followCaptureEndpoint(b.proxy, { host: listenHost, port: httpCapture.port }, { host: listenHost, port })
      }
    })
  }

  const toggleCapture = async (): Promise<void> => {
    if (proxyRead.state.phase === 'failed') { proxyRead.retry(); return }
    if (!proxyKnown || proxyBusy || proxyStatus.state === 'starting') return
    setProxyBusy(true)
    setProxyActionError(null)
    try {
      if (proxyStatus.state === 'running') {
        const { staleTerminals: stale, ...stopped } = await window.redlog.httpCapture.stop()
        proxyRead.update(() => stopped)
        setStaleTerminals(stale ?? 0)
      } else {
        setStaleTerminals(0)
        const started = await window.redlog.httpCapture.start()
        proxyRead.update(() => started)
      }
    } catch (error) {
      setProxyActionError(error instanceof Error ? error.message : String(error))
      // A rejected reply does not prove the action never happened. Read the
      // actual process state before offering the next action; never replay it.
      proxyRead.retry()
    } finally { setProxyBusy(false) }
  }

  return (
    <FieldGroup title={t('settings.browser')}>
      <Field label={t('settings.browserBinary')} value={b.binary} onChange={(v) => patch({ binary: v })} />
      <p className="text-xs text-redlog-text-faint font-mono break-all">
        {detected ? t('settings.browserDetected', { path: detected }) : t('settings.browserNotFound')}
      </p>
      <Field label={t('settings.browserProxy')} value={b.proxy} onChange={(v) => patch({ proxy: v })} />
      <Field
        label={t('settings.httpCapturePort')}
        value={portDraft}
        onChange={(value) => { setPortDraft(value); setPortError(null) }}
        onBlur={commitPort}
        onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); event.currentTarget.blur() } }}
        error={portError}
        type="number"
      />
      {portDraft !== String(httpCapture.port) && !portError && <p role="status" className="text-xs text-amber-400">{t('settings.httpCapturePortPending')}</p>}
      <p className="text-xs text-redlog-text-faint">{t('settings.httpCapturePortHint')}</p>
      <Field
        label={t('settings.httpCaptureHost')}
        value={listenHost}
        onChange={(v) => {
          const host = v.trim() || DEFAULT_CAPTURE_HOST
          setConfig({
            ...config,
            httpCapture: { ...httpCapture, listenHost: host },
            browser: {
              ...b,
              proxy: followCaptureEndpoint(b.proxy, { host: listenHost, port: httpCapture.port }, { host, port: httpCapture.port })
            }
          })
        }}
      />
      <p className="text-xs text-redlog-text-faint">{t('settings.httpCaptureHostHint')}</p>
      {/* Binding off loopback is a deliberate, sometimes necessary choice — a
          victim VM or a NAT'd WSL distro cannot reach 127.0.0.1 on this
          machine — and it is also an open proxy on the engagement network.
          Say so where the choice is made, not in a doc. */}
      {exposed && (
        <p data-testid="http-capture-exposed-warning" className="text-xs text-amber-400">
          {t('settings.httpCaptureExposedWarning', { host: listenHost })}
        </p>
      )}
      <CheckRow
        checked={httpCapture.routeTerminals === true}
        onChange={(on) => setConfig({ ...config, httpCapture: { ...httpCapture, routeTerminals: on } })}
        label={t('settings.routeTerminals')}
      />
      <p className="text-xs text-redlog-text-faint">{t('settings.routeTerminalsHint')}</p>
      <div className="flex items-center gap-2 text-xs">
        <span className={proxyKnown && proxyStatus.state === 'running' ? 'text-emerald-400' : proxyRead.state.phase === 'failed' || proxyStatus.state === 'failed' || proxyStatus.state === 'unavailable' ? 'text-red-400' : 'text-redlog-text-faint'}>
          {proxyRead.state.phase === 'loading' ? t('common.loading') : !proxyKnown ? t('httpCapture.statusUnknown') : t(`httpCapture.state.${proxyStatus.state}`)}{proxyKnown && proxyStatus.url ? ` · ${proxyStatus.url}` : ''}
        </span>
        <button
          data-testid="http-capture-toggle"
          disabled={proxyBusy || proxyRead.state.phase === 'loading' || (proxyKnown && proxyStatus.state === 'starting')}
          onClick={() => void toggleCapture()}
          className="px-2 py-1 bg-redlog-elevated text-redlog-text rounded hover:bg-redlog-elevated-hover disabled:opacity-40"
        >
          {proxyRead.state.phase === 'failed' ? t('common.retry')
            : proxyRead.state.phase === 'loading' ? t('common.loading')
              : proxyBusy ? t(proxyStatus.state === 'running' ? 'httpCapture.stopping' : 'httpCapture.starting')
                : proxyStatus.state === 'starting' ? t('httpCapture.starting')
                  : proxyStatus.state === 'running' ? t('httpCapture.stop')
                    : proxyStatus.state === 'failed' || proxyStatus.state === 'unavailable' ? t('common.retry') : t('httpCapture.start')}
        </button>
      </div>
      {proxyRead.state.phase === 'failed' && <p role="alert" className="text-xs text-red-400 break-all">{proxyRead.state.error}</p>}
      {proxyActionError && <p role="alert" className="text-xs text-red-400 break-all">{proxyActionError}</p>}
      {proxyStatus.error && <p className="text-xs text-red-400 break-all">{proxyStatus.error}</p>}
      {/* The listener, as Burp shows it: the address to put in your own
          browser's proxy settings. */}
      {proxyKnown && proxyStatus.state === 'running' && proxyStatus.url && (
        <div data-testid="http-capture-listener" className="flex flex-wrap items-center gap-2 text-xs">
          <span className="text-redlog-text-dim">{t('settings.proxyListener')}</span>
          <code className="font-mono bg-redlog-bg border border-redlog-border rounded px-2 py-1 text-redlog-text">{listenerOf(proxyStatus.url)}</code>
          <CopyButton text={listenerOf(proxyStatus.url)} />
        </div>
      )}
      {proxyStatus.state !== 'running' && staleTerminals > 0 && (
        <p data-testid="http-capture-stale-terminals" className="text-xs text-amber-400">
          {t('httpCapture.staleTerminals', { count: staleTerminals })}
        </p>
      )}
      {proxyStatus.caPath && (
        <>
          <p className={`text-xs break-all ${proxyStatus.certReady ? 'text-redlog-text-faint' : 'text-amber-400'}`}>
            {proxyStatus.certReady
              ? t('httpCapture.caReady', { path: proxyStatus.caPath })
              : t('httpCapture.caMissing', { path: proxyStatus.caPath })}
          </p>
          {/* Which trust store each kind of tool reads. Reference material, so
              it sits with the setting rather than on the first-run screen,
              where it was four clauses between the operator and a check. */}
          <p className="text-xs text-redlog-text-faint leading-relaxed">{t('httpCapture.caTrustStores')}</p>
          {/* The same by-fingerprint command the first-run step shows beside
              the one that trusts it. This is where an operator comes back to
              at the end of an engagement, and a root CA left behind is the
              longest-lived thing RedLog can leave on a machine. */}
          {proxyStatus.caFingerprint && (
            <div data-testid="http-capture-untrust" className="text-xs space-y-1.5">
              <CaCommand
                label={t('httpCapture.caTrust')}
                command={caTrustCommand(proxyStatus.caPath, proxyStatus.caFingerprint, thisOs())}
                t={t}
              />
              <CaCommand
                label={t('httpCapture.caUntrust')}
                command={caUntrustCommand(proxyStatus.caPath, proxyStatus.caFingerprint, thisOs())}
                t={t}
              />
            </div>
          )}
        </>
      )}
      <Field
        label={t('settings.cdpPort')}
        value={String(b.cdpPort)}
        onChange={(v) => patch({ cdpPort: parseInt(v) || DEFAULT_CDP_PORT })}
        type="number"
      />
      <Field label={t('settings.browserStartUrl')} value={b.startUrl} onChange={(v) => patch({ startUrl: v })} />
      <CheckRow
        checked={b.isolateProfile}
        onChange={(on) => patch({ isolateProfile: on })}
        label={t('settings.browserIsolate')}
      />
      <CheckRow
        checked={b.ignoreCertErrors}
        onChange={(on) => patch({ ignoreCertErrors: on })}
        label={t('settings.browserIgnoreCert')}
      />
      <button
        onClick={async () => {
          const r = await window.redlog.browser.launch()
          toast(r.ok ? t('browser.launched') : (r.error || t('browser.failed')), r.ok ? 'success' : 'error')
        }}
        className="px-3 py-1.5 bg-redlog-elevated text-redlog-text text-xs rounded hover:bg-redlog-elevated-hover"
      >
        {t('browser.launch')}
      </button>
    </FieldGroup>
  )
}
