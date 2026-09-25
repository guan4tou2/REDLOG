import { toast } from '../Toast'
import { DEFAULT_CDP_PORT } from '../../lib/defaults'
import { FieldGroup, type ConfigState } from './SettingsShared'
import BrowserPanel from './BrowserPanel'

// The browser RedLog launches, and the HTTP capture proxy it wires that
// browser to, are capture sources: they decide what ends up in the record.
// They sat on the Network page beside the VPN and IP-exposure settings,
// which answer a different question - am I where I think I am - so an
// operator looking for 'where does my web traffic get recorded' had to
// know to look under network security to find it.
export default function BrowserPage({
  config, setConfig, t
}: {
  config: ConfigState
  setConfig: (c: ConfigState) => void
  t: (key: string, vars?: Record<string, string | number>) => string
}): JSX.Element {
  return (
    <>
      <BrowserPanel t={t} config={config} setConfig={setConfig} />
      <FieldGroup title={t('settings.cdp')}>
        <p className="text-xs text-redlog-text-faint mb-2">
          {t('settings.cdpHint', { port: String(config.browser?.cdpPort ?? DEFAULT_CDP_PORT) })}
        </p>
        <button
          onClick={async () => {
            // Uses the CDP port from BrowserPanel above (config.browser.
            // cdpPort) — the previous separate field silently didn't
            // auto-save so users often set two different ports without
            // knowing (audit finding P0 #43).
            const port = config.browser?.cdpPort ?? DEFAULT_CDP_PORT
            await window.redlog.cdp.setPort(port)
            const cdpTab = await window.redlog.cdp.getTab()
            if (cdpTab.connected) toast(t('settings.cdpConnected', { title: cdpTab.title ?? '', url: cdpTab.url ?? '' }), 'success')
            else {
              toast(t('settings.cdpNotConnectedTitle'), {
                type: 'error',
                why: t('settings.cdpNotConnected', { port: String(port) }),
                action: { label: t('common.retry'), onClick: () => { void window.redlog.cdp.getTab() } }
              })
            }
          }}
          className="px-3 py-1.5 bg-redlog-elevated text-redlog-text text-xs rounded hover:bg-redlog-elevated-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-500/40"
        >
          {t('settings.testConnection')}
        </button>
      </FieldGroup>
    </>
  )
}
