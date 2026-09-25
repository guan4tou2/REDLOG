import type { ParseOutcome } from '../../../core/query/contract'
import { useI18n } from '../i18n'

// How a typed query was read (query contract, Parsing rule 6): which tokens
// are conditions on a stored field and which are full text, or why the input
// could not be read at all. Search, the Transcript and the Timeline each drew
// their own copy of this, worded differently; this is the one.
//
// Unparsable is its own state. It is not a failure — nothing was asked — and
// it is emphatically not an empty result, which would invite reading a typo
// as proof the evidence is absent. Each surface names what it did not do in
// `unparsableTitle`; the reason is worded here.
export function QueryReadout({ outcome, testId, unparsableTitle }: {
  outcome: ParseOutcome | null
  /** Prefix for `-parse` and `-unparsable`. */
  testId: string
  unparsableTitle: string
}): JSX.Element | null {
  const { t } = useI18n()
  if (!outcome) return null
  if (!outcome.ok) {
    return (
      <div data-testid={`${testId}-unparsable`} role="status" className="rounded border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-200">
        <div className="font-medium">{unparsableTitle}</div>
        <div className="mt-1 text-redlog-text-dim">
          {t(`query.unparsable.${outcome.reason}`, { token: outcome.token })}
        </div>
      </div>
    )
  }
  if (outcome.parsed.tokens.length === 0) return null
  return (
    <div data-testid={`${testId}-parse`} className="flex flex-wrap items-center gap-1 text-xs">
      <span className="text-redlog-text-faint">{t('query.readAs')}</span>
      {outcome.parsed.tokens.map((token, i) => (
        <span
          key={i}
          data-token={token.read}
          title={t(token.read === 'condition' ? 'query.tokenCondition' : 'query.tokenText')}
          className={`font-mono px-1 py-0.5 rounded border ${
            token.read === 'condition'
              ? 'text-indigo-300 border-indigo-500/40 bg-indigo-500/10'
              : 'text-redlog-text-dim border-redlog-border bg-redlog-surface'
          }`}
        >{token.raw}</span>
      ))}
    </div>
  )
}
