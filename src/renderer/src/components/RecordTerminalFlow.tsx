// Spec 037: "record my terminal", inline on the first-run screen rather than a
// trip to Settings.
//
// not-installed → installed → waiting-for-activation → verified. The flow only
// says "connected" once a command carrying this attempt's nonce arrives from
// the operator's own terminal; an install that reported success is still just
// "installed". Two exits sit beside the happy path: `blocked` (preflight says a
// dependency is missing — nothing is installed until it is there) and
// `timed-out` (no event in 60 s — say the likely reasons in plain words).
//
// The shell is a *recommendation* now, not a decision made for the operator.
// Preflight answers with the login shell; `hooks.detect()` answers which fixed
// adapters this host actually has. The two are shown together — the detected
// one recommended, every other hookable one selectable — because the operator
// who works in bash behind a zsh login was previously left with a hook for a
// shell they do not use and a timeout that named nothing about it.
//
// The choice governs everything downstream: which adapter is installed, whose
// prerequisites are read from preflight, and which shell's event may carry the
// nonce. Changing it starts a fresh attempt and marks the old one stale, so an
// install that lands late cannot report on the shell that replaced it.

import { useEffect, useRef, useState } from 'react'
import { useI18n } from '../i18n'
import { Button } from './Button'
import { CopyButton } from './CopyButton'
import {
  activationCommand,
  activationNonce,
  isActivationEvent,
  missingDependencies,
  hostAdapterChoices,
  shellNameForHook,
  SET_EXECUTION_POLICY,
  type AdapterChoice,
  type ShellName
} from '../lib/terminalActivation'
import { requestRunInTerminal } from '../lib/terminalRunner'
import { useRevalidateOnFocus } from '../hooks/useRevalidateOnFocus'
import { classifyCanaryEvent, mergeCanary, outputCanary, type CanaryResult } from '../lib/outputCanary'
import type { RedLogEvent } from '../../../core/db/events'

export type RecordTarget =
  | { kind: 'host'; hookId: string; label: string }
  | { kind: 'wsl'; distro: string; shell: 'bash' | 'zsh'; label: string }

type Phase =
  | 'not-installed'
  | 'blocked'
  | 'detect-failed'
  | 'unavailable'
  | 'install-failed'
  | 'installed'
  | 'waiting-for-activation'
  | 'verified'
  | 'timed-out'

/** Long enough to open a tab and paste; short enough that a broken setup is
 *  named while the operator is still looking at this screen. */
const ACTIVATION_TIMEOUT_MS = 60_000

/** Which adapter the flow actually installs.
 *
 *  The detected one wins when it exists here; when it does not, it stays
 *  selected so the screen can say why rather than silently swapping in a shell
 *  the operator did not ask for. Only with no recommendation at all does the
 *  first available adapter become the default. */
function pickInitialAdapter(choices: AdapterChoice[], recommended: string | null): string | null {
  if (choices.length === 0) return recommended
  if (recommended && choices.some((c) => c.hookId === recommended)) return recommended
  return choices.find((c) => c.available)?.hookId ?? choices[0].hookId
}

export function RecordTerminalFlow({ target, onPrepare, onSelectedLabel }: {
  target: RecordTarget
  onPrepare: () => void
  /** Which shell the flow is actually driving. The entry button above names the
   *  detected shell as the recommendation, but the picker inside can select a
   *  different one and everything downstream follows *that* — replying up keeps
   *  the button from advertising a shell the operator has just replaced. */
  onSelectedLabel?: (label: string) => void
}): JSX.Element {
  const { t } = useI18n()
  const [phase, setPhase] = useState<Phase>('not-installed')
  const [preflight, setPreflight] = useState<RuntimePreflight | null>(null)
  const [installError, setInstallError] = useState('')
  const [nonce, setNonce] = useState('')
  const [choices, setChoices] = useState<AdapterChoice[]>([])
  const recommended = target.kind === 'host' ? target.hookId : null
  const [selectedHook, setSelectedHook] = useState<string | null>(recommended)
  // WSL has one path and no picker, so it is "detected" from the first frame.
  const [detected, setDetected] = useState(target.kind !== 'host')
  const [detectVersion, setDetectVersion] = useState(0)
  const wslDistro = target.kind === 'wsl' ? target.distro : null
  const wslShell = target.kind === 'wsl' ? target.shell : null
  // A retry, a new selection, or an unmount makes every still-pending await
  // from the previous attempt stale.
  const attempt = useRef(0)

  // Which fixed adapters the backend reports on this host. A read, and the only
  // source for the picker: an adapter the backend cannot see is not offered as
  // selected and connected on the strength of an install that copied files.
  useEffect(() => {
    if (target.kind !== 'host') return
    let live = true
    attempt.current++
    setDetected(false)
    setPhase('not-installed')
    window.redlog.hooks.detect()
      .then((hooks) => {
        if (!live) return
        const found = hostAdapterChoices(hooks ?? [], window.redlog.platform ?? '')
        setChoices(found)
        setSelectedHook(pickInitialAdapter(found, recommended))
        setDetected(true)
      })
      .catch((error) => {
        if (!live) return
        setInstallError(String(error instanceof Error ? error.message : error))
        setPhase('detect-failed')
      })
    return () => { live = false }
  }, [recommended, target.kind, detectVersion])

  const selectedChoice = choices.find((c) => c.hookId === selectedHook) ?? null
  const expectedShell: ShellName | null = target.kind === 'wsl'
    ? target.shell
    : selectedChoice?.shell ?? shellNameForHook(selectedHook)
  const activeLabel = selectedChoice?.label ?? target.label

  // Only while the flow is open for this target: each reply is the label the
  // flow's own texts already use, so the button and the flow can never
  // disagree about which install is running.
  useEffect(() => {
    if (target.kind === 'host' && detected) onSelectedLabel?.(activeLabel)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target.kind, detected, selectedHook, choices, activeLabel])

  const run = async (override?: string | null): Promise<void> => {
    const mine = ++attempt.current
    const current = (): boolean => attempt.current === mine
    setPhase('not-installed')
    setInstallError('')
    setNonce('')
    const hookId = target.kind === 'host' ? (override === undefined ? selectedHook : override) : null
    try {
      if (target.kind === 'host') {
        if (!hookId) { setPhase('unavailable'); return }
        const pf = await window.redlog.runtime.preflight()
        if (!current()) return
        setPreflight(pf)
        if (missingDependencies(pf, hookId).length > 0) { setPhase('blocked'); return }
        const choice = choices.find((c) => c.hookId === hookId)
        if (!choice?.available) { setPhase('unavailable'); return }
        const r = await window.redlog.hooks.install(hookId)
        if (!current()) return
        if (!r.success) {
          setInstallError(('error' in r && r.error) || r.message || '')
          setPhase('install-failed')
          return
        }
      } else {
        const r = await window.redlog.wsl.installHook(target.distro, target.shell)
        if (!current()) return
        if (!r.success) {
          setInstallError(r.message || '')
          setPhase('install-failed')
          return
        }
      }
    } catch (e) {
      if (!current()) return
      setInstallError(String((e as Error)?.message ?? e))
      setPhase('install-failed')
      return
    }
    if (!current()) return
    setPhase('installed')
    setNonce(activationNonce())
    setPhase('waiting-for-activation')
  }

  // One attempt once the adapter list has settled, and a fresh one whenever the
  // selection changes. The cleanup marks the previous attempt stale, so an
  // install or preflight it was still awaiting cannot land on the new choice.
  //
  // Keyed on `detected` and `selectedHook`, never on `run` or `target`: the
  // parent re-creates the target object on every render, so keying on identity
  // would re-install in a loop.
  useEffect(() => {
    if (!detected) return
    void run()
    return () => { attempt.current++ }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [detected, selectedHook, target.kind, wslDistro, wslShell])

  // Blocked means a dependency was missing, and the operator has gone to
  // install it. Coming back re-runs the attempt: the click that started this
  // flow was already consent to install the hook, and it is only the missing
  // dependency that held it. Every other phase is waiting on an event or on a
  // failure the operator must retry themselves, so none of them re-runs here.
  useRevalidateOnFocus(() => { if (phase === 'blocked') void run() })

  // Listen only while waiting: verification or the timeout ends it, and the
  // cleanup unsubscribes either way.
  useEffect(() => {
    if (phase !== 'waiting-for-activation' || !nonce) return
    const mine = attempt.current
    const unsub = window.redlog.events.onNewBatch((evs: RedLogEvent[]) => {
      if (attempt.current !== mine) return
      if ((evs ?? []).some((ev) => isActivationEvent(ev, nonce, expectedShell, wslDistro))) setPhase('verified')
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
  }, [phase, nonce, target.kind, expectedShell, wslDistro])

  const missing = missingDependencies(preflight, target.kind === 'host' ? selectedHook ?? undefined : undefined)
  const command = activationCommand(nonce, expectedShell)

  // Changing the shell throws away the attempt that was in flight for the old
  // one: its nonce, its install, its waiting state. It is not "retry" — there
  // is nothing to retry — so no error is kept either.
  const selectAdapter = (hookId: string): void => {
    if (hookId === selectedHook) return
    attempt.current++
    setNonce('')
    setSelectedHook(hookId)
  }

  return (
    <div className="mt-3 border-t border-redlog-border pt-3 text-xs" data-testid="record-terminal-flow" data-phase={phase}>
      {target.kind === 'host' && phase !== 'detect-failed' && (choices.length > 1 || !detected || phase === 'unavailable') && (
        <AdapterPicker
          choices={choices}
          selectedHook={selectedHook}
          recommended={recommended}
          detected={detected}
          onSelect={selectAdapter}
        />
      )}
      {phase === 'detect-failed' ? (
        <div data-testid="record-terminal-detect-failed" role="alert" className="space-y-2">
          <p>{t('firstRun.record.detectFailed')}</p>
          <p className="text-redlog-text-faint break-all">{installError}</p>
          <Button level="secondary" onClick={() => setDetectVersion((v) => v + 1)}>{t('common.retry')}</Button>
        </div>
      ) : phase === 'not-installed' || phase === 'installed' ? (
        <p className="text-redlog-text-dim">
          {detected ? t('firstRun.record.installing', { shell: activeLabel }) : t('firstRun.record.detecting')}
        </p>
      ) : phase === 'blocked' ? (
        <div data-testid="record-terminal-missing" className="space-y-2">
          <p className="text-redlog-text">{t('firstRun.record.blocked', { shell: activeLabel })}</p>
          <p className="text-redlog-text-dim">{t('firstRun.record.reasonMissing', { names: missing.map(c => c.id).join(', ') })}</p>
          <Button level="secondary" onClick={onPrepare}>{t('captureSetup.openPreparation')}</Button>
        </div>
      ) : phase === 'unavailable' ? (
        <div data-testid="record-terminal-unavailable" className="space-y-2">
          <p className="text-redlog-text">{t('firstRun.record.adapterUnavailableWhy', { shell: activeLabel })}</p>
          <p className="text-redlog-text-dim">{t('firstRun.record.adapterUnavailableHint')}</p>
          <Button level="secondary" onClick={() => setDetectVersion((v) => v + 1)}>{t('common.retry')}</Button>
        </div>
      ) : phase === 'install-failed' ? (
        <div data-testid="record-terminal-install-failed" className="space-y-2">
          <p className="text-redlog-text">{t('firstRun.record.installFailed', { shell: activeLabel })}</p>
          {installError && <p className="font-mono text-redlog-text-faint break-all">{installError}</p>}
          <Button level="secondary" onClick={() => void run()}>{t('firstRun.record.retry')}</Button>
        </div>
      ) : phase === 'verified' ? (
        <VerifiedScope shell={expectedShell ?? 'bash'} label={activeLabel} />
      ) : (
        <div className="space-y-2">
          <p className="text-redlog-text">{t('firstRun.record.paste')}</p>
          <div className="flex items-center gap-2">
            <code data-testid="record-terminal-command" className="flex-1 min-w-0 break-all font-mono bg-redlog-surface border border-redlog-border rounded px-2 py-1">{command}</code>
            <CopyButton text={command} />
          </div>
          {phase === 'waiting-for-activation' ? (
            <p className="text-redlog-text-faint">{t('firstRun.record.waiting')}</p>
          ) : (
            <div data-testid="record-terminal-timeout" className="space-y-1.5">
              <p className="text-redlog-text">{t('firstRun.record.timeoutTitle')}</p>
              <ul className="list-disc pl-4 space-y-1 text-redlog-text-dim">
                <li>{t('firstRun.record.reasonNewTab')}</li>
                {/* Re-read at timeout, so this is the policy in force now —
                    the operator may have changed it while waiting. */}
                {preflight?.powershell?.blocksProfile && (
                  <li data-testid="record-terminal-reason-policy">
                    {t('firstRun.record.reasonPolicy', {
                      policy: preflight.powershell.policy,
                      command: SET_EXECUTION_POLICY
                    })}
                  </li>
                )}
                {missing.length > 0 && (
                  <li>{t('firstRun.record.reasonMissing', { names: missing.map((c) => c.id).join(', ') })}<Button level="secondary" onClick={onPrepare}>{t('captureSetup.openPreparation')}</Button></li>
                )}
              </ul>
              <Button level="secondary" onClick={() => void run()}>{t('firstRun.record.retry')}</Button>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

/** The detected/recommended adapter and every other hookable one on this host.
 *
 *  Only shown once there is more than one to choose from, while detection is
 *  still running, or when the selection turned out to be unavailable — a
 *  one-adapter host has nothing to decide and does not get a decision to make.
 *  An unavailable adapter is listed but not selectable: it explains itself,
 *  rather than disappearing and leaving the operator to guess why. */
function AdapterPicker({ choices, selectedHook, recommended, detected, onSelect }: {
  choices: AdapterChoice[]
  selectedHook: string | null
  recommended: string | null
  detected: boolean
  onSelect: (hookId: string) => void
}): JSX.Element {
  const { t } = useI18n()
  if (!detected) {
    return <p data-testid="record-terminal-detecting" className="text-redlog-text-faint mb-2">{t('firstRun.record.detecting')}</p>
  }
  return (
    <div data-testid="record-terminal-adapters" className="mb-2 space-y-1.5">
      <p className="text-redlog-text-faint">{t('firstRun.record.adapterTitle')}</p>
      <div className="flex flex-wrap gap-1.5" role="radiogroup" aria-label={t('firstRun.record.adapterTitle')}>
        {choices.map((c) => {
          const selected = c.hookId === selectedHook
          return (
            <button
              key={c.hookId}
              type="button"
              role="radio"
              aria-checked={selected}
              disabled={!c.available}
              onClick={() => onSelect(c.hookId)}
              data-testid={`record-terminal-adapter-${c.hookId}`}
              data-selected={selected ? 'true' : 'false'}
              data-available={c.available ? 'true' : 'false'}
              className={`flex items-center gap-1.5 px-2.5 py-1 rounded border text-xs transition-colors ${
                selected
                  ? 'border-redlog-accent text-redlog-text bg-redlog-elevated'
                  : 'border-redlog-border text-redlog-text-dim hover:text-redlog-text hover:bg-redlog-elevated'
              } ${c.available ? '' : 'opacity-60 cursor-not-allowed'}`}
            >
              {c.label}
              {c.hookId === recommended && (
                <span data-testid={`record-terminal-adapter-detected-${c.hookId}`} className="text-xs text-redlog-text-faint">
                  {t('firstRun.record.adapterDetected')}
                </span>
              )}
              {!c.available && (
                <span className="text-xs text-amber-400">{t('firstRun.record.adapterUnavailable')}</span>
              )}
            </button>
          )
        })}
      </div>
      {/* The hook is a file on the operator's machine. Settings ▸ 掛勾 owns
          turning it off again, so the flow says where rather than implying the
          choice here is one-way. */}
      <p className="text-redlog-text-faint">{t('firstRun.record.adapterRecoverable')}</p>
    </div>
  )
}

/** The Windows blocker that is not a missing command (F6).
 *
 *  `Restricted` — the Windows client default for PowerShell 5.1 — stops
 *  `$PROFILE` from loading, so the hook RedLog installed never runs. The
 *  built-in terminal is spawned with `-ExecutionPolicy Bypass` and keeps
 *  recording, so both halves have to be said: without the second one the
 *  operator reads a working built-in pane beside a silent terminal as a broken
 *  machine rather than as one policy. */
export function ExecutionPolicyBlocker({ blocker }: {
  blocker: { policy: string; remediation: string }
}): JSX.Element {
  const { t } = useI18n()
  return (
    <div data-testid="execution-policy-blocker" className="space-y-2">
      <p className="font-semibold text-redlog-text">{t('firstRun.policy.title')}</p>
      <p className="text-redlog-text-dim">{t('firstRun.policy.why', { policy: blocker.policy })}</p>
      <p className="text-redlog-text-faint">{t('firstRun.policy.builtinOk')}</p>
      <p className="text-redlog-text-dim">{t('firstRun.policy.fix')}</p>
      <div className="flex items-center gap-2">
        <code data-testid="execution-policy-command" className="flex-1 min-w-0 break-all font-mono bg-redlog-surface border border-redlog-border rounded px-2 py-1">
          {blocker.remediation}
        </code>
        <CopyButton text={blocker.remediation} />
      </div>
      <div className="flex flex-wrap gap-2">
        {/* Typed into RedLog's own terminal, not executed for the operator: it
            changes a machine-wide-ish setting, so they read it and press
            Enter themselves — the same rule the CA trust command follows. */}
        <Button level="secondary" onClick={() => requestRunInTerminal(blocker.remediation)}>
          {t('settings.hookRun')}
        </Button>
      </div>
    </div>
  )
}

/** Spec 039: "connected" is not "the session is recorded". Where the adapter
 *  records only command metadata, the verified state says so and names the way
 *  to keep output; where it records output by itself (zsh, spec 052), it says
 *  that instead of borrowing the caveat this component was written for. */
function VerifiedScope({ shell, label }: { shell: ShellName; label: string }): JSX.Element {
  const { t } = useI18n()
  // PowerShell has no `redlog-session` helper; its output path is `Redlog-Run`.
  const hasSessionHelper = shell !== 'powershell'
  // Once the shell is connected the next thing the operator wants is the Start
  // button, which these two optional steps push off the screen. They stay
  // mounted while folded (the canary listener must keep hearing the check), and
  // the toggle carries their outcome so a result is not hidden with them.
  const [detailsOpen, setDetailsOpen] = useState(false)
  const [outputResult, setOutputResult] = useState<CanaryResult['kind'] | null>(null)
  return (
    <div className="space-y-2">
      <p data-testid="record-terminal-verified" className="text-emerald-500 font-medium">
        {t('firstRun.record.verified', { shell: label })}
      </p>
      <div data-testid="record-terminal-scope" className="space-y-1">
        <p className="text-redlog-text-dim">
          {shell === 'zsh' ? t('firstRun.record.scopeZsh') : shell === 'bash' ? t('firstRun.record.scopeBash') : t('firstRun.record.scope')}
        </p>
        {shell === 'powershell' ? (
          <p className="text-redlog-text-dim">{t('firstRun.record.outputPwsh')}</p>
        ) : (
          <>
            <button
              type="button"
              data-testid="record-terminal-details-toggle"
              aria-expanded={detailsOpen}
              onClick={() => setDetailsOpen((v) => !v)}
              className="underline text-redlog-text-dim hover:text-redlog-text"
            >
              {detailsOpen ? t('firstRun.record.detailsHide') : t('firstRun.record.detailsShow')}
              {outputResult === 'output' && <span className="ml-1 text-emerald-500">✓</span>}
              {outputResult === 'metadata-only' && <span className="ml-1 text-amber-400">!</span>}
            </button>
            <div data-testid="record-terminal-details" hidden={!detailsOpen} className="space-y-1">
              <p className="text-redlog-text-dim">
                {shell === 'zsh' ? t('firstRun.record.sessionHintSession') : t('firstRun.record.sessionHint')}
              </p>
              {hasSessionHelper && (
                <div className="flex items-center gap-2">
                  <code data-testid="record-terminal-session-command" className="font-mono bg-redlog-surface border border-redlog-border rounded px-2 py-1">redlog-session</code>
                  <CopyButton text={'redlog-session'} />
                </div>
              )}
              <OutputCheck shell={shell} onResult={setOutputResult} />
            </div>
          </>
        )}
      </div>
    </div>
  )
}

/** #218: prove the output path, not just the hook. The canary prints text its
 *  own command line does not contain, so an event carrying it in `stdout`
 *  means output was recorded, and the same line with no output means only
 *  the metadata was. Nothing is claimed about output that was never seen.
 *
 *  The bare command is what proves zsh's automatic relay; bash has no
 *  printf-style relay at its prompt, so there it runs behind `redlog-run` and
 *  the check proves the wrapper — the only output path bash has. */
function OutputCheck({ shell, onResult }: { shell: ShellName; onResult?: (kind: CanaryResult['kind'] | null) => void }): JSX.Element {
  const { t } = useI18n()
  const [canary] = useState(() => outputCanary(activationNonce()))
  const [result, setResult] = useState<CanaryResult | null>(null)
  useEffect(() => { onResult?.(result?.kind ?? null) }, [result?.kind, onResult])

  useEffect(() => {
    if (result?.kind === 'output') return
    return window.redlog.events.onNewBatch((evs: RedLogEvent[]) => {
      setResult((prev) => evs.reduce<CanaryResult | null>((acc, ev) => mergeCanary(acc, classifyCanaryEvent(ev, canary)), prev))
    })
  }, [canary, result?.kind])

  const viaRun = shell === 'bash' ? `redlog-run ${canary.command}` : canary.command
  return (
    <div data-testid="record-terminal-output-check" className="space-y-1 pt-1">
      <p className="text-redlog-text-dim">{t('firstRun.record.outputCheck')}</p>
      <div className="flex items-center gap-2">
        <code data-testid="record-terminal-output-command" title={viaRun} className="flex-1 min-w-0 truncate font-mono bg-redlog-surface border border-redlog-border rounded px-2 py-1">{viaRun}</code>
        <CopyButton text={viaRun} />
      </div>
      <p className="text-redlog-text-faint">{t('firstRun.record.outputCheckSession', { command: canary.command })}</p>
      {result?.kind === 'output' ? (
        <p data-testid="record-terminal-output-verified" className="text-emerald-500 font-medium">
          {t('firstRun.record.outputVerified', { via: result.capturedBy })}
        </p>
      ) : result?.kind === 'metadata-only' ? (
        <p data-testid="record-terminal-output-metadata-only" className="text-amber-400">
          {t('firstRun.record.outputMetadataOnly')}
        </p>
      ) : null}
    </div>
  )
}
