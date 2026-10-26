import { useState, useEffect } from 'react'
import { FieldGroup, type HookInfo } from './SettingsShared'
import { isForeignShellHook } from '../../lib/hookPlatform'
import { removeHookWithUndo } from '../../lib/hookRemoval'
import { RecordTerminalFlow } from '../RecordTerminalFlow'
import { RuntimePreparation } from '../CapturePreparation'
import { shellNameForHook } from '../../lib/terminalActivation'
import { useRevalidateOnFocus } from '../../hooks/useRevalidateOnFocus'
import { useReadState } from '../../lib/readState'
import { SetupAndTeardown } from './ManualStepList'
import { Button } from '../Button'

// Built-in hooks describe themselves in English in hooks-manager (main
// process, no locale). The interface is Chinese, so each built-in id has a
// translated line here; a plugin-contributed hook keeps its author's text,
// because inventing a translation for a string we do not own would be worse
// than showing it as written.
function hookDescription(hook: HookInfo, t: (key: string) => string): string {
  const key = `settings.hookDesc.${hook.id}`
  const localized = t(key)
  return localized === key ? hook.description : localized
}

interface TerminalPolicy { mode: 'auto' | 'manual'; native: string[]; pty: string[]; app: string }

/** What the operator's shell will actually do, for the terminals this machine
 *  opens: the mode `redlog mode` last set, and the class lists as `redlog
 *  class` left them.
 *
 *  Read-only here on purpose. The lists are edited from the terminal, where
 *  the operator is when they discover that `nc` went through a relay, and a
 *  second editor in Settings would be a second place for the policy to be
 *  changed and a second thing to keep in step. What Settings owes is the
 *  answer to "what will my shell do", from the same file the shell reads
 *  (research.md D7).
 *
 *  Declared at module scope: a component defined inside another component's
 *  body is a new type on every render, and React remounts its subtree. */
function TerminalPolicyNote({ policy, t }: {
  policy: TerminalPolicy | null
  t: (key: string, vars?: Record<string, string | number>) => string
}): JSX.Element | null {
  if (!policy) return null
  return (
    <details className="text-xs text-redlog-text-dim mb-3 leading-relaxed">
      <summary className="min-h-8 cursor-pointer content-center break-words">
        {t('settings.terminalMode', { mode: t(`settings.terminalMode.${policy.mode}`) })}
      </summary>
      <ul className="mt-2 space-y-1 break-words">
        <li>{t('settings.terminalClassNative', { commands: policy.native.join(' ') })}</li>
        <li>{t('settings.terminalClassPty', { commands: policy.pty.join(' ') })}</li>
      </ul>
      <p className="mt-2 break-words text-redlog-text-faint">{t('settings.terminalClassEditedFromShell')}</p>
    </details>
  )
}

export default function HooksPanel({ hooks, setHooks, t }: {
  hooks: HookInfo[]
  setHooks: (h: HookInfo[] | ((prev: HookInfo[]) => HookInfo[])) => void
  t: (key: string, vars?: Record<string, string | number>) => string
}): JSX.Element {
  const [savingApp, setSavingApp] = useState(false)
  const [appError, setAppError] = useState('')
  const [connecting, setConnecting] = useState<string | null>(null)
  const [preparing, setPreparing] = useState<'commands' | 'web' | null>(null)
  const read = useReadState(async () => {
    const found = await window.redlog.hooks.detect()
    if (!Array.isArray(found)) throw new Error('invalid-hook-list')
    return found
  })
  const [expanded, setExpanded] = useState<string | null>(null)
  const policy = useReadState(async (): Promise<TerminalPolicy | null> => {
    const api = window.redlog.hooks
    return await api.terminalPolicy?.() ?? null
  })
  useRevalidateOnFocus(() => { read.retry(); policy.retry() })

  const selectApp = async (value: string): Promise<void> => {
    setSavingApp(true)
    setAppError('')
    try {
      const saved = await window.redlog.hooks.setTerminalApp(value)
      policy.update(prev => prev ? { ...prev, app: saved } : null)
      policy.retry()
    } catch (error) { setAppError(String((error as Error)?.message ?? error)) }
    finally { setSavingApp(false) }
  }

  useEffect(() => {
    if (read.state.phase === 'loaded') setHooks(read.state.value)
  }, [read.state])


  const remove = (hook: HookInfo): void => {
    if (connecting === hook.id) setConnecting(null)
    const show = (installed: boolean) => (): void =>
      setHooks(prev => prev.map(h => h.id === hook.id ? { ...h, installed } : h))
    removeHookWithUndo(hook.id, t, { hide: show(false), restore: show(true), refresh: read.retry })
  }

  const platform = (window as { redlog?: { platform?: string } }).redlog?.platform
  const builtinHooks = hooks.filter((hook) => hook.builtin)
  const otherHooks = builtinHooks.filter((hook) => isForeignShellHook(hook, platform))
  const mainHooks = builtinHooks.filter((hook) => !isForeignShellHook(hook, platform))

  // A function that returns JSX, called below — not a component, so nothing
  // remounts. The same row serves the main list and the "other platforms" group.
  const renderRow = (hook: HookInfo): JSX.Element => {
      // "Manual" means RedLog cannot set it up for you. mitmproxy no
      // longer qualifies — it is installed in one click and started when
      // a project opens — so its remaining steps are an optional extra,
      // and saying "manual setup" would claim work that is not needed.
      const isManual = hook.installMethod === 'manual' && !hook.stepsAreOptional
      const hasSteps = !!hook.manualSteps?.length
      const isOpen = expanded === hook.id
      return (
        <div
          key={hook.id}
          className={`flex min-w-0 flex-col rounded border ${
            hook.available ? 'border-redlog-border bg-redlog-surface/50'
              : isManual ? 'border-redlog-border bg-redlog-surface/30 opacity-75'
              : 'border-redlog-border bg-redlog-surface/20 opacity-50'
          }`}
        >
          <div className="flex flex-wrap items-center gap-gap p-3">
            <div className="min-w-0 flex-1 basis-48">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-sm font-medium text-redlog-text">{hook.name}</span>
                {hook.installed && (
                  <span className="text-xs bg-green-900/50 text-green-400 px-1.5 py-0.5 rounded">
                    {t('settings.shellInstalled')}
                  </span>
                )}
                {isManual && (
                  <span className="text-xs bg-redlog-elevated text-redlog-text-dim px-1.5 py-0.5 rounded">
                    {t('settings.hookManual')}
                  </span>
                )}
                {!hook.available && (
                  <span className="text-xs bg-redlog-elevated text-redlog-text-dim px-1.5 py-0.5 rounded">
                    {t('settings.hookNotFound')}
                  </span>
                )}
              </div>
              <p className="text-xs text-redlog-text-dim mt-0.5 break-words">{hookDescription(hook, t)}</p>
            </div>
            <div className="flex flex-wrap items-center gap-2">
            {hook.available && shellNameForHook(hook.id) && read.state.value !== null && read.state.phase !== 'failed' && (
              <Button size="compact" data-testid={`hook-connect-${hook.id}`}
                aria-expanded={connecting === hook.id}
                aria-controls={connecting === hook.id ? `hook-connection-${hook.id}` : undefined}
                onClick={() => setConnecting(hook.id)}>
                {hook.installed ? t('settings.shellVerify') : t('settings.shellConnect')}
              </Button>
            )}
            {hook.installed && shellNameForHook(hook.id) && (
              <Button size="compact" level="quiet" onClick={() => remove(hook)}>
                {t('settings.hookDisable')}
              </Button>
            )}
            {hook.id === 'mitmproxy' && !hook.available && (
              <Button size="compact" data-testid="hook-install-mitmproxy" onClick={() => setPreparing('web')}>
                {t('captureSetup.install')}
              </Button>
            )}
            {hasSteps && (
              <Button size="compact"
                aria-expanded={isOpen}
                onClick={() => setExpanded(isOpen ? null : hook.id)}
              >
                {isOpen
                  ? t('settings.hookHideSetup')
                  : hook.stepsAreOptional ? t('settings.hookOptionalSteps') : t('settings.hookShowSetup')}
              </Button>
            )}
            </div>
          </div>
          {connecting === hook.id && !preparing && (
            <div id={`hook-connection-${hook.id}`} className="min-w-0 px-3 pb-3">
              <RecordTerminalFlow key={connecting}
                target={{ kind: 'host', hookId: connecting, label: hook.name }}
                onInstalled={read.retry} onPrepare={() => setPreparing('commands')} />
            </div>
          )}
          {isOpen && (
            <div className="border-t border-redlog-border px-3 py-2.5">
              {/* Shared with the external-capture group, so a teardown
                  written in core reaches the operator wherever the
                  source is listed. `removalSteps` used to render
                  nowhere at all — including the mitmproxy CA removal,
                  the longest-lived thing RedLog leaves on a machine. */}
              <SetupAndTeardown
                setup={hook.manualSteps}
                teardown={hook.removalSteps}
                note={hasSteps ? t('settings.hookManualNote') : undefined}
                t={t}
              />
            </div>
          )}
        </div>
      )

  }

  return (
    <>
      {/* Only what RedLog ships. A plugin's own capture is listed with the
          plugin that brought it, on the Plugins page — here it was padding a
          list the operator reads to answer "is my shell recording". */}
      <FieldGroup title={t('settings.hooksBuiltin')}>
        {policy.state.value && (platform === 'darwin' || policy.state.value.app !== 'all') && <div className="mb-3 space-y-2">
          <label className="flex flex-wrap items-center gap-3 text-xs text-redlog-text">
            {t('settings.terminalApp')}
            <select aria-label={t('settings.terminalApp')} value={policy.state.value?.app ?? 'all'} disabled={savingApp || policy.state.phase === 'failed'}
              onChange={e => { void selectApp(e.target.value) }}
              className="min-h-8 rounded border border-redlog-border bg-redlog-surface px-2">
              <option value="all">{t('settings.terminalApp.all')}</option>
              {platform === 'darwin' ? <>
                <option value="WarpTerminal">Warp</option>
                <option value="Apple_Terminal">Terminal.app</option>
                <option value="iTerm.app">iTerm2</option>
                <option value="vscode">VS Code</option>
              </> : policy.state.value.app !== 'all' && <option value={policy.state.value.app} disabled>
                {({ WarpTerminal: 'Warp', Apple_Terminal: 'Terminal.app', 'iTerm.app': 'iTerm2', vscode: 'VS Code', WindowsTerminal: 'Windows Terminal' } as Record<string, string>)[policy.state.value.app] ?? policy.state.value.app}
              </option>}

            </select>
          </label>
          {policy.state.value.app !== 'all' && <p role={platform !== 'darwin' ? 'alert' : undefined} className="text-xs text-redlog-text-faint">
            {t(platform === 'darwin' ? 'settings.terminalApp.boundary' : 'settings.terminalApp.unsupported')}
          </p>}
        </div>}
        {policy.state.phase === 'failed' && <div role="alert" className="mb-3 text-xs text-red-400">
          <p>{policy.state.error}</p>
          <button type="button" className="min-h-8 underline" onClick={policy.retry}>{t('common.retry')}</button>
        </div>}
        {appError && <p role="alert" className="mb-3 text-xs text-red-400">{appError}</p>}
        <TerminalPolicyNote policy={policy.state.value} t={t} />
        {read.state.phase === 'loading' && (
          <p className="text-redlog-text-dim text-xs">{t('common.loading')}</p>
        )}
        {read.state.phase === 'failed' && <div role="alert" className="text-xs text-red-400 space-y-2">
          <p>{t('firstRun.record.detectFailed')}</p>
          <p className="break-words">{read.state.error}</p>
          <button type="button" data-testid="hooks-read-retry" className="min-h-8 underline" onClick={read.retry}>{t('common.retry')}</button>
        </div>}
        <div className="space-y-3">
          {mainHooks.map((hook) => renderRow(hook))}
        </div>
        {otherHooks.length > 0 && (
          <details data-testid="hooks-other-platforms" className="mt-3">
            <summary className="text-xs text-redlog-text-faint cursor-pointer">
              {t('settings.otherPlatforms')} ({otherHooks.length})
            </summary>
            <div className="space-y-2 mt-2">
              {otherHooks.map((hook) => renderRow(hook))}
            </div>
          </details>
        )}
        {preparing && <RuntimePreparation source={preparing} onClose={() => { setPreparing(null); read.retry() }} />}
      </FieldGroup>
    </>
  )
}
