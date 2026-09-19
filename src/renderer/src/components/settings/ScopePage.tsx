import { FieldGroup, Field, ListField, type ConfigState } from './SettingsShared'

export default function ScopePage({
  config, setConfig, t
}: {
  config: ConfigState
  setConfig: (c: ConfigState) => void
  t: (key: string, vars?: Record<string, string | number>) => string
}): JSX.Element {
  return (
    <>
      <FieldGroup title={t('settings.scopeEnforcement')}>
        <label className="flex items-center gap-2 cursor-pointer">
          <input
            type="checkbox"
            checked={config.scope.warnOnViolation !== false}
            onChange={(e) => setConfig({ ...config, scope: { ...config.scope, warnOnViolation: e.target.checked } })}
            className="accent-red-600"
          />
          <span className="text-xs text-redlog-text">{t('settings.warnOnViolation')}</span>
        </label>
        <p className="text-xs text-redlog-text-faint mt-1 leading-relaxed">{t('settings.warnOnViolationHint')}</p>
      </FieldGroup>
      <FieldGroup title={t('settings.inScopeTargets')}>
        <ListField
          label={t('settings.targetsLabel')}
          items={config.scope.targets}
          onChange={(items) => setConfig({ ...config, scope: { ...config.scope, targets: items } })}
          placeholder={t('settings.targetsPlaceholder')}
        />
      </FieldGroup>
      <FieldGroup title={t('settings.excludedTargets')}>
        <ListField
          label={t('settings.excludeLabel')}
          items={config.scope.excludeTargets}
          onChange={(items) => setConfig({ ...config, scope: { ...config.scope, excludeTargets: items } })}
          placeholder={t('settings.excludePlaceholder')}
        />
      </FieldGroup>
      <FieldGroup title={t('settings.personalDomains')}>
        <ListField
          label={t('settings.personalDomainsLabel')}
          items={config.scope.personalDomains ?? []}
          onChange={(items) => setConfig({ ...config, scope: { ...config.scope, personalDomains: items } })}
          placeholder={t('settings.personalDomainsPlaceholder')}
        />
        <p className="text-xs text-redlog-text-faint mt-1 leading-relaxed">
          {t('settings.personalDomainsHint')}
        </p>
      </FieldGroup>
      <FieldGroup title={t('settings.scopeFile')}>
        <Field
          label={t('settings.scopeFileLabel')}
          value={config.scope.scopeFile || ''}
          onChange={(v) => setConfig({ ...config, scope: { ...config.scope, scopeFile: v } })}
        />
        <p className="text-xs text-redlog-text-faint">
          {t('settings.scopeFileHint')}
        </p>
      </FieldGroup>
    </>
  )
}
