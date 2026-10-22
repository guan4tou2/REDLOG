import { FieldGroup, Field, ListField, isWindows, type ConfigState } from './SettingsShared'
import CapturePackGroup, { PackMember, usePackAvailability } from './CapturePackGroup'
import AgentsPanel from './AgentsPanel'
import ExternalCaptureGroup from './ExternalCaptureGroup'
import { SourceLastSeen } from './SourceLastSeen'
import { CheckRow } from './CheckRow'
import { useCaptureHealth } from '../../lib/useCaptureHealth'

/** Which health row speaks for a pack member. The health ids are the source
 *  names the capture runtime uses; the pack member ids are the config keys. */
const MEMBER_HEALTH_ID: Record<string, string> = {
  clipboard: 'clipboard',
  fileWatcher: 'file-watcher',
  processMonitor: 'process-monitor',
  connectionMonitor: 'connection-monitor'
}

export default function CaptureControlPage({
  config, setConfig, t, onOpenPlugins
}: {
  config: ConfigState
  setConfig: (c: ConfigState) => void
  t: (key: string, vars?: Record<string, string | number>) => string
  onOpenPlugins?: () => void
}): JSX.Element {
  const packs = usePackAvailability()
  // The same snapshot the dashboard's capture card reads. Every source row on
  // this page says when it last delivered, so the operator does not have to
  // leave the page to learn whether a source is feeding the record.
  const captureSignature = JSON.stringify([config.packs ?? {}, config.packMembers ?? {}, config.screenshot ?? {}])
  const { health } = useCaptureHealth(5_000, captureSignature)
  const healthOf = (id: string): CaptureSourceInfo | undefined =>
    health?.sources.find(s => s.id === id)
  return (
    <>
      {/* Spec 049: the four-bullet "what every project records" list is gone.
          It had no control, no state and no link, and it held the first screen
          of this page. The same four sources are rows in the Dashboard's
          capture inventory, where they carry whether they are actually feeding
          the record — which is what an operator came here to find out. */}
      <CapturePackGroup
        pack="hostMonitors" title={t('settings.packHostMonitors')} hint={t('settings.packHostMonitorsHint')}
        available={packs?.hostMonitors} config={config} setConfig={setConfig} t={t} onOpenPlugins={onOpenPlugins}
      >
        {/* Each member carries its own switch now. The clipboard is the
            reason: it samples whatever the operator copies anywhere on the
            machine for the length of the engagement, and bundling it with
            three host monitors meant an operator who wanted those three took
            it without deciding to. */}
        <PackMember
          member="clipboard" title={t('settings.clipboardGroup')}
          hint={t('settings.clipboardEnableHint')} warn={t('settings.clipboardScopeWarn')}
          health={healthOf(MEMBER_HEALTH_ID.clipboard)} packOn={config.packs?.hostMonitors === true}
          config={config} setConfig={setConfig} t={t}
        >
          <CheckRow
            checked={config.clipboard?.storePreview === true}
            onChange={(on) => setConfig({ ...config, clipboard: { ...config.clipboard, storePreview: on } })}
            label={t('settings.clipboardStorePreview')}
          />
          <p className="text-xs text-redlog-text-faint">{t('settings.clipboardStorePreviewHint')}</p>
        </PackMember>

        <PackMember
          member="fileWatcher" title={t('settings.fileWatcherGroup')}
          hint={t('settings.fileWatcherEnableHint')}
          health={healthOf(MEMBER_HEALTH_ID.fileWatcher)} packOn={config.packs?.hostMonitors === true}
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
          health={healthOf(MEMBER_HEALTH_ID.processMonitor)} packOn={config.packs?.hostMonitors === true}
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
          health={healthOf(MEMBER_HEALTH_ID.connectionMonitor)} packOn={config.packs?.hostMonitors === true}
          config={config} setConfig={setConfig} t={t}
        />
      </CapturePackGroup>

      {/* Optional AI integrations are installed per tool and authorized per project. */}
      <AgentsPanel config={config} setConfig={setConfig} t={t} onOpenPlugins={onOpenPlugins} />

      {/* A Windows capture on a Mac is not setup that is missing. Off Windows
          it waits in a collapsed group, and stays in the open if it was ever
          switched on (Spec 060 FR-010). */}
      {isWindows || config.packs?.windowsOutput === true ? (
        <CapturePackGroup
          pack="windowsOutput" title={t('settings.packWindowsOutput')} hint={t('settings.powershellTranscriptEnableHint')}
          available={packs?.windowsOutput} config={config} setConfig={setConfig} t={t} onOpenPlugins={onOpenPlugins}
        />
      ) : (
        <details data-testid="pack-other-platforms" className="mb-4">
          <summary className="text-xs text-redlog-text-faint cursor-pointer">{t('settings.otherPlatforms')} (1)</summary>
          <CapturePackGroup
            pack="windowsOutput" title={t('settings.packWindowsOutput')} hint={t('settings.powershellTranscriptEnableHint')}
            available={packs?.windowsOutput} config={config} setConfig={setConfig} t={t} onOpenPlugins={onOpenPlugins}
          />
        </details>
      )}

      {/* Last, and the one block on this page that is not per project: what
          the operator wires up on the machine itself. It sits here rather
          than on the Plugins page because the question it answers -- "is
          anything actually recording" -- is this page's question, and because
          what ships with RedLog is not a plugin. */}
      <ExternalCaptureGroup t={t} />

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
                (config.screenshot?.intervalSec ?? 0) === opt.v
                  ? 'bg-redlog-elevated text-redlog-text border border-redlog-border'
                  : 'bg-redlog-elevated text-redlog-text-dim hover:bg-redlog-elevated-hover'
              }`}
            >{t(opt.k)}</button>
          ))}
        </div>

        {/* The screenshot source is a source like the others: when it last
            delivered a frame is a fact about the record, not about the
            switch. */}
        <SourceLastSeen
          source={healthOf('screenshot')}
          active={(config.screenshot?.intervalSec ?? 0) > 0 || config.screenshot?.captureOnCommand === true}
          t={t}
        />

        <Field
          label={t('settings.jpegQuality')}
          value={String(config.screenshot?.quality ?? 85)}
          onChange={(v) => setConfig({ ...config, screenshot: { ...config.screenshot, quality: Math.min(100, Math.max(1, parseInt(v) || 85)) } })}
          type="number"
        />

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
                (config.screenshot?.diffThreshold ?? 5) === opt.v
                  ? 'bg-redlog-elevated text-redlog-text border border-redlog-border'
                  : 'bg-redlog-elevated text-redlog-text-dim hover:bg-redlog-elevated-hover'
              }`}
            >{t(opt.k)}</button>
          ))}
        </div>
        <p className="text-xs text-redlog-text-faint mt-2">{t('settings.screenshot.diffHint')}</p>

        <CheckRow
          align="start"
          checked={config.screenshot?.captureOnCommand ?? false}
          onChange={(on) => setConfig({ ...config, screenshot: { ...config.screenshot, captureOnCommand: on } })}
          label={t('settings.screenshot.onCommand')}
        />
        <p className="text-xs text-redlog-text-faint mt-1">{t('settings.screenshot.onCommandHint')}</p>
      </FieldGroup>

    </>
  )
}
