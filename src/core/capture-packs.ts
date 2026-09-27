// Capture packs (Spec 035). What RedLog records by default is built in —
// shell hooks, HTTP(S) through the managed proxy, redlog-session, the built-in
// terminal. Everything else is an optional pack: a group of sources the
// project turns on with one switch (`packs.<id>`), declared by a bundled
// plugin manifest so disabling that plugin removes the pack everywhere.
//
// The code of a pack's sources stays in core: plugins can only run external
// scripts or privileged tailers (Spec 027 removed the code host), and moving
// in-process services out would touch the evidence path for no isolation.

import type { LoadedPlugin } from './plugins/types'

export interface CapturePack {
  /** The bundled plugin that declares this pack. */
  pluginId: string
  /** Config sections of the sources the pack starts. */
  members: readonly string[]
}

export const CAPTURE_PACKS = {
  hostMonitors: {
    pluginId: 'pack-host-monitors',
    members: ['processMonitor', 'connectionMonitor', 'fileWatcher', 'clipboard']
  },
  aiAgents: {
    pluginId: 'pack-ai-agents',
    members: ['agentTailer']
  },
  windowsOutput: {
    pluginId: 'pack-windows-output',
    members: ['powershellTranscript']
  }
} as const satisfies Record<string, CapturePack>

export type CapturePackId = keyof typeof CAPTURE_PACKS

/** Whether a pack's plugin is installed and active. */
export function isPackAvailable(id: CapturePackId, plugins: readonly LoadedPlugin[]): boolean {
  const pluginId = CAPTURE_PACKS[id].pluginId
  return plugins.some((p) => p.manifest.id === pluginId && p.source === 'bundled' && p.status === 'active')
}

/** A pack runs only when the project turns it on AND its plugin is active. */
export function isPackOn(
  config: { packs?: Partial<Record<CapturePackId, boolean>> },
  id: CapturePackId,
  plugins: readonly LoadedPlugin[]
): boolean {
  return config.packs?.[id] === true && isPackAvailable(id, plugins)
}

/** The member config keys of every pack, flat. Members are unique across
 *  packs, so `packMembers` needs no nesting and a member's key is the whole
 *  address of its switch. */
export type PackMemberId = (typeof CAPTURE_PACKS)[CapturePackId]['members'][number]

export interface PackConfig {
  packs?: Partial<Record<CapturePackId, boolean>>
  packMembers?: Partial<Record<PackMemberId, boolean>>
}

/** Which pack a member belongs to. */
export function packOfMember(member: PackMemberId): CapturePackId {
  const found = (Object.keys(CAPTURE_PACKS) as CapturePackId[])
    .find((id) => (CAPTURE_PACKS[id].members as readonly string[]).includes(member))
  // Unreachable through the type, but a plain throw beats a silent `undefined`
  // flowing into a capture decision.
  if (!found) throw new Error(`no pack declares member ${member}`)
  return found
}

/** Members that never ride along with their pack (#224). The clipboard
 *  samples whatever the operator copies anywhere on the machine, for as long
 *  as the project is open — on a shared or personal laptop, material that was
 *  never in scope. Turning on "host monitors" to watch processes and
 *  connections must not also start collecting that. It runs only when the
 *  operator has ticked it themselves. */
export const OPT_IN_MEMBERS: ReadonlySet<PackMemberId> = new Set<PackMemberId>(['clipboard'])

/** Whether the operator's member switches select this member. An unset
 *  switch follows the member's default: on for an ordinary member, so the
 *  pack stays a preset; off for an opt-in one, which needs an explicit yes.
 *  No migration: a project that never ticked the clipboard stops sampling it,
 *  and one that did keeps it. */
export function isMemberSelected(
  packMembers: PackConfig['packMembers'],
  member: PackMemberId
): boolean {
  const v = packMembers?.[member]
  return OPT_IN_MEMBERS.has(member) ? v === true : v !== false
}

/** A member runs when its pack runs and the operator's switches select it.
 *
 *  A pack is a preset, not an atom. "Host monitors" bundles four sources and
 *  the clipboard is not like the other three. All-or-nothing turned "I want
 *  process and connection monitoring but not my clipboard" into "then have
 *  neither" — and an operator who wanted the three took the fourth without
 *  deciding to. */
export function isPackMemberOn(
  config: PackConfig,
  member: PackMemberId,
  plugins: readonly LoadedPlugin[]
): boolean {
  if (!isMemberSelected(config.packMembers, member)) return false
  return isPackOn(config, packOfMember(member), plugins)
}
