import { Button } from './Button'
import { useI18n } from '../i18n'
import { isMac } from '../lib/platform'
import { trailLabelKey, type Trail } from '../lib/returnTrail'

const BAR = 'flex items-center gap-2 px-4 py-1.5 border-b border-redlog-border/60 bg-redlog-surface/60 text-xs'

/** The way back from a jump (lib/returnTrail.ts), where the single back link
 *  used to be. One earlier step reads exactly as that link did; two read as
 *  the steps themselves, each earlier one a button, on one line however
 *  narrow the window. */
export function ReturnTrail({ steps, onGoTo, testId }: { steps: Trail; onGoTo: (index: number) => void; testId: string }): JSX.Element | null {
  const { t } = useI18n()
  if (steps.length < 2) return null
  const hint = <span className="shrink-0 text-redlog-text-faint">{isMac ? '⌘[' : 'Alt+←'}</span>
  if (steps.length === 2) {
    return (
      <div data-testid={testId} className={BAR}>
        <Button size="compact" level="quiet" type="button" onClick={() => onGoTo(0)}>
          ← {t('nav.backTo', { view: t(trailLabelKey(steps[0])) })}
        </Button>
        {hint}
      </div>
    )
  }
  const last = steps.length - 1
  return (
    <div data-testid={testId} className={`${BAR} min-w-0 whitespace-nowrap`}>
      <ol className="flex min-w-0 items-center gap-1">
        {steps.slice(0, last).map((step, i) => {
          const label = t(trailLabelKey(step))
          return (
            <li key={`${i}:${step}`} className="flex min-w-0 items-center gap-1">
              <Button size="compact" level="quiet" type="button" data-step={step} onClick={() => onGoTo(i)}>
                <span className="truncate" title={label}>{label}</span>
              </Button>
              <span aria-hidden className="shrink-0 text-redlog-text-faint">›</span>
            </li>
          )
        })}
        <li aria-current="page" data-step={steps[last]} className="shrink-0 text-redlog-text">{t(trailLabelKey(steps[last]))}</li>
      </ol>
      {hint}
    </div>
  )
}
