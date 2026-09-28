// A Copy button that says whether it copied (UI/UX audit F7).
//
// Setup screens ask the operator to copy install commands, the nonce command
// and CA commands. The buttons called writeClipboard and changed nothing on
// screen, so there was no telling whether it worked. writeClipboard reports
// the outcome precisely so a caller can show it (lib/clipboard.ts).

import { useEffect, useState } from 'react'
import { useI18n } from '../i18n'
import { writeClipboard } from '../lib/clipboard'
import { toast } from './Toast'
import { Button, type ButtonLevel } from './Button'

const SHOWN_MS = 1500

export function CopyButton({ text, label, level = 'quiet', className }: {
  text: string
  /** defaults to "Copy" */
  label?: string
  level?: ButtonLevel
  className?: string
}): JSX.Element {
  const { t } = useI18n()
  const [copied, setCopied] = useState(false)
  useEffect(() => {
    if (!copied) return
    const id = setTimeout(() => setCopied(false), SHOWN_MS)
    return () => clearTimeout(id)
  }, [copied])

  const copy = async (): Promise<void> => {
    if (await writeClipboard(text)) setCopied(true)
    else toast(t('common.copyFailed'), { type: 'error', why: t('transcript.copyFailedWhy') })
  }

  return (
    <Button level={level} className={className} onClick={() => void copy()} data-copied={copied ? 'true' : 'false'}>
      {/* The live region announces the change to screen readers too. */}
      <span aria-live="polite">{copied ? `✓ ${t('common.copied')}` : (label ?? t('firstRun.copy'))}</span>
    </Button>
  )
}
