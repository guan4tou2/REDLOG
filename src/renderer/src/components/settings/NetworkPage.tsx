import { useState } from 'react'
import { toast } from '../Toast'
import { DEFAULT_CDP_PORT } from '../../lib/defaults'
import { useI18n } from '../../i18n'
import { FieldGroup, Field, ListField, isMacOS, type ConfigState } from './SettingsShared'
import BrowserPanel from './BrowserPanel'

const DEFAULT_VPN_ADAPTERS = [
  { name: 'WireGuard', pattern: 'wireguard|^wg\\d', enabled: true },
  { name: 'OpenVPN (tun/tap)', pattern: '^(tun|tap)\\d|openvpn', enabled: true },
  { name: 'Tailscale', pattern: 'tailscale', enabled: true },
  { name: 'NordVPN', pattern: 'nordlynx|nordvpn', enabled: true },
  { name: 'ProtonVPN', pattern: 'proton', enabled: true },
  { name: 'Cisco AnyConnect', pattern: 'cisco\\s*anyconnect', enabled: true },
  { name: 'Fortinet / FortiClient', pattern: 'fortinet|forticlient', enabled: true },
  { name: 'GlobalProtect', pattern: 'globalprotect', enabled: true },
  { name: 'Juniper / Pulse Secure', pattern: 'juniper|pulse\\s*secure', enabled: true },
  { name: 'IPSec', pattern: '^ipsec', enabled: true },
  { name: 'PPP', pattern: '^ppp', enabled: true },
  { name: 'macOS utun', pattern: '^utun', enabled: true },
]
const builtinPatterns = new Set(DEFAULT_VPN_ADAPTERS.map((a) => a.pattern))

function VpnAdaptersField({ config, setConfig }: { config: ConfigState; setConfig: (c: ConfigState) => void }): JSX.Element {
  const { t } = useI18n()
  const adapters = config.network.vpnAdapters ?? DEFAULT_VPN_ADAPTERS
  const [newName, setNewName] = useState('')
  const [newPattern, setNewPattern] = useState('')

  const update = (list: typeof adapters): void => {
    setConfig({ ...config, network: { ...config.network, vpnAdapters: list } })
  }

  const toggle = (idx: number): void => {
    const next = adapters.map((a, i) => i === idx ? { ...a, enabled: !a.enabled } : a)
    update(next)
  }

  const addCustom = (): void => {
    const name = newName.trim()
    const pattern = newPattern.trim()
    if (!name || !pattern) return
    try { new RegExp(pattern) } catch { return }
    update([...adapters, { name, pattern, enabled: true }])
    setNewName('')
    setNewPattern('')
  }

  const remove = (idx: number): void => {
    update(adapters.filter((_, i) => i !== idx))
  }

  return (
    <div>
      <label className="block text-xs text-redlog-text-dim mb-1">{t('settings.vpnAdapters')}</label>
      <p className="text-xs text-redlog-text-faint mb-2">{t('settings.vpnAdaptersHint')}</p>
      <div className="space-y-1">
        {adapters.map((a, i) => (
          <div key={i} className="flex items-center gap-2">
            <label className="flex items-center gap-2 flex-1 cursor-pointer">
              <input
                type="checkbox"
                checked={a.enabled}
                onChange={() => toggle(i)}
                className="accent-red-600"
              />
              <span className="text-xs text-redlog-text">{a.name}</span>
            </label>
            <span className="text-xs text-redlog-text-faint font-mono truncate max-w-[140px]" title={a.pattern}>{a.pattern}</span>
            {!builtinPatterns.has(a.pattern) && (
              <button onClick={() => remove(i)} className="text-redlog-text-faint hover:text-red-400 text-xs">&times;</button>
            )}
          </div>
        ))}
      </div>
      <div className="mt-3 pt-2 border-t border-redlog-border">
        <p className="text-xs text-redlog-text-dim mb-1">{t('settings.vpnAddCustom')}</p>
        <div className="flex gap-1">
          <input
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            placeholder={t('settings.vpnNamePlaceholder')}
            className="flex-1 bg-redlog-surface border border-redlog-border rounded px-2 py-1 text-xs text-redlog-text focus:outline-none focus:border-red-500"
          />
          <input
            value={newPattern}
            onChange={(e) => setNewPattern(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && addCustom()}
            placeholder={t('settings.vpnPatternPlaceholder')}
            className="flex-1 bg-redlog-surface border border-redlog-border rounded px-2 py-1 text-xs text-redlog-text font-mono focus:outline-none focus:border-red-500"
          />
          <button onClick={addCustom} className="px-2 py-1 bg-redlog-elevated text-redlog-text-dim text-xs rounded hover:bg-redlog-elevated-hover">+</button>
        </div>
      </div>
    </div>
  )
}

export default function NetworkPage({
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

      <FieldGroup title={t('settings.ipSafety')}>
        {/* Adapter detection used to be its own group. It exists only to
            answer this group's question — is my traffic where I think it
            is — and reading it as a separate subject made "am I exposed"
            look like two unrelated settings instead of one. */}
        <ListField
          label={t('settings.whitelist')}
          items={config.network.whitelist}
          onChange={(items) => setConfig({ ...config, network: { ...config.network, whitelist: items } })}
          placeholder={t('settings.safeIpPlaceholder')}
        />
        <ListField
          label={t('settings.blacklist')}
          items={config.network.blacklist}
          onChange={(items) => setConfig({ ...config, network: { ...config.network, blacklist: items } })}
          placeholder={t('settings.exposedIpPlaceholder')}
        />
        <VpnAdaptersField config={config} setConfig={setConfig} />
      </FieldGroup>
      {/* Was "Polling", which read as a tuning knob and is why I nearly deleted
          it. It is not: every field here decides what RedLog itself sends
          out to the network and to whom — which resolver or third-party
          echo service learns your address, how often, and from where.
          During an engagement that is OPSEC surface, and SS1's operator
          has to be able to see it, not discover it in a packet capture. */}
      <FieldGroup title={t('settings.ownTraffic')}>
        <div>
          <label className="block text-xs text-redlog-text-dim mb-1">{t('settings.ipMode')}</label>
          <div className="flex gap-1">
            {(['auto', 'dns', 'http'] as const).map((m) => (
              <button
                key={m}
                onClick={() => setConfig({ ...config, network: { ...config.network, ipMode: m } })}
                className={`px-3 py-1 text-xs rounded transition-colors ${
                  (config.network.ipMode ?? 'auto') === m ? 'bg-redlog-elevated text-redlog-text border border-redlog-border' : 'bg-redlog-elevated text-redlog-text-dim hover:bg-redlog-elevated-hover'
                }`}
              >
                {t(`settings.ipMode.${m}`)}
              </button>
            ))}
          </div>
          <p className="text-xs text-redlog-text-faint mt-1">{t('settings.ipModeHint')}</p>
        </div>
        {/* Every platform: off keeps the SSID off every surface (main drops it
            before the HUD sees it). Only macOS also needs Location Services. */}
        <div>
          <label className="flex items-center gap-2 cursor-pointer">
            <input
              type="checkbox"
              checked={config.network.showWifiName ?? false}
              onChange={(e) => {
                const on = e.target.checked
                setConfig({ ...config, network: { ...config.network, showWifiName: on } })
                // Trigger the macOS Location Services prompt; once granted,
                // the OS un-redacts the SSID for the next network poll.
                if (on && isMacOS && navigator.geolocation) {
                  navigator.geolocation.getCurrentPosition(() => {}, () => {}, { timeout: 10000, maximumAge: 0 })
                }
              }}
              className="accent-red-600"
            />
            <span className="text-xs text-redlog-text">{t('settings.showWifiName')}</span>
          </label>
          {isMacOS && <p className="text-xs text-redlog-text-faint mt-1">{t('settings.showWifiNameHint')}</p>}
        </div>
        <Field
          label={t('settings.checkInterval')}
          value={String(config.network.checkInterval)}
          onChange={(v) => setConfig({ ...config, network: { ...config.network, checkInterval: parseInt(v) || 60 } })}
          type="number"
        />
        <p className="text-xs text-amber-600/80">{t('settings.pollingOpsecHint')}</p>
        <Field
          label={t('settings.confirmations')}
          value={String(config.network.confirmations ?? 3)}
          onChange={(v) => setConfig({ ...config, network: { ...config.network, confirmations: Math.max(1, parseInt(v) || 3) } })}
          type="number"
        />
        <p className="text-xs text-redlog-text-faint">{t('settings.confirmationsHint')}</p>
        <ListField
          label={t('settings.ipProviders')}
          items={config.network.providers ?? []}
          onChange={(items) => setConfig({ ...config, network: { ...config.network, providers: items } })}
          placeholder="https://ip.internal.example/json"
        />
        <p className="text-xs text-redlog-text-faint">{t('settings.ipProvidersHint')}</p>
      </FieldGroup>
    </>
  )
}
