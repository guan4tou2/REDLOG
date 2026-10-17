import { useEffect, useRef, useState } from 'react'
import { INSTALL_TIMEOUT_MS } from '../../../core/dependency-install'
import { useI18n } from '../i18n'
import { Button } from './Button'
import { CopyButton } from './CopyButton'
import { requestRunInTerminal } from '../lib/terminalRunner'

/** Optional shells are not dependencies of the selected recording path. */
export function preparationChecks(preflight: RuntimePreflight | null): RuntimePreflight['checks'] {
  if (!preflight) return []
  const selected = new Set(['mitmdump', ...(preflight.platform === 'win32' ? [] : ['python3', 'curl'])])
  if (preflight.shell) selected.add(preflight.shell.name)
  return preflight.checks.filter(c => selected.has(c.id) && !c.found)
}

function DependencyRow({ check, onRecheck }: {
  check: RuntimePreflight['checks'][number]
  onRecheck: () => void
}): JSX.Element {
  const { t } = useI18n()
  const [busy, setBusy] = useState(false)
  const [cancelled, setCancelled] = useState(false)
  const [elapsed, setElapsed] = useState(0)
  const pending = useRef(false)
  const [error, setError] = useState<string | null>(null)
  const [requires, setRequires] = useState(check.remediationRequires)
  useEffect(() => { setRequires(check.remediationRequires) }, [check])
  useEffect(() => () => {
    if (pending.current) void window.redlog.runtime.cancelInstall(check.id).catch(e => console.warn('Could not cancel dependency installation', e))
  }, [check.id])
  useEffect(() => {
    if (!busy) return
    const started = Date.now()
    setElapsed(0)
    const timer = setInterval(() => setElapsed(Math.floor((Date.now() - started) / 1000)), 1000)
    return () => clearInterval(timer)
  }, [busy])
  const install = async (): Promise<void> => {
    pending.current = true
    setBusy(true)
    setError(null)
    setCancelled(false)
    try {
      const result = await window.redlog.runtime.install(check.id)
      if (result.success) {
        setError(null)
        onRecheck()
      } else if (result.cancelled) {
        setCancelled(true)
      } else {
        setError(result.message)
        setRequires(result.needsPrereq ?? check.remediationRequires)
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      pending.current = false
      setBusy(false)
    }
  }
  const cancel = async (): Promise<void> => {
    try { await window.redlog.runtime.cancelInstall(check.id) }
    catch (e) { setError(e instanceof Error ? e.message : String(e)) }
  }
  return (
    <li data-testid={`prepare-dependency-${check.id}`} className="border border-redlog-border rounded-lg p-3 space-y-2">
      <div className="flex items-center justify-between gap-3">
        <span className="font-mono text-redlog-text">{check.id === 'mitmdump' ? 'mitmproxy' : check.id}</span>
        {requires ? (
          <Button level="secondary" data-testid={`prepare-prereq-${check.id}`} onClick={() => void window.redlog.app.openExternal(requires.url)}>
            {t('firstRun.http.installPrereq', { command: requires.command })}
          </Button>
        ) : <Button level="secondary" disabled={busy} onClick={() => void install()} data-testid={`prepare-install-${check.id}`}>
          {busy ? t('captureSetup.installing') : error || cancelled ? t('common.retry') : t('captureSetup.install')}
        </Button>}
      </div>
      {busy && (
        <div className="space-y-2 text-xs text-redlog-text-dim" data-testid={`prepare-install-status-${check.id}`}>
          <p role="status">{t('captureSetup.installWait', { minutes: INSTALL_TIMEOUT_MS / 60_000 })}</p>
          <div className="flex flex-wrap items-center gap-3">
            <span aria-live="off">{t('captureSetup.installElapsed', { seconds: elapsed })}</span>
            <Button level="quiet" data-testid={`prepare-cancel-${check.id}`} onClick={() => void cancel()}>{t('common.cancel')}</Button>
          </div>
        </div>
      )}
      {cancelled && <p role="status" data-testid={`prepare-cancelled-${check.id}`} className="text-xs text-redlog-text-dim">{t('captureSetup.installCancelled')}</p>}
      {error !== null && (
        <div role="alert" data-testid={`prepare-error-${check.id}`} className="text-xs space-y-2">
          <p className="text-amber-300 break-words">{error}</p>
          {check.remediation && (
            <>
              <p className="text-redlog-text-dim">{t('captureSetup.manual')}</p>
              <code className="block whitespace-pre-wrap break-all font-mono border border-redlog-border rounded px-2 py-1">{check.remediation}</code>
              <div className="flex flex-wrap gap-2">
                <CopyButton text={check.remediation} />
                <Button level="quiet" onClick={() => requestRunInTerminal(check.remediation!)}>{t('settings.hookRun')}</Button>
              </div>
            </>
          )}
        </div>
      )}
    </li>
  )
}

export function CapturePreparation({ preflight, failed, onRecheck, onSkip, onLeave }: {
  preflight: RuntimePreflight | null
  failed: boolean
  onRecheck: () => void
  onSkip: () => void
  onLeave: () => void
}): JSX.Element {
  const { t } = useI18n()
  return (
    <section data-testid="capture-prepare" className="w-full max-w-xl space-y-3">
      <h3 className="font-semibold text-redlog-text">{t('captureSetup.prepare')}</h3>
      {failed ? (
        <div data-testid="first-run-preflight-failed" role="alert" className="space-y-2 text-sm">
          <p>{t('firstRun.preflightFailedTitle')}</p>
          <p className="text-redlog-text-dim">{t('firstRun.preflightFailedWhy')}</p>
          <Button level="secondary" data-testid="capture-prepare-retry" onClick={onRecheck}>{t('common.retry')}</Button>
        </div>
      ) : preflight === null ? (
        <p role="status" className="text-sm text-redlog-text-dim">{t('captureSetup.checking')}</p>
      ) : (
        <>
          <p className="text-sm text-redlog-text-dim">{t('captureSetup.missing')}</p>
          <ul className="space-y-2">{preparationChecks(preflight).map(check => <DependencyRow key={check.id} check={check} onRecheck={onRecheck} />)}</ul>
        </>
      )}
      <div className="flex flex-wrap gap-3 pt-2">
        <Button level="secondary" data-testid="capture-prepare-skip" onClick={onSkip}>{t('captureSetup.skip')}</Button>
        <Button level="quiet" data-testid="first-run-later" onClick={onLeave}>{t('firstRun.core.later')}</Button>
      </div>
    </section>
  )
}
