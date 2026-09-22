import { useState, useEffect } from 'react'
import { toast, toastDeferred } from '../Toast'
import { FieldGroup, type HookInfo } from './SettingsShared'
import { writeClipboard } from '../../lib/clipboard'

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

export default function HooksPanel({ hooks, setHooks, hookLoading, setHookLoading, t }: {
  hooks: HookInfo[]
  setHooks: (h: HookInfo[] | ((prev: HookInfo[]) => HookInfo[])) => void
  hookLoading: string | null
  setHookLoading: (id: string | null) => void
  t: (key: string, vars?: Record<string, string | number>) => string
}): JSX.Element {
  const [expanded, setExpanded] = useState<string | null>(null)

  useEffect(() => {
    (window.redlog as { hooks: { detect: () => Promise<HookInfo[]> } }).hooks.detect().then(setHooks)
  }, [])

  const copy = async (text: string): Promise<void> => {
    const ok = await writeClipboard(text)
    toast(ok ? t('toast.copied') : t('toast.copyFailed'), ok ? 'success' : 'error')
  }

  const handleToggle = async (hook: HookInfo): Promise<void> => {
    const hooksApi = (window.redlog as { hooks: { install: (id: string) => Promise<{ success: boolean; message: string }>; uninstall: (id: string) => Promise<{ success: boolean; message: string }> } }).hooks
    // Removing a hook blinds a capture source, and a blind source is only
    // discovered later, in the gap it left in the timeline. SS10 defers it:
    // the row reads as uninstalled at once, the profile is not touched until
    // the undo window closes, and an undo inside it leaves no audit entry.
    if (hook.installed) {
      setHooks((prev) => prev.map((h) => (h.id === hook.id ? { ...h, installed: false } : h)))
      toastDeferred(
        t('settings.hookRemoved', { name: hook.id }),
        () => {
          void hooksApi.uninstall(hook.id).then(async (r) => {
            if (!r.success) {
              toast(t('settings.hookUninstallFailed', { name: hook.id }), {
                type: 'error', why: t('settings.hookFailedWhy'), detail: r.message
              })
            }
            setHooks(await (window.redlog as { hooks: { detect: () => Promise<HookInfo[]> } }).hooks.detect())
          })
        },
        {
          type: 'warning',
          why: t('settings.hookRemovedWhy'),
          revert: () => setHooks((prev) => prev.map((h) => (h.id === hook.id ? { ...h, installed: true } : h)))
        }
      )
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
      <FieldGroup title={t('settings.hooksDetected')}>
        <p className="text-xs text-redlog-text-faint mb-2">
          {t('settings.hooksHint')}
        </p>
        {hooks.length === 0 && (
          <p className="text-redlog-text-dim text-xs">{t('common.loading')}</p>
        )}
        <div className="space-y-2">
          {hooks.map((hook) => {
            const isManual = hook.installMethod === 'manual'
            const hasSteps = isManual && !!hook.manualSteps?.length
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
                      {isOpen ? t('settings.hookHideSetup') : t('settings.hookShowSetup')}
                    </button>
                  )}
                </div>
                {hasSteps && isOpen && (
                  <div className="border-t border-redlog-border px-3 py-2.5 space-y-2.5">
                    {hook.manualSteps!.map((step, i) => (
                      <div key={i}>
                        <p className="text-xs text-redlog-text-dim leading-relaxed">
                          <span className="text-redlog-text-dim">{i + 1}.</span> {step.label}
                        </p>
                        {step.command && (
                          <div className="flex items-center gap-2 mt-1">
                            <code title={step.command} className="flex-1 min-w-0 truncate bg-redlog-bg border border-redlog-border rounded px-2 py-1 text-xs text-redlog-text font-mono">
                              {step.command}
                            </code>
                            <button
                              onClick={() => void copy(step.command!)}
                              className="text-xs px-2 py-1 rounded bg-redlog-elevated text-redlog-text hover:bg-redlog-elevated-hover transition-colors shrink-0"
                            >
                              {t('settings.hookCopy')}
                            </button>
                          </div>
                        )}
                      </div>
                    ))}
                    <p className="text-xs text-redlog-text-faint pt-0.5">{t('settings.hookManualNote')}</p>
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
