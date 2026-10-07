import { Component, type ReactNode } from 'react'
import { useI18n } from '../i18n'
import { TITLEBAR_ICON } from './Button'

// A crash barrier sized for one control, not one screen.
//
// `ErrorBoundary` is the right answer for a view: it takes the pane and
// spends it on a readable failure with four ways out. It is the wrong answer
// for a 28px title-bar button, and until now there was nothing else — so the
// title bar had no boundary at all, and one control throwing during render or
// in a passive effect took the whole app root with it.
//
// That strip holds the evidence verbs. Losing every way to take a screenshot,
// attach a file or drop a marker, mid-engagement, because an unrelated button
// failed, is a capture outage caused by a cosmetic bug.
//
// Two rules the fallback follows:
//
//  - It stays. A control that quietly disappears reads as a control that was
//    never there, and the operator reaches for it later and finds nothing. §II:
//    a surface that cannot do its job says so. The warning sits in the strip
//    until it is retried or the app is reloaded.
//  - It is the same box. The replacement takes TITLEBAR_ICON geometry, so the
//    controls beside it do not shift when one fails — a strip that reflows on
//    a crash makes the operator re-find every remaining button.
//
// This catches render and lifecycle errors, which is what React boundaries
// catch. A throw inside an onClick is not one of them and never was.

interface Props {
  children: ReactNode
  /** Names the control in the tooltip — already translated by the caller. */
  name: string
}

interface State {
  error: Error | null
}

export class ControlBoundary extends Component<Props, State> {
  state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  render(): ReactNode {
    if (this.state.error) {
      return (
        <BrokenControl
          name={this.props.name}
          error={this.state.error}
          onRetry={() => this.setState({ error: null })}
        />
      )
    }
    return this.props.children
  }
}

// A function component so the fallback can reach `useI18n`; the boundary
// itself stays a class, because React still has no hook for
// `getDerivedStateFromError`.
function BrokenControl({ name, error, onRetry }: {
  name: string
  error: Error
  onRetry: () => void
}): JSX.Element {
  const { t } = useI18n()
  // The message is in the tooltip rather than on the strip: it is a developer
  // string, often long, and it must not be what sets the width of a title bar.
  const label = t('control.broken', { name })
  return (
    <button
      type="button"
      data-testid="control-broken"
      onClick={onRetry}
      aria-label={`${label} — ${t('control.brokenRetry')}`}
      title={`${label} — ${t('control.brokenRetry')}\n${error.message}`}
      className={`${TITLEBAR_ICON} bg-redlog-danger/10 text-redlog-danger border-redlog-danger/25 hover:bg-redlog-danger/20 focus-visible:ring-redlog-danger/40`}
    >
      <span aria-hidden>⚠</span>
    </button>
  )
}
