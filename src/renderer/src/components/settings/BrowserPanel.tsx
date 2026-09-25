import { useState, useEffect } from 'react'
import { toast } from '../Toast'
import { DEFAULT_CDP_PORT, DEFAULT_CAPTURE_PORT, DEFAULT_CAPTURE_HOST } from '../../lib/defaults'
import { FieldGroup, Field, type ConfigState } from './SettingsShared'
import { followCaptureEndpoint, isLoopbackHost } from '../../../../core/managed-proxy-url'
import { DEFAULT_BROWSER } from '../../../../core/browser-defaults'

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
  const [proxyStatus, setProxyStatus] = useState<ManagedProxyStatus>({ state: 'stopped', url: null })

  useEffect(() => {
    window.redlog.browser.detect().then(setDetected).catch(() => setDetected(null))
    window.redlog.httpCapture.status().then(setProxyStatus).catch(() => {})
  }, [])

  const patch = (delta: Partial<typeof b>): void => {
    setConfig({ ...config, browser: { ...b, ...delta } })
  }

  return (
    <FieldGroup title={t('settings.browser')}>
      <p className="text-xs text-redlog-text-faint">{t('settings.browserHint')}</p>
      <Field label={t('settings.browserBinary')} value={b.binary} onChange={(v) => patch({ binary: v })} />
      <p className="text-xs text-redlog-text-faint font-mono break-all">
        {detected ? t('settings.browserDetected', { path: detected }) : t('settings.browserNotFound')}
      </p>
      <Field label={t('settings.browserProxy')} value={b.proxy} onChange={(v) => patch({ proxy: v })} />
      <Field
        label={t('settings.httpCapturePort')}
        value={String(httpCapture.port)}
        onChange={(v) => {
          const port = Math.min(65535, Math.max(1024, parseInt(v) || DEFAULT_CAPTURE_PORT))
          setConfig({
            ...config,
            httpCapture: { ...httpCapture, port },
            browser: {
              ...b,
              proxy: followCaptureEndpoint(b.proxy, { host: listenHost, port: httpCapture.port }, { host: listenHost, port })
            }
          })
        }}
        type="number"
      />
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
      <label className="flex items-center gap-2 cursor-pointer">
        <input type="checkbox" checked={httpCapture.routeTerminals === true}
          onChange={(e) => setConfig({ ...config, httpCapture: { ...httpCapture, routeTerminals: e.target.checked } })}
          className="accent-red-600" />
        <span className="text-xs text-redlog-text-dim">{t('settings.routeTerminals')}</span>
      </label>
      <p className="text-xs text-redlog-text-faint">{t('settings.routeTerminalsHint')}</p>
      <div className="flex items-center gap-2 text-xs">
        <span className={proxyStatus.state === 'running' ? 'text-emerald-400' : proxyStatus.state === 'failed' || proxyStatus.state === 'unavailable' ? 'text-red-400' : 'text-redlog-text-faint'}>
          {t(`httpCapture.state.${proxyStatus.state}`)}{proxyStatus.url ? ` · ${proxyStatus.url}` : ''}
        </span>
        <button
          onClick={async () => setProxyStatus(proxyStatus.state === 'running'
            ? await window.redlog.httpCapture.stop()
            : await window.redlog.httpCapture.start())}
          className="px-2 py-1 bg-redlog-elevated text-redlog-text rounded hover:bg-redlog-elevated-hover"
        >
          {proxyStatus.state === 'running' ? t('httpCapture.stop') : t('httpCapture.start')}
        </button>
      </div>
      {proxyStatus.error && <p className="text-xs text-red-400 break-all">{proxyStatus.error}</p>}
      {proxyStatus.caPath && (
        <p className={`text-xs break-all ${proxyStatus.certReady ? 'text-redlog-text-faint' : 'text-amber-400'}`}>
          {proxyStatus.certReady
            ? t('httpCapture.caReady', { path: proxyStatus.caPath })
            : t('httpCapture.caMissing', { path: proxyStatus.caPath })}
        </p>
      )}
      <Field
        label={t('settings.cdpPort')}
        value={String(b.cdpPort)}
        onChange={(v) => patch({ cdpPort: parseInt(v) || DEFAULT_CDP_PORT })}
        type="number"
      />
      <Field label={t('settings.browserStartUrl')} value={b.startUrl} onChange={(v) => patch({ startUrl: v })} />
      <label className="flex items-center gap-2 cursor-pointer">
        <input
          type="checkbox"
          checked={b.isolateProfile}
          onChange={(e) => patch({ isolateProfile: e.target.checked })}
          className="accent-red-600"
        />
        <span className="text-xs text-redlog-text-dim">{t('settings.browserIsolate')}</span>
      </label>
      <label className="flex items-center gap-2 cursor-pointer">
        <input
          type="checkbox"
          checked={b.ignoreCertErrors}
          onChange={(e) => patch({ ignoreCertErrors: e.target.checked })}
          className="accent-red-600"
        />
        <span className="text-xs text-redlog-text-dim">{t('settings.browserIgnoreCert')}</span>
      </label>
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
