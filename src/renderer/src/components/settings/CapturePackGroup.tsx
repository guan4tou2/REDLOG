import { useState, type ReactNode } from 'react'
import { useRevalidateOnFocus } from '../../hooks/useRevalidateOnFocus'
import { useReadState } from '../../lib/readState'
import { Button } from '../Button'
import { FieldGroup, type ConfigState } from './SettingsShared'
import { SourceLastSeen } from './SourceLastSeen'
import { CheckRow } from './CheckRow'
import { isMemberSelected, OPT_IN_MEMBERS } from '../../../../core/capture-packs'

// One optional capture pack (Spec 035): a single switch for the project, and
// its members' tuning beneath while it is on. A pack whose bundled plugin was
// disabled in Plugins is removed — said so here instead of offering a switch
// that would record nothing.

export type PackId = 'hostMonitors' | 'windowsOutput'

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
  member, title, hint, warn, config, setConfig, t, health, packOn, children
}: {
  member: PackMemberId
  title: string
  hint: string
  /** Shown in amber under the hint: what turning this one on costs. */
  warn?: string
  /** The health row for this member, when the snapshot has one. */
  health?: CaptureSourceInfo
  /** Whether the member's own pack is on. A member under a pack that is off
   *  is not delivering, whatever its own switch says. */
  packOn?: boolean
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
      <CheckRow
        checked={on}
        onChange={(next) => setConfig({
          ...config,
          packMembers: { ...config.packMembers, [member]: next }
        })}
        inputTestId={`pack-member-${member}`}
        label={t('settings.packMemberRecord')}
      />
      {optIn && !on && (
        <p className="text-xs text-redlog-text-faint" data-testid={`pack-member-optin-${member}`}>{t('settings.packMemberOptIn')}</p>
      )}
      <p className="text-xs text-redlog-text-faint">{hint}</p>
      {/* When it last delivered. The switch says what was asked for; this says
          what arrived — the two are different questions and only one of them
          was answerable from this row before. */}
      <SourceLastSeen source={health} active={on && (packOn ?? true)} t={t} />
      {warn && <p className="text-xs text-amber-500/80">{warn}</p>}
      {/* Tuning for a member that is off would be controls for something that
          is not running — the same lie the pack switch avoids above. */}
      {on && children}
    </div>
  )
}

const PLUGIN_OF: Record<PackId, string> = {
  hostMonitors: 'pack-host-monitors',
  windowsOutput: 'pack-windows-output'
}

export default function CapturePackGroup({
  pack, title, hint, config, setConfig, t, onOpenPlugins, children
}: {
  pack: PackId
  title: string
  hint: string
  config: ConfigState
  setConfig: (c: ConfigState) => void
  t: (key: string, vars?: Record<string, string | number>) => string
  /** Where the pack's plugin is managed. The row that says the pack is
   *  disabled offers the way back instead of describing the way there. */
  onOpenPlugins?: () => void
  /** Member tuning, shown while the pack is on. */
  children?: ReactNode
}): JSX.Element {
  const read = useReadState(async () => {
    const list = await window.redlog.plugins.list()
    if (!Array.isArray(list) || list.some(p => !p || typeof p !== 'object' || !('id' in p) || !('status' in p) || !('source' in p))) throw new Error('invalid-plugin-list')
    return list as Array<{ id: string; source: string; status: string }>
  })
  useRevalidateOnFocus(read.retry)
  const plugin = read.state.value?.find(p => p.id === PLUGIN_OF[pack] && p.source === 'bundled')
  const available = read.state.phase === 'loaded' && plugin?.status === 'active'
  const [busy, setBusy] = useState(false)
  const [repairError, setRepairError] = useState<string | null>(null)
  const repair = async (): Promise<void> => {
    setBusy(true); setRepairError(null)
    try { await window.redlog.plugins.setEnabled(PLUGIN_OF[pack], true); read.retry() }
    catch (e) { setRepairError(e instanceof Error ? e.message : String(e)) }
    finally { setBusy(false) }
  }
  const on = config.packs?.[pack] === true
  return (
    <FieldGroup title={title}>
      {read.state.phase === 'loading' ? <p role="status" className="text-xs">{t('common.loading')}</p>
        : read.state.phase === 'failed' ? <div role="alert" className="text-xs space-y-2">
          <p>{t('settings.packReadFailed')}</p><p className="break-words">{read.state.error}</p>
          <Button level="quiet" onClick={read.retry}>{t('common.retry')}</Button>
        </div> : !available ? (
        <div className="space-y-1">
          <p className="text-xs text-amber-500/80" data-testid={`pack-removed-${pack}`}>{t(plugin?.status === 'disabled' ? 'settings.packRemoved' : 'settings.packUnavailable')}</p>
          {plugin?.status === 'disabled' && <Button level="secondary" disabled={busy} data-testid={`pack-repair-${pack}`} onClick={() => void repair()}>{t('settings.sourceRestore')}</Button>}
          {onOpenPlugins && (
            <button type="button" data-testid={`pack-open-plugins-${pack}`} onClick={onOpenPlugins} className="text-xs text-redlog-text-dim underline">
              {t('settings.openPlugins')}
            </button>
          )}
        </div>
      ) : (
        <CheckRow
          checked={on}
          onChange={(next) => setConfig({ ...config, packs: { ...config.packs, [pack]: next } })}
          inputTestId={`pack-switch-${pack}`}
          label={t('settings.packRecord')}
        />
      )}
      {repairError && <p role="alert" className="text-xs text-red-400 break-words">{repairError}</p>}
      <p className="text-xs text-redlog-text-faint">{hint}</p>
      {on && available && children}
    </FieldGroup>
  )
}
