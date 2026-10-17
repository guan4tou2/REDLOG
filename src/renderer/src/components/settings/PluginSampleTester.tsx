import { useState } from 'react'
import { Button } from '../Button'

type Result = Awaited<ReturnType<Window['redlog']['plugins']['testSample']>>
type T = (k: string, v?: Record<string, string | number>) => string

// Paste a line, see what the loaded rules would do with it. Nothing is
// recorded: the answer comes from a dry run in main, not from the capture path.
export function PluginSampleTester({ t }: { t: T }): JSX.Element {
  const [text, setText] = useState('')
  const [result, setResult] = useState<Result | null>(null)
  const [failed, setFailed] = useState(false)
  const [busy, setBusy] = useState(false)

  const run = async (): Promise<void> => {
    setBusy(true); setFailed(false)
    try { setResult(await window.redlog.plugins.testSample(text)) }
    catch { setResult(null); setFailed(true) }
    finally { setBusy(false) }
  }
  const tagEntries = result ? Object.entries(result.tags) : []

  return (
    <div data-testid="plugin-sample" className="mt-3 border-t border-redlog-border pt-2">
      <p className="text-xs font-medium text-redlog-text">{t('plugins.sample.title')}</p>
      <p className="text-xs text-redlog-text-faint mb-1">{t('plugins.sample.hint')}</p>
      <textarea
        data-testid="plugin-sample-input"
        value={text}
        onChange={(e) => setText(e.target.value)}
        rows={3}
        spellCheck={false}
        aria-label={t('plugins.sample.title')}
        className="w-full text-xs font-mono rounded bg-redlog-elevated text-redlog-text p-2"
      />
      <Button level="secondary" onClick={run} disabled={busy || !text.trim()} data-testid="plugin-sample-run">
        {t('plugins.sample.run')}
      </Button>
      {failed && <p role="alert" className="text-xs text-red-400 mt-1">{t('plugins.sample.failed')}</p>}
      {result && (
        <div data-testid="plugin-sample-result" className="mt-2 text-xs space-y-1">
          {result.truncated && <p className="text-amber-500">{t('plugins.sample.truncated')}</p>}
          {result.overran.length > 0 && <p role="status" className="text-amber-500">{t('plugins.sample.overran', { rules: result.overran.join(', ') })}</p>}
          <p className="text-redlog-text-dim">{t('plugins.sample.masked', { count: result.maskedSpans })}</p>
          <pre className="font-mono whitespace-pre-wrap break-all bg-redlog-elevated rounded p-2">{result.masked}</pre>
          <div>
            <span className="text-redlog-text-dim">{t('plugins.sample.loot')}: </span>
            {result.loot.length === 0 && <span>{t('plugins.sample.none')}</span>}
            {result.loot.map((h, i) => (
              <p key={i} className="pl-3">
                {h.type} ({h.confidence}) — {h.pluginId ? `${h.pluginId}:${h.patternName}` : t('plugins.sample.builtin')}
                {!h.reported && <span className="text-amber-500"> — {t('plugins.sample.switchedOff')}</span>}
              </p>
            ))}
          </div>
          <p>
            <span className="text-redlog-text-dim">{t('plugins.sample.target')}: </span>
            {result.target.host
              ? `${result.target.host}${result.target.pluginId ? ` (${result.target.pluginId}:${result.target.extractorName})` : ''}`
              : t('plugins.sample.none')}
          </p>
          <p>
            <span className="text-redlog-text-dim">{t('plugins.sample.tags')}: </span>
            {tagEntries.length === 0 ? t('plugins.sample.none') : tagEntries.map(([k, v]) => `${k}=${v}`).join(', ')}
          </p>
        </div>
      )}
    </div>
  )
}
