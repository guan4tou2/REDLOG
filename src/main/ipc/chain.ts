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

  ipcMain.handle('chain:anchorNow', async () =>
    ctx.getActiveProject() ? await anchorNow() : null)

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
