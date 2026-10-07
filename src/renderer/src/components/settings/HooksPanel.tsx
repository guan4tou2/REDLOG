import { useState, useEffect } from 'react'
import { toast } from '../Toast'
import { FieldGroup, type HookInfo } from './SettingsShared'
import { removeHookWithUndo } from '../../lib/hookRemoval'
import { SetupAndTeardown } from './ManualStepList'

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

interface TerminalPolicy { mode: 'auto' | 'manual'; native: string[]; pty: string[] }

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
    <p className="text-xs text-redlog-text-dim mb-2 leading-relaxed">
      {t('settings.terminalMode', { mode: t(`settings.terminalMode.${policy.mode}`) })}
      {' · '}
      {t('settings.terminalClassNative', { commands: policy.native.join(' ') })}
      {' · '}
      {t('settings.terminalClassPty', { commands: policy.pty.join(' ') })}
      <br />
      <span className="text-redlog-text-faint">{t('settings.terminalClassEditedFromShell')}</span>
    </p>
  )
}

export default function HooksPanel({ hooks, setHooks, hookLoading, setHookLoading, t }: {
  hooks: HookInfo[]
  setHooks: (h: HookInfo[] | ((prev: HookInfo[]) => HookInfo[])) => void
  hookLoading: string | null
  setHookLoading: (id: string | null) => void
  t: (key: string, vars?: Record<string, string | number>) => string
}): JSX.Element {
  const [expanded, setExpanded] = useState<string | null>(null)
  const [policy, setPolicy] = useState<TerminalPolicy | null>(null)

  useEffect(() => {
    (window.redlog as { hooks: { detect: () => Promise<HookInfo[]> } }).hooks.detect().then(setHooks)
  }, [])

  useEffect(() => {
    // Not cached: `redlog mode manual` happens in a terminal RedLog knows
    // nothing about, and a panel showing a stale `auto` is worse than one
    // showing nothing. An older preload has no such method, so a renderer
    // running against one leaves the note out rather than throwing.
    const api = (window.redlog as { hooks?: { terminalPolicy?: () => Promise<TerminalPolicy> } }).hooks
    api?.terminalPolicy?.().then(setPolicy).catch(() => setPolicy(null))
  }, [])

  const handleToggle = async (hook: HookInfo): Promise<void> => {
    const hooksApi = (window.redlog as { hooks: { install: (id: string) => Promise<{ success: boolean; message: string }> } }).hooks
    if (hook.installed) {
      const show = (installed: boolean) => (): void =>
        setHooks((prev) => prev.map((h) => (h.id === hook.id ? { ...h, installed } : h)))
      removeHookWithUndo(hook.id, t, {
        hide: show(false),
        restore: show(true),
        refresh: () => { void (window.redlog as { hooks: { detect: () => Promise<HookInfo[]> } }).hooks.detect().then(setHooks) }
      })
      return
    }
    setHookLoading(hook.id)
    const result = await hooksApi.install(hook.id)
    if (result.success) toast(result.message, 'success')
    else {
      toast(t('settings.hookInstallFailed', { name: hook.id }), {
        type: 'error',
        why: t('settings.hookFailedWhy'),
        detail: result.message,
        action: { label: t('common.retry'), onClick: () => { void handleToggle(hook) } }
      })
    }
    const updated = await (window.redlog as { hooks: { detect: () => Promise<HookInfo[]> } }).hooks.detect()
    setHooks(updated)
    setHookLoading(null)
  }

  return (
    <>
      {/* Only what RedLog ships. A plugin's own capture is listed with the
          plugin that brought it, on the Plugins page — here it was padding a
          list the operator reads to answer "is my shell recording". */}
      <FieldGroup title={t('settings.hooksBuiltin')}>
        <p className="text-xs text-redlog-text-faint mb-2">
          {t('settings.hooksHint')}
        </p>
        <TerminalPolicyNote policy={policy} t={t} />
        {hooks.length === 0 && (
          <p className="text-redlog-text-dim text-xs">{t('common.loading')}</p>
        )}
        <div className="space-y-2">
          {hooks.filter((hook) => hook.builtin).map((hook) => {
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
                className={`rounded border ${
                  hook.available ? 'border-redlog-border bg-redlog-surface/50'
                    : isManual ? 'border-redlog-border bg-redlog-surface/30 opacity-75'
                    : 'border-redlog-border bg-redlog-surface/20 opacity-50'
                }`}
              >
                <div className="flex items-center justify-between p-3">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="text-xs font-medium text-redlog-text">{hook.name}</span>
                      {hook.installed && (
                        <span className="text-xs bg-green-900/50 text-green-400 px-1.5 py-0.5 rounded">
                          {t('settings.hookActive')}
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
                    <p className="text-xs text-redlog-text-dim mt-0.5">{hookDescription(hook, t)}</p>
                  </div>
                  {hook.available && hook.installMethod !== 'manual' && (
                    // Enabling a hook is a secondary verb, not the one thing
                    // the page exists for, and there are several of them in a
                    // row — so no primary fill (SS4: one per screen), and never
                    // the danger fill it used to wear: danger red reports a
                    // state, it does not invite a click.
                    <button
                      disabled={hookLoading === hook.id}
                      onClick={() => handleToggle(hook)}
                      className={`px-3 py-1 text-xs rounded ml-3 shrink-0 transition-colors ${
                        hook.installed
                          ? 'bg-redlog-elevated text-redlog-text-dim hover:bg-red-900/30 hover:text-red-400'
                          : 'bg-redlog-elevated text-redlog-text hover:bg-redlog-elevated-hover'
                      } ${hookLoading === hook.id ? 'opacity-50' : ''}`}
                    >
                      {hookLoading === hook.id ? '...' : hook.installed ? t('settings.hookDisable') : t('settings.hookEnable')}
                    </button>
                  )}
                  {hasSteps && (
                    <button
                      onClick={() => setExpanded(isOpen ? null : hook.id)}
                      className="px-3 py-1 text-xs rounded ml-3 bg-redlog-elevated text-redlog-text hover:bg-redlog-elevated-hover transition-colors shrink-0"
                    >
                      {isOpen
                        ? t('settings.hookHideSetup')
                        : hook.stepsAreOptional ? t('settings.hookOptionalSteps') : t('settings.hookShowSetup')}
                    </button>
                  )}
                </div>
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
          })}
        </div>
      </FieldGroup>
    </>
  )
}
