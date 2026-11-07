import { useEffect, useRef, useState } from 'react'
import { RuntimePreparation } from '../CapturePreparation'
import { HttpCaptureStep } from '../HttpCaptureStep'
import { DEFAULT_CDP_PORT } from '../../lib/defaults'
import { FieldGroup, type ConfigState } from './SettingsShared'
import BrowserPanel from './BrowserPanel'
import { useReadState } from '../../lib/readState'
import { SetupAndTeardown } from './ManualStepList'
import { Button } from '../Button'

// The browser RedLog launches, and the HTTP capture proxy it wires that
// browser to, are capture sources: they decide what ends up in the record.
// They sat on the Network page beside the VPN and IP-exposure settings,
// which answer a different question - am I where I think I am - so an
// operator looking for 'where does my web traffic get recorded' had to
// know to look under network security to find it.
export default function BrowserPage({
  config, setConfig, t
}: {
  config: ConfigState
  setConfig: (c: ConfigState) => void
  t: (key: string, vars?: Record<string, string | number>) => string
}): JSX.Element {
  const [preparing, setPreparing] = useState(false)
  const hook = useReadState(async () => (await window.redlog.hooks.detect()).find(item => item.id === 'mitmproxy') ?? null)
  const [verify, setVerify] = useState(false)
  const [connection, setConnection] = useState<{ phase: 'idle' | 'loading' | 'success' | 'failed'; message?: string }>({ phase: 'idle' })
  const request = useRef(0)
  const port = config.browser?.cdpPort ?? DEFAULT_CDP_PORT
  useEffect(() => {
    setConnection({ phase: 'idle' })
    return () => { request.current++ }
  }, [port])
  const checkConnection = async () => {
    const id = ++request.current
    setConnection({ phase: 'loading' })
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      const tab = await Promise.race([
        (async () => { await window.redlog.cdp.setPort(port); return window.redlog.cdp.getTab() })(),
        new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(t('settings.cdpTimeout'))), 10_000) })
      ])
      if (id !== request.current) return
      setConnection(tab.connected
        ? { phase: 'success', message: t('settings.cdpConnected', { title: tab.title ?? '', url: tab.url ?? '' }) }
        : { phase: 'failed', message: tab.timedOut ? t('settings.cdpTimeout') : t('settings.cdpNotConnected', { port: String(port) }) })
    } catch (error) {
      if (id === request.current) setConnection({ phase: 'failed', message: error instanceof Error ? error.message : String(error) })
    } finally { clearTimeout(timer) }
  }
  return (
    <>
      <div className="mb-4">
        <Button level="secondary" aria-expanded={verify} aria-controls="http-verification-panel" onClick={() => setVerify(open => !open)}>{t('firstRun.http.verifySettings')}</Button>
        {verify && <div id="http-verification-panel" className="mt-3"><HttpCaptureStep onPrepare={() => setPreparing(true)} /></div>}
      </div>
      {preparing && <RuntimePreparation source="web" onClose={() => setPreparing(false)} />}
      <BrowserPanel t={t} config={config} setConfig={setConfig} />
      {hook.state.phase === 'failed' && <div role="alert" className="text-xs text-redlog-danger">
        {hook.state.error} <Button size="compact" level="quiet" onClick={hook.retry}>{t('common.retry')}</Button>
      </div>}
      {hook.state.value && <details className="mb-4">
        <summary className="min-h-8 cursor-pointer text-xs text-redlog-text content-center">{t('settings.hookOptionalSteps')}</summary>
        <SetupAndTeardown setup={hook.state.value.manualSteps} teardown={hook.state.value.removalSteps} t={t} />
      </details>}
      <FieldGroup title={t('settings.cdp')}>
        <p className="text-xs text-redlog-text-faint mb-2">
          {t('settings.cdpHint', { port: String(config.browser?.cdpPort ?? DEFAULT_CDP_PORT) })}
        </p>
        <Button level="secondary" disabled={connection.phase === 'loading'} onClick={() => void checkConnection()}>
          {connection.phase === 'loading' ? t('common.loading') : connection.phase === 'failed' ? t('settings.cdpRetry') : t('settings.testConnection')}
        </Button>
        {connection.message && <p data-testid="cdp-connection-result" role={connection.phase === 'failed' ? 'alert' : 'status'} className={`mt-2 text-xs ${connection.phase === 'failed' ? 'text-redlog-danger' : 'text-redlog-text'}`}>{connection.message}</p>}
      </FieldGroup>
    </>
  )
}
