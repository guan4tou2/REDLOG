import { useEffect, useState, type ReactNode } from 'react'
import { FieldGroup, type ConfigState } from './SettingsShared'
import { isMemberSelected, OPT_IN_MEMBERS } from '../../../../core/capture-packs'

// One optional capture pack (Spec 035): a single switch for the project, and
// its members' tuning beneath while it is on. A pack whose bundled plugin was
// disabled in Plugins is removed — said so here instead of offering a switch
// that would record nothing.

export type PackId = 'hostMonitors' | 'aiAgents' | 'windowsOutput'

export type PackMemberId = NonNullable<keyof NonNullable<ConfigState['packMembers']>>

/** One member of a pack that is on: its own switch, then its tuning.
 *
 *  A pack is a preset, not an atom. "Host monitors" bundles four sources and
 *  the clipboard is not like the other three — it samples whatever the
 *  operator copies anywhere on the machine, for the length of the engagement.
 *  All-or-nothing turned "I want process and connection monitoring but not my
 *  clipboard" into "then have neither". An unset switch follows the member's
 *  default — the same rule the capture runtime reads (isMemberSelected) — and
 *  the clipboard's default is off: it is never collected because a pack was
 *  turned on, only because it was ticked (#224). */
export function PackMember({
  member, title, hint, warn, config, setConfig, t, children
}: {
  member: PackMemberId
  title: string
  hint: string
  /** Shown in amber under the hint: what turning this one on costs. */
  warn?: string
  config: ConfigState
  setConfig: (c: ConfigState) => void
  t: (key: string, vars?: Record<string, string | number>) => string
  children?: ReactNode
}): JSX.Element {
  const on = isMemberSelected(config.packMembers, member)
  const optIn = OPT_IN_MEMBERS.has(member)
  return (
    <div className="mt-2">
      <p className="text-xs font-semibold text-redlog-text-dim">{title}</p>
      <label className="flex items-center gap-2 cursor-pointer">
        <input
          type="checkbox"
          checked={on}
          onChange={(e) => setConfig({
            ...config,
            packMembers: { ...config.packMembers, [member]: e.target.checked }
          })}
          className="accent-red-600"
          data-testid={`pack-member-${member}`}
        />
        <span className="text-xs text-redlog-text">{t('settings.packMemberRecord')}</span>
      </label>
      {optIn && !on && (
        <p className="text-xs text-redlog-text-faint" data-testid={`pack-member-optin-${member}`}>{t('settings.packMemberOptIn')}</p>
      )}
      <p className="text-xs text-redlog-text-faint">{hint}</p>
      {warn && <p className="text-xs text-amber-500/80">{warn}</p>}
      {/* Tuning for a member that is off would be controls for something that
          is not running — the same lie the pack switch avoids above. */}
      {on && children}
    </div>
  )
}

const PLUGIN_OF: Record<PackId, string> = {
  hostMonitors: 'pack-host-monitors',
  aiAgents: 'pack-ai-agents',
  windowsOutput: 'pack-windows-output'
}

/** Whether each pack's plugin is active; `null` while loading. */
export function usePackAvailability(): Record<PackId, boolean> | null {
  const [avail, setAvail] = useState<Record<PackId, boolean> | null>(null)
  useEffect(() => {
    let live = true
    const plugins = (window.redlog as { plugins?: { list?: () => Promise<Array<{ id: string; source: string; status: string }>> } })
      .plugins?.list?.()
    if (!plugins) { setAvail({ hostMonitors: true, aiAgents: true, windowsOutput: true }); return }
    plugins.then((list) => {
      if (!live) return
      const on = (id: string): boolean => list.some((p) => p.id === id && p.source === 'bundled' && p.status === 'active')
      setAvail({ hostMonitors: on(PLUGIN_OF.hostMonitors), aiAgents: on(PLUGIN_OF.aiAgents), windowsOutput: on(PLUGIN_OF.windowsOutput) })
    }).catch(() => { if (live) setAvail({ hostMonitors: true, aiAgents: true, windowsOutput: true }) })
    return () => { live = false }
  }, [])
  return avail
}

export default function CapturePackGroup({
  pack, title, hint, available, config, setConfig, t, children
}: {
  pack: PackId
  title: string
  hint: string
  available: boolean | undefined
  config: ConfigState
  setConfig: (c: ConfigState) => void
  t: (key: string, vars?: Record<string, string | number>) => string
  /** Member tuning, shown while the pack is on. */
  children?: ReactNode
}): JSX.Element {
  const on = config.packs?.[pack] === true
  return (
    <FieldGroup title={title}>
      {available === false ? (
        <p className="text-xs text-amber-500/80" data-testid={`pack-removed-${pack}`}>{t('settings.packRemoved')}</p>
      ) : (
        <label className="flex items-center gap-2 cursor-pointer">
          <input
            type="checkbox"
            checked={on}
            onChange={(e) => setConfig({ ...config, packs: { ...config.packs, [pack]: e.target.checked } })}
            className="accent-red-600"
            data-testid={`pack-switch-${pack}`}
          />
          <span className="text-xs text-redlog-text">{t('settings.packRecord')}</span>
        </label>
      )}
      <p className="text-xs text-redlog-text-faint">{hint}</p>
      {on && available !== false && children}
    </FieldGroup>
  )
}
