import { useEffect, useState } from 'react'
import { useI18n } from '../i18n'
import { takePendingCommand, onRunInTerminal } from '../lib/terminalRunner'
import { toast } from './Toast'
import { writeClipboard } from '../lib/clipboard'

/** Setup commands are drafts, never input to a possibly remote/interactive PTY. */
export function SetupCommandReview(): JSX.Element | null {
  const [command, setCommand] = useState<string | null>(null)
  const { t } = useI18n()
  useEffect(() => {
    const pending = takePendingCommand()
    if (pending) setCommand(pending)
    return onRunInTerminal(value => { takePendingCommand(); setCommand(value) })
  }, [])
  if (!command) return null
  return (
    <section data-testid="setup-command-review" className="p-3 border-b border-redlog-border bg-redlog-surface space-y-2 shrink-0">
      <p className="text-xs text-redlog-text-dim">{t('terminal.setupReviewHint')}</p>
      <pre className="text-xs text-redlog-text font-mono whitespace-pre-wrap break-all max-h-32 overflow-auto select-text">{command}</pre>
      <div className="flex gap-3 text-xs">
        <button className="text-redlog-accent underline" onClick={async () => { if (!await writeClipboard(command)) toast(t('toast.copyFailed'), 'error') }}>{t('terminal.copySetup')}</button>
        <button className="text-redlog-text-dim underline" onClick={() => setCommand(null)}>{t('terminal.dismissSetup')}</button>
      </div>
    </section>
  )
}
