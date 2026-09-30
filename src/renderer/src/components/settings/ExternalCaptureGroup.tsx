import { useEffect, useState } from 'react'
import { FieldGroup, type HookInfo } from './SettingsShared'
import { SetupAndTeardown } from './ManualStepList'
import { useRevalidateOnFocus } from '../../hooks/useRevalidateOnFocus'

// Capture RedLog cannot start.
//
// tcpdump needs root, the transparent proxy rewrites this host's nat rules,
// the C2 tailer follows a log only the operator knows the path of. RedLog
// holds none of that, so the operator runs a command and RedLog watches for
// what comes back.
//
// These lived on the Plugins page behind an enable switch, which was wrong
// twice. Wrong as a category — they ship with the product, so they are not
// plugins, and Burp does not put Proxy and Repeater in Extensions either.
// And wrong as a control: the switch flipped a registry flag and started
// nothing, so pressing it taught the operator that capture was on when no
// packet was being read. Burp's invisible-proxy checkbox does only what Burp
// itself can do and leaves the machine-level redirect to the operator and the
// docs, for exactly this reason — a boolean over someone else's privileges
// cannot be honest.
//
// So there is no switch here. There is what is true (is this feeding the
// record right now, read from the events themselves) and what to run.

/** Plugin-contributed captures namespace their ids as `<pluginId>.<entryId>`;
 *  RedLog's own hooks do not. That dot is the whole test. */
const isExternal = (h: HookInfo): boolean => h.id.includes('.')

type Live = { state?: string; lastEventAt?: number | null }

export default function ExternalCaptureGroup({ t }: {
  t: (key: string, vars?: Record<string, string | number>) => string
}): JSX.Element | null {
  const [hooks, setHooks] = useState<HookInfo[]>([])
  const [live, setLive] = useState<Record<string, Live>>({})

  const read = (): void => {
    void (window.redlog as { hooks: { detect: () => Promise<HookInfo[]> } })
      .hooks.detect().then((all) => setHooks(all.filter(isExternal))).catch(() => {})
    void window.redlog.capture.health().then((h) => {
      if (!h) return
      const next: Record<string, Live> = {}
      for (const s of h.sources) next[s.id] = { state: s.state, lastEventAt: s.lastEventAt }
      setLive(next)
    }).catch(() => {})
  }
  useEffect(read, [])
  // The operator leaves, runs the sudo line in a terminal, and comes back.
  // That return is the moment the answer changes, and the moment they look.
  useRevalidateOnFocus(read)

  /** `<pluginId>.<entryId>` — the description belongs to the plugin. */
  const describe = (hook: HookInfo): string => {
    const key = `settings.externalDesc.${hook.id.split('.')[0]}`
    const line = t(key)
    return line === key ? '' : line
  }

  if (hooks.length === 0) return null

  return (
    <FieldGroup title={t('settings.externalCapture')}>
      {/* The scope is on the group, not a badge per row. Everything else on
          this page is this project; this one block is the machine, and saying
          so once in words beats teaching a chip that means "scope". */}
      <p className="text-xs text-redlog-text-faint">{t('settings.externalCaptureHint')}</p>
      <div className="space-y-2">
        {hooks.map((hook) => {
          const l = live[hook.id] ?? {}
          // `off` is not a fault. A producer nobody has started yet is the
          // normal state of a thing you start by hand, so it gets the quiet
          // treatment and only `active` earns a colour.
          const feeding = l.state === 'active'
          const known = l.state === 'active' || l.state === 'idle'
          // The dangerous pair first: switched off and still receiving. The
          // producer runs outside RedLog, so switching it off never stopped
          // it -- it only stopped RedLog saying so. Naming that state is the
          // whole reason a disabled row is still drawn.
          const stoppedButFeeding = hook.disabled && feeding
          const stateLabel = stoppedButFeeding
            ? t('settings.externalDisabledFeeding')
            : hook.disabled ? t('settings.externalDisabled')
              : !hook.available
                ? t('settings.externalMissing', { dep: hook.description.match(/tcpdump|tshark|mitmdump|node/)?.[0] ?? '' })
                : feeding ? t('settings.externalFeeding')
                  : known ? t('settings.externalIdle')
                    : t('settings.externalNotRunning')
          return (
            <div key={hook.id} className="rounded border border-redlog-border bg-redlog-surface/50 p-3">
              <div className="flex items-center gap-2 flex-wrap">
                <span className="text-xs font-medium text-redlog-text">{hook.name}</span>
                <span className={`text-xs px-1.5 py-0.5 rounded ${
                  stoppedButFeeding ? 'bg-redlog-danger/12 text-redlog-danger'
                    : hook.disabled ? 'bg-redlog-elevated text-redlog-text-dim'
                      : feeding ? 'bg-redlog-safe/12 text-redlog-safe'
                        : !hook.available ? 'bg-redlog-warn/12 text-redlog-warn'
                          : 'bg-redlog-elevated text-redlog-text-dim'
                }`}>{stateLabel}</span>
              </div>
              {/* The manifest's own prose is written for whoever maintains
                  the pack, in English. The translated line says what this
                  puts in the record, which is also what makes the source
                  findable: searching 封包 or tcpdump used to return nothing
                  at all, because a key built at runtime is invisible to the
                  index generator. */}
              {describe(hook) && (
                <p className="text-xs text-redlog-text-dim mt-1">{describe(hook)}</p>
              )}
              <div className="mt-2">
                <SetupAndTeardown
                  setup={hook.manualSteps}
                  teardown={hook.removalSteps}
                  t={t}
                />
              </div>
            </div>
          )
        })}
      </div>
    </FieldGroup>
  )
}
