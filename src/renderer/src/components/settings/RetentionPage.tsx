import { FieldGroup, NumberField, type ConfigState } from './SettingsShared'
import UnattributedSpoolRow from './UnattributedSpoolRow'

// Spec 049: retention is a deletion policy, so it is filed under Scope and
// evidence rather than under Capture sources.
//
// It answers "what stops being kept", which is the opposite of the question
// every page in the capture group answers — and it sat there as the last block
// of the page that held every capture switch.
//
// Size-pressure eviction budgets. The rotation LOGIC shipped in #43
// (retention.ts); these are the knobs that switch it on. All in MB (operators
// think in MB; config stores bytes). 0 = keep everything. When a store is over
// budget the coldest out-of-scope files are evicted first and in-scope evidence
// is pinned. One group for every store — Spec 028's single model: size budgets
// first, then the row tier's age.

export default function RetentionPage({
  config, setConfig, t
}: {
  config: ConfigState
  setConfig: (c: ConfigState) => void
  t: (key: string, vars?: Record<string, string | number>) => string
}): JSX.Element {
  return (
    <FieldGroup title={t('settings.retentionGroup')}>
      <p className="text-xs text-redlog-text-faint">{t('settings.rotationHint')}</p>
      {([
        ['httpBodies', 'settings.rotationHttpBodies'],
        ['casts', 'settings.rotationCastStore'],
        ['screenshots', 'settings.rotationScreenshots']
      ] as const).map(([store, label]) => (
        <NumberField
          key={store}
          label={t(label)}
          value={Math.round((config.retention?.[store]?.maxBytes ?? 0) / 1024 / 1024)}
          min={0}
          onCommit={(n) => setConfig({ ...config, retention: { ...config.retention, [store]: { ...config.retention?.[store], maxBytes: n * 1024 * 1024 } } })}
          invalid={t('settings.numberInvalidMin', { min: 0 })}
          pending={t('settings.numberPending')}
        />
      ))}
      <p className="text-xs text-redlog-text-faint">{t('settings.retentionLoggedTierHint')}</p>
      <NumberField
        label={t('settings.retentionLoggedTier')}
        value={config.retention?.loggedTier?.keepDays ?? 0}
        min={0}
        onCommit={(n) => setConfig({ ...config, retention: { ...config.retention, loggedTier: { ...config.retention?.loggedTier, keepDays: n } } })}
        invalid={t('settings.numberInvalidMin', { min: 0 })}
        pending={t('settings.numberPending')}
      />
      <UnattributedSpoolRow t={t} />
    </FieldGroup>
  )
}
