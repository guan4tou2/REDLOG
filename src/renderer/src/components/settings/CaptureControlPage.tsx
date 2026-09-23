import { FieldGroup, Field, ListField, type ConfigState } from './SettingsShared'

export default function CaptureControlPage({
  config, setConfig, t
}: {
  config: ConfigState
  setConfig: (c: ConfigState) => void
  t: (key: string, vars?: Record<string, string | number>) => string
}): JSX.Element {
  return (
    <>
      <FieldGroup title={t('settings.clipboardGroup')}>
        <label className="flex items-center gap-2 cursor-pointer">
          <input
            type="checkbox"
            checked={config.clipboard?.enabled === true}
            onChange={(e) => setConfig({ ...config, clipboard: { ...config.clipboard, enabled: e.target.checked } })}
            className="accent-red-600"
          />
          <span className="text-xs text-redlog-text">{t('settings.clipboardEnable')}</span>
        </label>
        <p className="text-xs text-redlog-text-faint">{t('settings.clipboardEnableHint')}</p>
        {config.clipboard?.enabled && (
          <label className="flex items-center gap-2 cursor-pointer mt-2">
            <input
              type="checkbox"
              checked={config.clipboard?.storePreview === true}
              onChange={(e) => setConfig({ ...config, clipboard: { ...config.clipboard, enabled: true, storePreview: e.target.checked } })}
              className="accent-red-600"
            />
            <span className="text-xs text-redlog-text">{t('settings.clipboardStorePreview')}</span>
          </label>
        )}
        {config.clipboard?.enabled && (
          <p className="text-xs text-redlog-text-faint">{t('settings.clipboardStorePreviewHint')}</p>
        )}
      </FieldGroup>

      <FieldGroup title={t('settings.fileWatcherGroup')}>
        <label className="flex items-center gap-2 cursor-pointer">
          <input
            type="checkbox"
            checked={config.fileWatcher?.enabled === true}
            onChange={(e) => setConfig({ ...config, fileWatcher: { ...config.fileWatcher, enabled: e.target.checked } })}
            className="accent-red-600"
          />
          <span className="text-xs text-redlog-text">{t('settings.fileWatcherEnable')}</span>
        </label>
        <p className="text-xs text-redlog-text-faint">{t('settings.fileWatcherEnableHint')}</p>
        {config.fileWatcher?.enabled && (
          <>
            <ListField
              label={t('settings.fileWatcherPaths')}
              items={config.fileWatcher?.watchPaths ?? []}
              onChange={(items) => setConfig({ ...config, fileWatcher: { ...config.fileWatcher, enabled: true, watchPaths: items } })}
              placeholder={t('settings.fileWatcherPathsPlaceholder')}
            />
            <ListField
              label={t('settings.fileWatcherIgnore')}
              items={config.fileWatcher?.ignorePatterns ?? []}
              onChange={(items) => setConfig({ ...config, fileWatcher: { ...config.fileWatcher, enabled: true, ignorePatterns: items } })}
              placeholder={t('settings.fileWatcherIgnorePlaceholder')}
            />
            <p className="text-xs text-redlog-text-faint">{t('settings.fileWatcherIgnoreHint')}</p>
          </>
        )}
      </FieldGroup>

      <FieldGroup title={t('settings.processMonitorGroup')}>
        <label className="flex items-center gap-2 cursor-pointer">
          <input
            type="checkbox"
            checked={config.processMonitor?.enabled === true}
            onChange={(e) => setConfig({ ...config, processMonitor: { ...config.processMonitor, enabled: e.target.checked } })}
            className="accent-red-600"
          />
          <span className="text-xs text-redlog-text">{t('settings.processMonitorEnable')}</span>
        </label>
        <p className="text-xs text-redlog-text-faint">{t('settings.processMonitorEnableHint')}</p>
        {config.processMonitor?.enabled && (
          <>
            <ListField
              label={t('settings.processMonitorIgnore')}
              items={config.processMonitor?.ignoreCommands ?? []}
              onChange={(items) => setConfig({ ...config, processMonitor: { ...config.processMonitor, enabled: true, ignoreCommands: items } })}
              placeholder={t('settings.processMonitorIgnorePlaceholder')}
            />
            <p className="text-xs text-redlog-text-faint">{t('settings.processMonitorIgnoreHint')}</p>
          </>
        )}
      </FieldGroup>

      <FieldGroup title={t('settings.connectionMonitorGroup')}>
        <label className="flex items-center gap-2 cursor-pointer">
          <input
            type="checkbox"
            checked={config.connectionMonitor?.enabled === true}
            onChange={(e) => setConfig({ ...config, connectionMonitor: { ...config.connectionMonitor, enabled: e.target.checked } })}
            className="accent-red-600"
          />
          <span className="text-xs text-redlog-text">{t('settings.connectionMonitorEnable')}</span>
        </label>
        <p className="text-xs text-redlog-text-faint">{t('settings.connectionMonitorEnableHint')}</p>
        {/* The blind spot, stated where the operator turns it on — not
            only in a system event they might scroll past. */}
        <p className="text-xs text-amber-500/80">{t('settings.connectionMonitorSynNote')}</p>
      </FieldGroup>

      <FieldGroup title={t('settings.transcriptTailerGroup')}>
        <label className="flex items-center gap-2 cursor-pointer">
          <input
            type="checkbox"
            checked={config.transcriptTailer?.enabled === true}
            onChange={(e) => setConfig({ ...config, transcriptTailer: { ...config.transcriptTailer, enabled: e.target.checked } })}
            className="accent-red-600"
          />
          <span className="text-xs text-redlog-text">{t('settings.transcriptTailerEnable')}</span>
        </label>
        <p className="text-xs text-redlog-text-faint">{t('settings.transcriptTailerEnableHint')}</p>
      </FieldGroup>

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
      <FieldGroup title={t('settings.rotationGroup')}>
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
      </FieldGroup>

      <FieldGroup title={t('settings.retentionGroup')}>
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
