import { useEffect, useState } from 'react'
import { FieldGroup, type ConfigState } from './SettingsShared'

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
        <label key={r.id} className="flex items-start gap-2 cursor-pointer" title={r.description}>
          <input
            type="checkbox"
            checked={!disabled.has(r.id)}
            onChange={(e) => toggle(r.id, e.target.checked)}
            className="accent-red-600 mt-0.5"
            data-testid={`loot-rule-${r.id}`}
          />
          <span className="text-xs text-redlog-text">
            <span className="font-mono">{r.type}</span>
            <span className="text-redlog-text-faint">
              {' · '}{r.confidence}{' · '}{r.pluginId ?? t('settings.lootBuiltin')}
            </span>
            {/* Spec 033: a rule that overran the time bound no longer runs,
                so its values are no longer masked either. Say so here. */}
            {r.stopped === 'time_limit' && (
              <span className="block text-red-400" data-testid={`loot-rule-stopped-${r.id}`}>
                {t('settings.lootRuleStopped')}
              </span>
            )}
          </span>
        </label>
      ))}
    </FieldGroup>
  )
}
