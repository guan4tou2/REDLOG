import { FieldGroup, type HookInfo } from './SettingsShared'
import { Button } from '../Button'
import { SetupAndTeardown } from './ManualStepList'
import { SourceLastSeen } from './SourceLastSeen'
import { useRevalidateOnFocus } from '../../hooks/useRevalidateOnFocus'
import { useReadState } from '../../lib/readState'

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

export default function ExternalCaptureGroup({ t }: {
  t: (key: string, vars?: Record<string, string | number>) => string
}): JSX.Element | null {
  const hookRead = useReadState(async () => {
    const hooks = await window.redlog.hooks.detect()
    if (!Array.isArray(hooks)) throw new Error(t('settings.externalInvalidResponse'))
    return hooks.filter(isExternal)
  })
  const hooks = hookRead.state.value ?? []
  const healthRead = useReadState(async () => {
    const health = await window.redlog.capture.health()
    if (!health || !Array.isArray(health.sources)) throw new Error(t('settings.externalInvalidResponse'))
    return health
  }, hooks.length > 0)
  const read = (): void => {
    hookRead.retry()
    healthRead.retry()
  }
  // The operator leaves, runs the sudo line in a terminal, and comes back.
  // That return is the moment the answer changes, and the moment they look.
  useRevalidateOnFocus(read)

  /** `<pluginId>.<entryId>` — the description belongs to the plugin. */
  const describe = (hook: HookInfo): string => {
    const key = `settings.externalDesc.${hook.id.split('.')[0]}`
    const line = t(key)
    return line === key ? '' : line
  }

  if (hookRead.state.phase === 'loaded' && hooks.length === 0) return null
  const fresh = hookRead.state.phase === 'loaded' && healthRead.state.phase === 'loaded'
  const errors = [hookRead.state, ...(hooks.length ? [healthRead.state] : [])]
    .filter((state) => state.phase === 'failed')
  const reading = hookRead.state.phase === 'loading' || (hooks.length > 0 && healthRead.state.phase === 'loading')

  return (
    <FieldGroup title={t('settings.externalCapture')}>
      {/* The scope is on the group, not a badge per row. Everything else on
          this page is this project; this one block is the machine, and saying
          so once in words beats teaching a chip that means "scope". */}
      <p className="text-xs text-redlog-text-faint">{t('settings.externalCaptureHint')}</p>
      {reading && <p role="status" className="text-xs text-redlog-text-faint">{t('common.loading')}</p>}
      {errors.length > 0 && <div role="alert" className="text-xs text-red-400 space-y-1">
        <p>{t('settings.externalReadFailed')}</p>
        {errors.map((state, index) => <p key={index} className="break-words">{state.error}</p>)}
        <Button level="quiet" disabled={reading} onClick={read}>{t('common.retry')}</Button>
      </div>}
      <div className="space-y-2">
        {hooks.map((hook) => {
          const l = healthRead.state.value?.sources.find((source) => source.id === hook.id)
          // `off` is not a fault. A producer nobody has started yet is the
          // normal state of a thing you start by hand, so it gets the quiet
          // treatment and only a producer that is RUNNING earns a colour.
          //
          // Running is its own heartbeat, not a guess from recent events: a
          // producer announces itself every 15 seconds, which is the only way
          // to tell "it died" from "nothing happened to capture".
          const feeding = fresh && l?.running === true
          const known = l?.state === 'ready'
          // The dangerous pair first: switched off and still receiving. The
          // producer runs outside RedLog, so switching it off never stopped
          // it -- it only stopped RedLog saying so. Naming that state is the
          // whole reason a disabled row is still drawn.
          const stoppedButFeeding = hook.disabled && feeding
          const stateLabel = !fresh || !l ? t('settings.externalUnknown') : stoppedButFeeding
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
                  !fresh || !l ? 'bg-redlog-elevated text-redlog-text-dim'
                    : stoppedButFeeding ? 'bg-redlog-danger/12 text-redlog-danger'
                    : hook.disabled ? 'bg-redlog-elevated text-redlog-text-dim'
                      : feeding ? 'bg-redlog-safe/12 text-redlog-safe'
                        : !hook.available ? 'bg-redlog-warn/12 text-redlog-warn'
                          : 'bg-redlog-elevated text-redlog-text-dim'
                }`}>{stateLabel}</span>
              </div>
              {!fresh && l && <p className="text-xs text-redlog-text-faint mt-1">
                {t('settings.externalLastKnown', { state: t(l.running ? 'settings.externalFeeding' : l.state === 'ready' ? 'settings.externalIdle' : 'settings.externalNotRunning') })}
              </p>}
              {/* When this producer last delivered. The chip says whether it is
                  running now; this says when something actually arrived —
                  the difference between "up" and "feeding", which is the
                  question an operator actually has about a producer they
                  started by hand. */}
              {l && <SourceLastSeen source={l} active={feeding} t={t} />}
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
