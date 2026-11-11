import type { IpcMain } from 'electron'
import type { IpcContext } from './types'
import { getChainLength } from '../../core/evidence-chain'
import {
  anchorNow, listAnchors,
  verifyChainFullAsync, upgradeAnchor, upgradeAllPending
} from '../../core/chain-anchor'

export function registerChainIpc(ipcMain: IpcMain, ctx: IpcContext): void {
  ipcMain.handle('chain:length', () =>
    ctx.getActiveProject() ? getChainLength() : 0)

  ipcMain.handle('chain:anchors', () =>
    ctx.getActiveProject() ? listAnchors() : [])

  // An anchor, null (nothing to anchor), or air-gap's `{ skipped: 'offline' }`,
  // which the renderer shows as neither an error nor a success.
  ipcMain.handle('chain:anchorNow', async () => {
    if (!ctx.getActiveProject()) return null
    return await anchorNow()
  })

  // The walk also checks the latest anchor, so the app has one verify. The
  // anchor-only check stays on the local API and the CLI, where it is cheap.
  ipcMain.handle('chain:verify', async () => {
    if (!ctx.getActiveProject()) return { ok: false, anchor: null, currentHead: null }
    return await verifyChainFullAsync()
  })

  ipcMain.handle('chain:upgrade', async (_e, id?: string) => {
    if (!ctx.getActiveProject()) return null
    if (id) return await upgradeAnchor(id)
    return await upgradeAllPending()
  })
}
