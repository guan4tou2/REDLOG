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
