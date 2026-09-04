import { Component, useState, type ReactNode } from 'react'
import { useI18n } from '../i18n'
import { buildDiagnostics, issueUrl } from '../lib/diagnostics'
import { toast } from './Toast'
import { Button } from './Button'

// The screen an operator sees when a view crashes mid-engagement
// (docs/UIUX-STANDARD.md §9). It used to be a red glyph, `error.message` and a
// Retry button, all hardcoded in English in an app whose interface is
// Traditional Chinese — so the one screen that appears when everything else
// has failed was also the one screen nobody could read.
//
// §9 asks for four ways out, in order of how much they cost: retry the view,
// go back to somewhere that works, copy the diagnostics, or open an issue with
// them. The diagnostics are scrubbed and shown in full first: a stack trace
// carries absolute paths, and on this kind of engagement those paths carry the
// operator's username and the client's name in a project folder.

const REPO = 'guan4tou2/REDLOG'

interface Props {
  children: ReactNode
  label?: string
  /** Where "back to safety" goes. Omitted for the outermost boundary. */
  onGoHome?: () => void
  /** Scrubbed out of the diagnostics by name — it is usually the client's. */
  projectName?: string
}

interface State {
  error: Error | null
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  render(): ReactNode {
    if (this.state.error) {
      return (
        <FatalScreen
          error={this.state.error}
          label={this.props.label}
          projectName={this.props.projectName}
          onRetry={() => this.setState({ error: null })}
          onGoHome={this.props.onGoHome}
        />
      )
    }
    return this.props.children
  }
}

// A function component so the crash screen can use hooks — chiefly `useI18n`,
// which a class cannot reach. The boundary itself has to stay a class; React
// still has no hook for `getDerivedStateFromError`.
function FatalScreen({ error, label, projectName, onRetry, onGoHome }: {
  error: Error
  label?: string
  projectName?: string
  onRetry: () => void
  onGoHome?: () => void
}): JSX.Element {
  const { t } = useI18n()
  const [showDiagnostics, setShowDiagnostics] = useState(false)

  const platform = (window as { redlog?: { platform?: string } }).redlog?.platform
  const diagnostics = buildDiagnostics({
    version: typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : 'dev',
    platform: platform ?? 'unknown',
    view: label ?? 'unknown',
    error,
    // The username is stripped structurally by `scrubPath` — it is always a
    // path segment. The project name is not, so it is passed in by name.
    project: projectName
  })

  return (
    <div className="flex flex-col items-center justify-center h-full p-8 text-center gap-3 select-text">
      <div className="text-redlog-danger text-xl" aria-hidden>⚠</div>
      <p className="text-redlog-text text-sm font-medium">
        {t('fatal.title', { view: label ?? t('fatal.thisView') })}
      </p>
      <p className="text-redlog-text-dim text-xs max-w-md">{t('fatal.why')}</p>
      <p className="text-redlog-text-faint text-xs font-mono max-w-md break-all">{error.message}</p>

      <div className="flex flex-wrap items-center justify-center gap-2 mt-1">
        <button
          onClick={onRetry}
          className="px-3 py-1.5 text-xs rounded bg-redlog-elevated text-redlog-text hover:bg-redlog-elevated-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-redlog-accent/40"
        >
          {t('fatal.retry')}
        </button>
        {onGoHome && (
          <button
            onClick={onGoHome}
            className="px-3 py-1.5 text-xs rounded bg-redlog-elevated text-redlog-text-dim hover:bg-redlog-elevated-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-redlog-accent/40"
          >
            {t('fatal.goHome')}
          </button>
        )}
        <button
          onClick={() => setShowDiagnostics((v) => !v)}
          aria-expanded={showDiagnostics}
          className="px-3 py-1.5 text-xs rounded bg-redlog-elevated text-redlog-text-dim hover:bg-redlog-elevated-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-redlog-accent/40"
        >
          {t('fatal.diagnostics')}
        </button>
      </div>

      {/* §9: the operator reads the exact text before it can leave the
          machine. Copy and Open issue live inside the preview for that
          reason — neither is reachable without the payload on screen. */}
      {showDiagnostics && (
        <div className="w-full max-w-xl text-left mt-1">
          <pre className="max-h-56 overflow-auto whitespace-pre-wrap break-all bg-redlog-bg border border-redlog-border rounded p-3 text-xs font-mono text-redlog-text-dim">
            {diagnostics}
          </pre>
          <p className="text-xs text-redlog-text-faint mt-1.5">{t('fatal.scrubbed')}</p>
          <div className="flex gap-2 mt-2">
            <button
              onClick={() => {
                navigator.clipboard.writeText(diagnostics).then(
                  () => toast(t('toast.copied'), 'success'),
                  () => toast(t('transcript.copyFailed'), { type: 'error', why: t('transcript.copyFailedWhy') })
                )
              }}
              className="px-3 py-1.5 text-xs rounded bg-redlog-elevated text-redlog-text hover:bg-redlog-elevated-hover"
            >
              {t('fatal.copy')}
            </button>
            <Button
              level="primary"
              onClick={() => {
                void window.redlog?.app?.openExternal?.(
                  issueUrl(REPO, `${label ?? 'View'} crashed: ${error.message.slice(0, 80)}`, diagnostics)
                )
              }}
            >
              {t('fatal.openIssue')}
            </Button>
          </div>
        </div>
      )}
    </div>
  )
}
