import { useState } from 'react'
import { toast } from '../Toast'
import { writeClipboard } from '../../lib/clipboard'
import { requestRunInTerminal } from '../../lib/terminalRunner'
import type { ManualStep } from './SettingsShared'

// The one renderer for "RedLog cannot do this for you — run this".
//
// It was inline in HooksPanel, which is why nothing else could show a step:
// the plugin captures' setup commands and every hook's `removalSteps` were
// computed in core and rendered by no one. A teardown for an iptables
// redirect that exists only in a TypeScript return value is a teardown the
// operator does not have.

export function ManualStepList({ steps, note, t, startIndex = 1 }: {
  steps: readonly ManualStep[]
  /** One line under the list, e.g. "RedLog cannot run these for you". */
  note?: string
  t: (key: string, vars?: Record<string, string | number>) => string
  startIndex?: number
}): JSX.Element {
  const copy = async (text: string): Promise<void> => {
    if (await writeClipboard(text)) toast(t('toast.copied'), 'success')
  }
  return (
    <div className="space-y-2.5">
      {steps.map((step, i) => (
        <div key={i}>
          <p className="text-xs text-redlog-text-dim leading-relaxed">
            <span className="text-redlog-text-dim">{startIndex + i}.</span> {step.label}
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
              {/* Pasting into some other terminal is the one part of an
                  engagement RedLog does not record. This types the line into
                  RedLog's own shell — without pressing Enter, because some of
                  these start long-running processes and some kill them by PID. */}
              <button
                data-testid="hook-step-run"
                onClick={() => requestRunInTerminal(step.command!)}
                title={t('settings.hookRunHint')}
                className="text-xs px-2 py-1 rounded bg-redlog-elevated text-redlog-text hover:bg-redlog-elevated-hover transition-colors shrink-0"
              >
                {t('settings.hookRun')}
              </button>
            </div>
          )}
        </div>
      ))}
      {note && <p className="text-xs text-redlog-text-faint pt-0.5">{note}</p>}
    </div>
  )
}

/** Setup and teardown for one source, teardown behind its own disclosure.
 *  Teardown is folded because it is read once, at the end — but it is on the
 *  same row as the thing it undoes, which is the only place someone looks for
 *  it when an engagement is over and the nat rules are still up. */
export function SetupAndTeardown({ setup, teardown, note, t }: {
  setup?: readonly ManualStep[]
  teardown?: readonly ManualStep[]
  note?: string
  t: (key: string, vars?: Record<string, string | number>) => string
}): JSX.Element | null {
  const [showTeardown, setShowTeardown] = useState(false)
  if (!setup?.length && !teardown?.length) return null
  return (
    <>
      {!!setup?.length && <ManualStepList steps={setup} note={note} t={t} />}
      {!!teardown?.length && (
        <div className={setup?.length ? 'mt-2.5 pt-2.5 border-t border-redlog-border' : ''}>
          <button
            onClick={() => setShowTeardown((v) => !v)}
            aria-expanded={showTeardown}
            data-testid="teardown-toggle"
            className="text-xs text-redlog-text-faint hover:text-redlog-text underline"
          >
            {t('settings.hookTeardown')}
          </button>
          {showTeardown && <div className="mt-2"><ManualStepList steps={teardown} t={t} /></div>}
        </div>
      )}
    </>
  )
}
