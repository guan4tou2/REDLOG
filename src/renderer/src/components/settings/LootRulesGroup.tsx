import { useEffect, useState } from 'react'
import { FieldGroup, type ConfigState } from './SettingsShared'
import { CheckRow } from './CheckRow'

type LootRule = Awaited<ReturnType<Window['redlog']['loot']['rules']>>[number]

// One switch per loot rule (Spec 032). A rule that is off is not RECORDED as
// loot; its values are still masked — the hint says so, because "stop showing
// me JWTs" must not read as "store JWTs in clear".
export default function LootRulesGroup({
  config, setConfig, t
}: {
  config: ConfigState
  setConfig: (c: ConfigState) => void
  t: (key: string, vars?: Record<string, string | number>) => string
}): JSX.Element {
  const [rules, setRules] = useState<LootRule[] | null>(null)
  const [failed, setFailed] = useState(false)
  useEffect(() => {
    let live = true
    window.redlog.loot.rules()
      .then((r) => { if (live) setRules(r) })
      .catch(() => { if (live) setFailed(true) })
    return () => { live = false }
  }, [])

  const disabled = new Set(config.loot?.disabledRules ?? [])
  const toggle = (id: string, on: boolean): void => {
    const next = new Set(disabled)
    if (on) next.delete(id)
    else next.add(id)
    setConfig({ ...config, loot: { ...config.loot, disabledRules: [...next] } })
  }

  return (
    <FieldGroup title={t('settings.lootGroup')}>
      <p className="text-xs text-redlog-text-faint">{t('settings.lootHint')}</p>
      {failed && <p className="text-xs text-red-400" data-testid="loot-rules-failed">{t('settings.lootRulesFailed')}</p>}
      {rules?.map((r) => (
        <CheckRow
          key={r.id}
          align="start"
          checked={!disabled.has(r.id)}
          onChange={(next) => toggle(r.id, next)}
          inputTestId={`loot-rule-${r.id}`}
          // The rule id is an internal name (`ntlm_hash`, `private_key`).
          // What it actually matches lived only in `title`, which a keyboard
          // cannot reach and a screen reader does not read — so the one piece
          // of text that explains the row was unavailable to exactly the
          // people who needed it. It is the accessible name now.
          ariaLabel={r.description ? `${r.type} — ${r.description}` : r.type}
          label={<>
            <span className="font-mono">{r.type}</span>
            <span className="text-redlog-text-faint">
              {' · '}{r.confidence}{' · '}{r.pluginId ?? t('settings.lootBuiltin')}
            </span>
            {/* What it matches, as text rather than a hover. */}
            {r.description && (
              <span className="block text-redlog-text-faint" data-testid={`loot-rule-desc-${r.id}`}>{r.description}</span>
            )}
            {/* Spec 033: a rule that overran the time bound no longer runs,
                so its values are no longer masked either. Say so here. */}
            {r.stopped === 'time_limit' && (
              <span className="block text-red-400" data-testid={`loot-rule-stopped-${r.id}`}>
                {t('settings.lootRuleStopped')}
              </span>
            )}
          </>}
        />
      ))}
    </FieldGroup>
  )
}
