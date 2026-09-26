import { FieldGroup, Field, ListField, type ConfigState } from './SettingsShared'
import LootRulesGroup from './LootRulesGroup'
import CapturePackGroup, { PackMember, usePackAvailability } from './CapturePackGroup'

export default function CaptureControlPage({
  config, setConfig, t
}: {
  config: ConfigState
  setConfig: (c: ConfigState) => void
  t: (key: string, vars?: Record<string, string | number>) => string
}): JSX.Element {
  const packs = usePackAvailability()
  return (
    <>
      {/* Spec 035: what every project records, then the optional packs —
          one switch each, their members' tuning beneath while on. */}
      <FieldGroup title={t('settings.essentialGroup')}>
        <p className="text-xs text-redlog-text-faint">{t('settings.essentialHint')}</p>
        <ul className="text-xs text-redlog-text space-y-1 list-disc pl-4" data-testid="essential-capture">
          <li>{t('settings.essentialShell')}</li>
          <li>{t('settings.essentialHttp')}</li>
          <li>{t('settings.essentialPty')}</li>
          <li>{t('settings.essentialTerminal')}</li>
        </ul>
      </FieldGroup>

      <CapturePackGroup
        pack="hostMonitors" title={t('settings.packHostMonitors')} hint={t('settings.packHostMonitorsHint')}
        available={packs?.hostMonitors} config={config} setConfig={setConfig} t={t}
      >
        {/* Each member carries its own switch now. The clipboard is the
            reason: it samples whatever the operator copies anywhere on the
            machine for the length of the engagement, and bundling it with
            three host monitors meant an operator who wanted those three took
            it without deciding to. */}
        <PackMember
          member="clipboard" title={t('settings.clipboardGroup')}
          hint={t('settings.clipboardEnableHint')} warn={t('settings.clipboardScopeWarn')}
          config={config} setConfig={setConfig} t={t}
        >
          <label className="flex items-center gap-2 cursor-pointer">
            <input
              type="checkbox"
              checked={config.clipboard?.storePreview === true}
              onChange={(e) => setConfig({ ...config, clipboard: { ...config.clipboard, storePreview: e.target.checked } })}
              className="accent-red-600"
            />
            <span className="text-xs text-redlog-text">{t('settings.clipboardStorePreview')}</span>
          </label>
          <p className="text-xs text-redlog-text-faint">{t('settings.clipboardStorePreviewHint')}</p>
        </PackMember>

        <PackMember
          member="fileWatcher" title={t('settings.fileWatcherGroup')}
          hint={t('settings.fileWatcherEnableHint')}
          config={config} setConfig={setConfig} t={t}
        >
          <ListField
            label={t('settings.fileWatcherPaths')}
            items={config.fileWatcher?.watchPaths ?? []}
            onChange={(items) => setConfig({ ...config, fileWatcher: { ...config.fileWatcher, watchPaths: items } })}
            placeholder={t('settings.fileWatcherPathsPlaceholder')}
          />
          <ListField
            label={t('settings.fileWatcherIgnore')}
            items={config.fileWatcher?.ignorePatterns ?? []}
            onChange={(items) => setConfig({ ...config, fileWatcher: { ...config.fileWatcher, ignorePatterns: items } })}
            placeholder={t('settings.fileWatcherIgnorePlaceholder')}
          />
          <p className="text-xs text-redlog-text-faint">{t('settings.fileWatcherIgnoreHint')}</p>
        </PackMember>

        <PackMember
          member="processMonitor" title={t('settings.processMonitorGroup')}
          hint={t('settings.processMonitorEnableHint')}
          config={config} setConfig={setConfig} t={t}
        >
          <ListField
            label={t('settings.processMonitorIgnore')}
            items={config.processMonitor?.ignoreCommands ?? []}
            onChange={(items) => setConfig({ ...config, processMonitor: { ...config.processMonitor, ignoreCommands: items } })}
            placeholder={t('settings.processMonitorIgnorePlaceholder')}
          />
          <p className="text-xs text-redlog-text-faint">{t('settings.processMonitorIgnoreHint')}</p>
        </PackMember>

        {/* The blind spot, stated where the operator turns it on — not
            only in a system event they might scroll past. */}
        <PackMember
          member="connectionMonitor" title={t('settings.connectionMonitorGroup')}
          hint={t('settings.connectionMonitorEnableHint')} warn={t('settings.connectionMonitorSynNote')}
          config={config} setConfig={setConfig} t={t}
        />
      </CapturePackGroup>

      <CapturePackGroup
        pack="aiAgents" title={t('settings.packAiAgents')} hint={t('settings.packAiAgentsHint')}
        available={packs?.aiAgents} config={config} setConfig={setConfig} t={t}
      />

      <CapturePackGroup
        pack="windowsOutput" title={t('settings.packWindowsOutput')} hint={t('settings.powershellTranscriptEnableHint')}
        available={packs?.windowsOutput} config={config} setConfig={setConfig} t={t}
      />

      <LootRulesGroup config={config} setConfig={setConfig} t={t} />

      <FieldGroup title={t('settings.screenshotGroup')}>
        <div className="flex items-center gap-2 flex-wrap">
          {[
            { v: 0, k: 'settings.screenshot.interval.off' },
            { v: 30, k: 'settings.screenshot.interval.30s' },
            { v: 60, k: 'settings.screenshot.interval.60s' },
            { v: 300, k: 'settings.screenshot.interval.5m' }
          ].map((opt) => (
            <button
              key={opt.v}
              onClick={() => setConfig({ ...config, screenshot: { ...config.screenshot, intervalSec: opt.v } })}
              className={`px-3 py-1 text-xs rounded ${
                (config.screenshot.intervalSec ?? 0) === opt.v
                  ? 'bg-redlog-elevated text-redlog-text border border-redlog-border'
                  : 'bg-redlog-elevated text-redlog-text-dim hover:bg-redlog-elevated-hover'
              }`}
            >{t(opt.k)}</button>
          ))}
        </div>
        <p className="text-xs text-redlog-text-faint mt-2">{t('settings.screenshot.intervalHint')}</p>

        <Field
          label={t('settings.jpegQuality')}
          value={String(config.screenshot?.quality ?? 85)}
          onChange={(v) => setConfig({ ...config, screenshot: { ...config.screenshot, quality: Math.min(100, Math.max(1, parseInt(v) || 85)) } })}
          type="number"
        />
        <p className="text-xs text-redlog-text-faint">
          {t('settings.qualityHint')}
        </p>

        <label className="text-xs text-redlog-text-dim mt-3 block">{t('settings.screenshot.diffLabel')}</label>
        <div className="flex items-center gap-2 flex-wrap">
          {[
            { v: 0, k: 'settings.screenshot.diff.off' },
            { v: 5, k: 'settings.screenshot.diff.standard' },
            { v: 12, k: 'settings.screenshot.diff.major' }
          ].map((opt) => (
            <button
              key={opt.v}
              onClick={() => setConfig({ ...config, screenshot: { ...config.screenshot, diffThreshold: opt.v } })}
              className={`px-3 py-1 text-xs rounded ${
                (config.screenshot.diffThreshold ?? 5) === opt.v
                  ? 'bg-redlog-elevated text-redlog-text border border-redlog-border'
                  : 'bg-redlog-elevated text-redlog-text-dim hover:bg-redlog-elevated-hover'
              }`}
            >{t(opt.k)}</button>
          ))}
        </div>
        <p className="text-xs text-redlog-text-faint mt-2">{t('settings.screenshot.diffHint')}</p>

        <label className="flex items-start gap-2 mt-3 text-xs cursor-pointer">
          <input
            type="checkbox"
            checked={config.screenshot?.captureOnCommand ?? false}
            onChange={(e) => setConfig({ ...config, screenshot: { ...config.screenshot, captureOnCommand: e.target.checked } })}
            className="mt-0.5 accent-redlog-accent"
          />
          <span className="text-redlog-text-dim">{t('settings.screenshot.onCommand')}</span>
        </label>
        <p className="text-xs text-redlog-text-faint mt-1">{t('settings.screenshot.onCommandHint')}</p>
      </FieldGroup>

      {/* Size-pressure eviction budgets. The rotation LOGIC shipped in
          #43 (retention.ts); these are the knobs that switch it on. All
          in MB (operators think in MB; config stores bytes). 0 = keep
          everything. When a store is over budget the coldest out-of-scope
          files are evicted first and in-scope evidence is pinned. */}
      {/* One group for every store's retention (Spec 028's single model):
          size budgets first, then the row tier's age. Merged in Spec 032,
          which added the Loot group, so the group count holds. */}
      <FieldGroup title={t('settings.retentionGroup')}>
        <p className="text-xs text-redlog-text-faint">{t('settings.rotationHint')}</p>
        {([
          ['httpBodies', 'settings.rotationHttpBodies'],
          ['casts', 'settings.rotationCastStore'],
          ['screenshots', 'settings.rotationScreenshots']
        ] as const).map(([store, label]) => (
          <Field
            key={store}
            label={t(label)}
            value={String(Math.round((config.retention?.[store]?.maxBytes ?? 0) / 1024 / 1024))}
            onChange={(v) => setConfig({ ...config, retention: { ...config.retention, [store]: { ...config.retention?.[store], maxBytes: Math.max(0, parseInt(v) || 0) * 1024 * 1024 } } })}
            type="number"
          />
        ))}
        <p className="text-xs text-redlog-text-faint">{t('settings.retentionLoggedTierHint')}</p>
        <Field
          label={t('settings.retentionLoggedTier')}
          value={String(config.retention?.loggedTier?.keepDays ?? 0)}
          onChange={(v) => setConfig({ ...config, retention: { ...config.retention, loggedTier: { ...config.retention?.loggedTier, keepDays: Math.max(0, parseInt(v) || 0) } } })}
          type="number"
        />
      </FieldGroup>
    </>
  )
}
