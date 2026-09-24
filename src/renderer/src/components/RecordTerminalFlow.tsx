// Spec 037: "record my terminal", inline on the first-run screen rather than a
// trip to Settings.
//
// not-installed → installed → waiting-for-activation → verified. The flow only
// says "connected" once a command carrying this attempt's nonce arrives from
// the operator's own terminal; an install that reported success is still just
// "installed". Two exits sit beside the happy path: `blocked` (preflight says a
// dependency is missing — nothing is installed until it is there) and
// `timed-out` (no event in 60 s — say the likely reasons in plain words).

import { useEffect, useRef, useState } from 'react'
import { useI18n } from '../i18n'
import { Button } from './Button'
import { writeClipboard } from '../lib/clipboard'
import { activationCommand, activationNonce, isActivationEvent, missingDependencies } from '../lib/terminalActivation'
import type { RedLogEvent } from '../../../core/db/events'

export type RecordTarget =
  | { kind: 'host'; hookId: string; label: string }
  | { kind: 'wsl'; distro: string; shell: 'bash' | 'zsh'; label: string }

type Phase =
  | 'not-installed'
  | 'blocked'
  | 'install-failed'
  | 'installed'
  | 'waiting-for-activation'
  | 'verified'
  | 'timed-out'

/** Long enough to open a tab and paste; short enough that a broken setup is
 *  named while the operator is still looking at this screen. */
const ACTIVATION_TIMEOUT_MS = 60_000

export function RecordTerminalFlow({ target }: { target: RecordTarget }): JSX.Element {
  const { t } = useI18n()
  const [phase, setPhase] = useState<Phase>('not-installed')
  const [preflight, setPreflight] = useState<RuntimePreflight | null>(null)
  const [installError, setInstallError] = useState('')
  const [nonce, setNonce] = useState('')
  // A retry, or an unmount, makes every still-pending await from the previous
  // attempt stale.
  const attempt = useRef(0)

  const run = async (): Promise<void> => {
    const mine = ++attempt.current
    const current = (): boolean => attempt.current === mine
    setPhase('not-installed')
    setInstallError('')
    try {
      if (target.kind === 'host') {
        const pf = await window.redlog.runtime.preflight()
        if (!current()) return
        setPreflight(pf)
        if (missingDependencies(pf).length > 0) { setPhase('blocked'); return }
      }
      const r = target.kind === 'host'
        ? await window.redlog.hooks.install(target.hookId)
        : await window.redlog.wsl.installHook(target.distro, target.shell)
      if (!current()) return
      if (!r.success) {
        setInstallError(('error' in r && r.error) || r.message || '')
        setPhase('install-failed')
        return
      }
    } catch (e) {
      if (!current()) return
      setInstallError(String((e as Error)?.message ?? e))
      setPhase('install-failed')
      return
    }
    setPhase('installed')
    setNonce(activationNonce())
    setPhase('waiting-for-activation')
  }

  useEffect(() => {
    void run()
    return () => { attempt.current++ }
    // One attempt per mount; retries go through run() directly.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Listen only while waiting: verification or the timeout ends it, and the
  // cleanup unsubscribes either way.
  useEffect(() => {
    if (phase !== 'waiting-for-activation' || !nonce) return
    const mine = attempt.current
    const unsub = window.redlog.events.onNewBatch((evs: RedLogEvent[]) => {
      if ((evs ?? []).some((ev) => isActivationEvent(ev, nonce))) setPhase('verified')
    })
    const timer = setTimeout(() => {
      // Re-check the machine: the reasons worth naming are the ones true now.
      const done = (pf: RuntimePreflight | null): void => {
        if (attempt.current !== mine) return
        if (pf) setPreflight(pf)
        setPhase('timed-out')
      }
      if (target.kind === 'host') window.redlog.runtime.preflight().then(done, () => done(null))
      else done(null)
    }, ACTIVATION_TIMEOUT_MS)
    return () => { clearTimeout(timer); unsub() }
  }, [phase, nonce, target.kind])

  const missing = missingDependencies(preflight)
  const command = activationCommand(nonce)

  return (
    <div className="mt-3 border-t border-redlog-border pt-3 text-xs" data-testid="record-terminal-flow" data-phase={phase}>
      {phase === 'not-installed' || phase === 'installed' ? (
        <p className="text-redlog-text-dim">{t('firstRun.record.installing', { shell: target.label })}</p>
      ) : phase === 'blocked' ? (
        <div data-testid="record-terminal-missing" className="space-y-2">
          <p className="text-redlog-text">{t('firstRun.record.blocked', { shell: target.label })}</p>
          <MissingList missing={missing} />
          <Button level="secondary" onClick={() => void run()}>{t('firstRun.recheck')}</Button>
        </div>
      ) : phase === 'install-failed' ? (
        <div className="space-y-2">
          <p className="text-redlog-text">{t('firstRun.record.installFailed', { shell: target.label })}</p>
          {installError && <p className="font-mono text-redlog-text-faint break-all">{installError}</p>}
          <Button level="secondary" onClick={() => void run()}>{t('firstRun.record.retry')}</Button>
        </div>
      ) : phase === 'verified' ? (
        <p data-testid="record-terminal-verified" className="text-emerald-500 font-medium">
          {t('firstRun.record.verified', { shell: target.label })}
        </p>
      ) : (
        <div className="space-y-2">
          <p className="text-redlog-text">{t('firstRun.record.paste')}</p>
          <div className="flex items-center gap-2">
            <code data-testid="record-terminal-command" className="flex-1 min-w-0 break-all font-mono bg-redlog-surface border border-redlog-border rounded px-2 py-1">{command}</code>
            <Button level="quiet" onClick={() => void writeClipboard(command)}>{t('firstRun.copy')}</Button>
          </div>
          {phase === 'waiting-for-activation' ? (
            <p className="text-redlog-text-faint">{t('firstRun.record.waiting')}</p>
          ) : (
            <div data-testid="record-terminal-timeout" className="space-y-1.5">
              <p className="text-redlog-text">{t('firstRun.record.timeoutTitle')}</p>
              <ul className="list-disc pl-4 space-y-1 text-redlog-text-dim">
                <li>{t('firstRun.record.reasonNewTab')}</li>
                {missing.length > 0 && (
                  <li>{t('firstRun.record.reasonMissing', { names: missing.map((c) => c.id).join(', ') })}<MissingList missing={missing} /></li>
                )}
                {target.kind === 'host' && (preflight?.legacyHooks ?? []).map((h) => (
                  <li key={`${h.file}:${h.line}`}>
                    {t('firstRun.record.reasonLegacy', { file: h.file, line: h.line })}
                    <code className="block font-mono text-redlog-text-faint break-all">{h.text}</code>
                  </li>
                ))}
              </ul>
              <Button level="secondary" onClick={() => void run()}>{t('firstRun.record.retry')}</Button>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

/** Each missing command, named exactly, with its copyable install command. */
export function MissingList({ missing }: { missing: RuntimePreflight['checks'] }): JSX.Element {
  const { t } = useI18n()
  return (
    <ul className="space-y-1">
      {missing.map((c) => (
        <li key={c.id} className="flex items-center gap-2">
          <span className="font-mono text-redlog-text">{c.id}</span>
          {c.remediation ? (
            <>
              <code className="font-mono text-redlog-text-dim">{c.remediation}</code>
              <Button level="quiet" onClick={() => void writeClipboard(c.remediation ?? '')}>{t('firstRun.copy')}</Button>
            </>
          ) : (
            <span className="text-redlog-text-faint">{t('firstRun.installManually')}</span>
          )}
        </li>
      ))}
    </ul>
  )
}
