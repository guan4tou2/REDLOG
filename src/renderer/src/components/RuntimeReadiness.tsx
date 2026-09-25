import { useCallback, useEffect, useState } from 'react'
import { useI18n } from '../i18n'
import { Button } from './Button'
import { writeClipboard } from '../lib/clipboard'
import {
  markReadinessSeen, onOpenRuntimeReadiness, readinessSeen, tildePath
} from '../lib/runtimeReadiness'

// Spec 036. The POSIX shell hook needs python3 and curl; without them it
// installs cleanly and records nothing. This card says so once, on first
// launch, beside the project picker — a non-modal card, not a wizard. Every row
// is informational: "Get started" always continues, because the built-in
// terminal records without either command.

type Check = RuntimePreflight['checks'][number]

function usePreflight(): { data: RuntimePreflight | null; status: 'loading' | 'ready' | 'error'; recheck: () => void } {
  const [data, setData] = useState<RuntimePreflight | null>(null)
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading')
  const recheck = useCallback(() => {
    setStatus('loading')
    // A bridge without the runtime API (older preload, test harness) must not
    // take the screen down. But a failure is not the same as "still working":
    // swallowing it left `data` null, which this panel renders as a loading
    // line — forever, with no way to ask again.
    Promise.resolve().then(() => window.redlog.runtime.preflight())
      .then((d) => { setData(d); setStatus('ready') })
      .catch(() => setStatus('error'))
  }, [])
  useEffect(() => { recheck() }, [recheck])
  return { data, status, recheck }
}

function CopyCommand({ command }: { command: string }): JSX.Element {
  const { t } = useI18n()
  const [copied, setCopied] = useState(false)
  return (
    <button
      onClick={() => void writeClipboard(command).then((ok) => { if (ok) setCopied(true) })}
      title={t('readiness.copy')}
      className="mt-1 flex items-center gap-2 w-full text-left font-mono text-xs bg-redlog-bg border border-redlog-border rounded px-2 py-1 text-redlog-text hover:border-redlog-text-dim transition-colors"
    >
      <span className="flex-1 select-text">{command}</span>
      <span className="text-redlog-text-faint shrink-0">{copied ? t('readiness.copied') : t('readiness.copy')}</span>
    </button>
  )
}

function Row({ mark, label, detail, children }: {
  mark: '✓' | '✕' | '○' | '!'
  label: string
  detail?: string
  children?: React.ReactNode
}): JSX.Element {
  const tone = mark === '✓' ? 'text-emerald-400' : mark === '✕' ? 'text-red-400' : mark === '!' ? 'text-amber-300' : 'text-redlog-text-faint'
  return (
    <li className="py-1.5">
      <div className="flex items-baseline gap-2 text-xs">
        <span className={`w-3 shrink-0 font-mono ${tone}`} aria-hidden>{mark}</span>
        <span className="text-redlog-text">{label}</span>
        {detail && <span className="text-redlog-text-dim">{detail}</span>}
      </div>
      {children && <div className="pl-5">{children}</div>}
    </li>
  )
}

const SHELL_LABEL: Record<string, string> = { zsh: 'zsh', bash: 'bash', pwsh: 'PowerShell', powershell: 'PowerShell' }

function RuntimeReadinessPanel({ onDone }: { onDone: () => void }): JSX.Element {
  const { t } = useI18n()
  const { data, status, recheck } = usePreflight()
  const check = (id: Check['id']): Check | undefined => data?.checks.find((c) => c.id === id)
  const runtime = (['python3', 'curl'] as const).map(check).filter((c): c is Check => !!c)
  const runtimeMissing = runtime.filter((c) => !c.found)
  const mitm = check('mitmdump')
  const shellFound = data?.shell ? (check(data.shell.name as Check['id'])?.found ?? true) : false

  return (
    <section
      role="dialog"
      aria-labelledby="runtime-readiness-title"
      className="fixed top-14 right-4 z-40 w-[22rem] max-w-[calc(100vw-2rem)] max-h-[calc(100vh-4.5rem)] overflow-y-auto rounded-lg border border-redlog-border bg-redlog-surface shadow-xl p-4"
    >
      <h2 id="runtime-readiness-title" className="text-sm font-semibold text-redlog-text mb-2">{t('readiness.title')}</h2>
      {status === 'error' ? (
        <div data-testid="readiness-check-failed" role="status" className="text-xs space-y-2">
          <p className="text-amber-300">{t('readiness.checkFailed')}</p>
          <button
            onClick={recheck}
            className="px-2 py-1 rounded border border-redlog-border text-redlog-text hover:bg-redlog-elevated"
          >{t('readiness.recheck')}</button>
        </div>
      ) : !data ? (
        <p className="text-xs text-redlog-text-dim">{t('common.loading')}</p>
      ) : (
        <ul className="divide-y divide-redlog-border/50">
          {runtime.map((c) => (
            <Row key={c.id} mark={c.found ? '✓' : '✕'} label={c.id}>
              {!c.found && c.remediation && <CopyCommand command={c.remediation} />}
            </Row>
          ))}
          <Row
            mark={data.shell && shellFound ? '✓' : '○'}
            label={t('readiness.shell')}
            detail={data.shell ? SHELL_LABEL[data.shell.name] ?? data.shell.name : t('readiness.shellNone')}
          />
          {mitm && (
            <Row mark={mitm.found ? '✓' : '○'} label="mitmproxy" detail={mitm.found ? undefined : t('readiness.optional')}>
              {!mitm.found && (
                <>
                  <p className="text-xs text-redlog-text-dim">{t('readiness.mitmOptional')}</p>
                  {mitm.remediation && <CopyCommand command={mitm.remediation} />}
                </>
              )}
            </Row>
          )}
          <Row
            mark={data.legacyHooks.length ? '!' : '○'}
            label={t('readiness.legacy')}
            detail={data.legacyHooks.length ? t('readiness.legacyFound', { count: data.legacyHooks.length }) : t('readiness.legacyNone')}
          />
        </ul>
      )}
      {runtimeMissing.length > 0 && (
        <p className="mt-2 text-xs text-amber-300">{t('readiness.runtimeMissing')}</p>
      )}
      <div className="mt-3 flex justify-end gap-2">
        <Button level="quiet" onClick={recheck}>{t('readiness.recheck')}</Button>
        <Button onClick={onDone}>{t('readiness.start')}</Button>
      </div>
    </section>
  )
}

/** Shows the readiness card on first launch (before any project is open) and
 *  whenever something asks to reopen it. Dismissing records that it was seen. */
export function RuntimeReadinessHost({ firstLaunch }: { firstLaunch: boolean }): JSX.Element | null {
  const [open, setOpen] = useState(() => firstLaunch && !readinessSeen())
  useEffect(() => onOpenRuntimeReadiness(() => setOpen(true)), [])
  if (!open) return null
  return <RuntimeReadinessPanel onDone={() => { markReadinessSeen(); setOpen(false) }} />
}

// A dedicated banner rather than a lib/issues `attention` entry: the fix is one
// click and its outcome (the backup path, or why it failed) has to be shown
// right where the operator clicked. The issue store holds a title and a view
// to navigate to — no action and no result — so the operator would be sent
// somewhere else to do a thing this banner can do in place.
const HOOK_LABEL: Record<string, string> = { 'shell-zsh': 'Zsh', 'shell-bash': 'Bash', 'shell-powershell': 'PowerShell' }

export function LegacyHookBanner(): JSX.Element | null {
  const { t } = useI18n()
  const { data, recheck } = usePreflight()
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<LegacyMigrationResult | null>(null)
  const ref = data?.legacyHooks[0]

  if (!ref && !result) return null

  const migrate = async (): Promise<void> => {
    if (!ref) return
    setBusy(true)
    try {
      const r = await window.redlog.hooks.migrateLegacy(ref)
      setResult(r)
      if (r.success) recheck()
    } catch (e) {
      setResult({ success: false, message: String(e), removed: 0, hookId: ref.hookId })
    } finally {
      setBusy(false)
    }
  }

  return (
    <div role="status" className="shrink-0 border-b border-amber-500/30 bg-amber-500/10 px-4 py-2 text-xs text-redlog-text flex items-start gap-3">
      <span className="text-amber-300 font-mono" aria-hidden>!</span>
      <div className="flex-1 min-w-0 space-y-1">
        {result ? (
          result.success ? (
            <>
              <p>{t('legacyHook.done')}</p>
              {result.backupPath && (
                <p className="text-redlog-text-dim">{t('legacyHook.backup')} <span className="font-mono select-text">{result.backupPath}</span></p>
              )}
            </>
          ) : (
            <p className="text-red-300">{t('legacyHook.failed')} <span className="font-mono select-text">{result.message}</span></p>
          )
        ) : ref && (
          <p>{t('legacyHook.message', { file: tildePath(ref.file) })}</p>
        )}
      </div>
      {!result?.success && ref && (
        <Button disabled={busy} onClick={() => void migrate()} className="h-7 px-3 text-xs shrink-0">
          {ref.hookId && HOOK_LABEL[ref.hookId]
            ? t('legacyHook.update', { shell: HOOK_LABEL[ref.hookId] })
            : t('legacyHook.remove')}
        </Button>
      )}
      {result?.success && (
        <Button level="quiet" onClick={() => setResult(null)} className="h-7 px-3 text-xs shrink-0">{t('legacyHook.dismiss')}</Button>
      )}
    </div>
  )
}
