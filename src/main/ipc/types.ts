import type { BrowserWindow } from 'electron'
import type { ProjectMeta } from '../../core/project-manager'

/**
 * Shared context passed to extracted IPC handler modules.
 *
 * Carries the mutable state that lives in index.ts's module scope so each
 * handler group can read/write it without importing the file directly.
 * Pure functions (loadConfig, getProjectPath, …) are imported directly by each
 * module — only the things that change at runtime go here.
 */
export interface IpcContext {
  getActiveProject: () => ProjectMeta | null
  getMainWindow: () => BrowserWindow | null
  getOverlayWindow: () => BrowserWindow | null
  getCurrentEngagementId: () => string | null
  getCurrentOperatorId: () => string | null
  /** Safe send that ignores destroyed windows. */
  send: (win: BrowserWindow | null, channel: string, ...payload: unknown[]) => void
  /** Opens the marker dialog in the main window. */
  triggerBookmark: () => void
  /** Drops an instant HUD mark into the chain. */
  triggerInstantMark: () => { ok: boolean; id?: string }
}
