import { useEffect } from 'react'
import { FieldGroup, NumberField, ListField, type ConfigState } from './SettingsShared'
import CapturePackGroup, { PackMember } from './CapturePackGroup'
import AgentsPanel from './AgentsPanel'
import ExternalCaptureGroup from './ExternalCaptureGroup'
import { SourceLastSeen } from './SourceLastSeen'
import { useCaptureHealth } from '../../lib/useCaptureHealth'
import { landOnSourceRow, SOURCE_ROW } from '../../lib/sourceRow'

/** Which health row speaks for a pack member. The health ids are the source
 *  names the capture runtime uses; the pack member ids are the config keys. */
const MEMBER_HEALTH_ID: Record<string, string> = {
  fileWatcher: 'file-watcher',
  processMonitor: 'process-monitor',
  connectionMonitor: 'connection-monitor'
}

export default function CaptureControlPage({
  config, setConfig, t, onOpenPlugins, onOpenIntegration, focusSource, onFocusHandled
}: {
  config: ConfigState
  setConfig: (c: ConfigState) => void
  t: (key: string, vars?: Record<string, string | number>) => string
  onOpenPlugins?: () => void
  /** Spec 066: open the Plugins page on one integration's detail. */
  onOpenIntegration?: (pluginId: string) => void
  /** The capture health id of the row to land on (#590): `agent-<kind>`,
   *  `screenshot`, a host-monitor member or an external hook. */
  focusSource?: string | null
  onFocusHandled?: () => void
}): JSX.Element {
  // The same snapshot the dashboard's capture card reads. Every source row on
  // this page says when it last delivered, so the operator does not have to
  // leave the page to learn whether a source is feeding the record.
  const captureSignature = JSON.stringify([config.packs ?? {}, config.packMembers ?? {}, config.screenshot ?? {}])
  const { health } = useCaptureHealth(5_000, captureSignature)
  const healthOf = (id: string): CaptureSourceInfo | undefined =>
    health?.sources.find(s => s.id === id)
  // Agent rows land themselves (AgentsPanel). Every other row is found by its
  // `data-source-id`; the pack and the external list read their state before
  // they draw, so the row may not exist yet.
  const agentKind = focusSource?.startsWith('agent-') ? focusSource.slice('agent-'.length) : null
  useEffect(() => {
    if (!focusSource || agentKind) return
    const land = (): boolean => {
      const row = document.querySelector<HTMLElement>(`[data-source-id="${focusSource}"]`)
      if (!row) return false
      landOnSourceRow(row); onFocusHandled?.()
      return true
    }
    if (land()) return
    const observer = new MutationObserver(() => { if (land()) observer.disconnect() })
    observer.observe(document.querySelector('[data-testid="settings-content"]') ?? document.body, { childList: true, subtree: true })
    // A row that is not drawn (its pack is off) must not hold the request.
    const giveUp = setTimeout(() => { observer.disconnect(); onFocusHandled?.() }, 4_000)
    return () => { observer.disconnect(); clearTimeout(giveUp) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusSource])
  return (
    <>
      {/* Spec 049: the four-bullet "what every project records" list is gone.
          It had no control, no state and no link, and it held the first screen
          of this page. The same four sources are rows in the Dashboard's
          capture inventory, where they carry whether they are actually feeding
          the record — which is what an operator came here to find out. */}
      {/* Optional AI integrations are installed per tool and authorized per project. */}
      <AgentsPanel config={config} setConfig={setConfig} t={t} onOpenPlugins={onOpenIntegration} focusAgentKind={agentKind} onFocusHandled={onFocusHandled} />

      <div data-source-id="screenshot" tabIndex={-1} className={SOURCE_ROW}>
      <FieldGroup title={t('settings.screenshotGroup')}>
        {/* Ruling 7 (2026-11-12): no timed capture and no capture when a
            command ends. Screenshots are taken when the operator asks; the
            quality below is the one setting those use. Nothing is supposed to
            be arriving on its own, so "nothing received yet" is not said. */}
        <SourceLastSeen source={healthOf('screenshot')} active={false} t={t} />
        <NumberField
          label={t('settings.jpegQuality')}
          value={config.screenshot?.quality ?? 85}
          min={1}
          max={100}
          onCommit={(n) => setConfig({ ...config, screenshot: { ...config.screenshot, quality: n } })}
          invalid={t('settings.numberInvalidRange', { min: 1, max: 100 })}
          pending={t('settings.numberPending')}
        />
      </FieldGroup>
      </div>

      <CapturePackGroup
        pack="hostMonitors" title={t('settings.packHostMonitors')} hint={t('settings.packHostMonitorsHint')}
        config={config} setConfig={setConfig} t={t} onOpenPlugins={onOpenPlugins}
      >
        <PackMember
          member="fileWatcher" sourceId={MEMBER_HEALTH_ID.fileWatcher} title={t('settings.fileWatcherGroup')}
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
          member="processMonitor" sourceId={MEMBER_HEALTH_ID.processMonitor} title={t('settings.processMonitorGroup')}
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
          member="connectionMonitor" sourceId={MEMBER_HEALTH_ID.connectionMonitor} title={t('settings.connectionMonitorGroup')}
          hint={t('settings.connectionMonitorEnableHint')} warn={t('settings.connectionMonitorSynNote')}
          health={healthOf(MEMBER_HEALTH_ID.connectionMonitor)} packOn={config.packs?.hostMonitors === true}
          config={config} setConfig={setConfig} t={t}
        />
      </CapturePackGroup>


      {/* Last, and the one block on this page that is not per project: what
          the operator wires up on the machine itself. It sits here rather
          than on the Plugins page because the question it answers -- "is
          anything actually recording" -- is this page's question, and because
          what ships with RedLog is not a plugin. */}
      <div className="empty:hidden">
        <ExternalCaptureGroup t={t} onOpenPlugins={onOpenPlugins} />
      </div>



    </>
  )
}
