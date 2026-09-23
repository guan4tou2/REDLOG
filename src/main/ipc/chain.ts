import type { IpcMain } from 'electron'
import type { IpcContext } from './types'
import { getChainLength } from '../../core/evidence-chain'
import {
  anchorNow, listAnchors, verifyLatestAnchor,
  verifyChainFullAsync, upgradeAnchor, upgradeAllPending
} from '../../core/chain-anchor'

export function registerChainIpc(ipcMain: IpcMain, ctx: IpcContext): void {
  ipcMain.handle('chain:length', () =>
    ctx.getActiveProject() ? getChainLength() : 0)

  ipcMain.handle('chain:anchors', () =>
    ctx.getActiveProject() ? listAnchors() : [])

  ipcMain.handle('chain:anchorNow', async () =>
    ctx.getActiveProject() ? await anchorNow() : null)

  ipcMain.handle('chain:verify', async (_e, opts?: { full?: boolean }) => {
    if (!ctx.getActiveProject()) return { ok: false, anchor: null, currentHead: null }
    return opts?.full ? await verifyChainFullAsync() : verifyLatestAnchor()
  })

  ipcMain.handle('chain:upgrade', async (_e, id?: string) => {
    if (!ctx.getActiveProject()) return null
    if (id) return await upgradeAnchor(id)
    return await upgradeAllPending()
  })
}
