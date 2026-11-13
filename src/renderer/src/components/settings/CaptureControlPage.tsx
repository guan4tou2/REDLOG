import { useEffect, useRef } from 'react'
import { Button } from '../Button'
import { FieldGroup, Field, ListField, type ConfigState } from './SettingsShared'
import CapturePackGroup, { PackMember } from './CapturePackGroup'
import AgentsPanel from './AgentsPanel'
import ExternalCaptureGroup from './ExternalCaptureGroup'
import { SourceLastSeen } from './SourceLastSeen'
import { CheckRow } from './CheckRow'
import { useCaptureHealth } from '../../lib/useCaptureHealth'
import { landOnSourceRow, SOURCE_ROW } from '../../lib/sourceRow'

/** Which health row speaks for a pack member. The health ids are the source
 *  names the capture runtime uses; the pack member ids are the config keys. */
const MEMBER_HEALTH_ID: Record<string, string> = {
  fileWatcher: 'file-watcher',
  processMonitor: 'process-monitor',
  connectionMonitor: 'connection-monitor'
}

/** The page's four groups, in page order (#557). The landmark's name is not a
 *  setting; it is held in a constant so the search index does not list it. */
const JUMP_NAV = 'settings.captureJump'
const JUMPS = [
  { id: 'agents', label: 'settings.agents' },
  { id: 'screenshot', label: 'settings.screenshotGroup' },
  { id: 'hostMonitors', label: 'settings.packHostMonitors' },
  { id: 'external', label: 'settings.externalCapture' }
] as const

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
  // #557: four groups on one page. A jump per group, in page order; the labels
  // are the group titles, so the buttons need no copy of their own.
  const groups = useRef<Record<string, HTMLElement | null>>({})
  const group = (id: string) => (el: HTMLElement | null): void => { groups.current[id] = el }
  return (
    <>
      <nav aria-label={t(JUMP_NAV)} className="flex flex-wrap gap-1.5">
        {JUMPS.map(({ id, label }) => (
          <Button key={id} size="compact" level="quiet" data-testid={`capture-jump-${id}`}
            onClick={() => groups.current[id]?.scrollIntoView?.({ block: 'start' })}>{t(label)}</Button>
        ))}
      </nav>
      {/* Spec 049: the four-bullet "what every project records" list is gone.
          It had no control, no state and no link, and it held the first screen
          of this page. The same four sources are rows in the Dashboard's
          capture inventory, where they carry whether they are actually feeding
          the record — which is what an operator came here to find out. */}
      {/* Optional AI integrations are installed per tool and authorized per project. */}
      <div ref={group('agents')} className="scroll-mt-4">
        <AgentsPanel config={config} setConfig={setConfig} t={t} onOpenPlugins={onOpenIntegration} focusAgentKind={agentKind} onFocusHandled={onFocusHandled} />
      </div>

      <div ref={group('screenshot')} data-source-id="screenshot" tabIndex={-1} className={SOURCE_ROW}>
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
              aria-pressed={(config.screenshot?.intervalSec ?? 0) === opt.v}
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

        <CheckRow
          align="start"
          checked={config.screenshot?.captureOnCommand ?? false}
          onChange={(on) => setConfig({ ...config, screenshot: { ...config.screenshot, captureOnCommand: on } })}
          label={t('settings.screenshot.onCommand')}
        />
        <details>
          <summary className="min-h-8 content-center cursor-pointer text-xs text-redlog-text-dim">{t('settings.screenshot.options')}</summary>
          <div className="space-y-2 pt-2">
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
              aria-pressed={(config.screenshot?.diffThreshold ?? 5) === opt.v}
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




          </div>
        </details>
      </FieldGroup>
      </div>

      <div ref={group('hostMonitors')} className="scroll-mt-4">
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
          member="connectionMonitor" sourceId={MEMBER_HEALTH_ID.connectionMonitor} title={t('settings.connectionMonitorGroup')}
          hint={t('settings.connectionMonitorEnableHint')} warn={t('settings.connectionMonitorSynNote')}
          health={healthOf(MEMBER_HEALTH_ID.connectionMonitor)} packOn={config.packs?.hostMonitors === true}
          config={config} setConfig={setConfig} t={t}
        />
      </CapturePackGroup>
      </div>


      {/* Last, and the one block on this page that is not per project: what
          the operator wires up on the machine itself. It sits here rather
          than on the Plugins page because the question it answers -- "is
          anything actually recording" -- is this page's question, and because
          what ships with RedLog is not a plugin. */}
      <div ref={group('external')} className="scroll-mt-4 empty:hidden">
        <ExternalCaptureGroup t={t} onOpenPlugins={onOpenPlugins} />
      </div>



    </>
  )
}
