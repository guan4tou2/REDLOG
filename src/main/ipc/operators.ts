import type { IpcMain } from 'electron'
import type { IpcContext } from './types'
import { listOperators } from '../../core/db/operators'

// Read-only on purpose: no UI creates, rotates, revokes or renames an
// operator, and a renderer-reachable channel that mints API tokens with no UI
// behind it is attack surface, not a feature.
export function registerOperatorsIpc(ipcMain: IpcMain, ctx: IpcContext): void {
  ipcMain.handle('operators:list', () => {
    if (!ctx.getActiveProject()) return []
    return listOperators().map((op) => ({
      id: op.id, name: op.name, isPrimary: op.isPrimary,
      createdAt: op.createdAt, revokedAt: op.revokedAt,
      signerPubKey: op.signerPubKey  // ed25519 public key, for §5c key display
    }))
  })
}
