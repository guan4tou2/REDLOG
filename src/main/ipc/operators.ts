import type { IpcMain } from 'electron'
import path from 'path'
import { homedir } from 'os'
import fs from 'fs'
import type { IpcContext } from './types'
import { loadConfig } from '../../core/config'
import { getProjectDir as getProjectPath } from '../../core/project-manager'
import {
  listOperators, createOperator, updateOperatorToken, revokeOperator, renameOperator,
  generateToken, slugifyOperatorId, getOperatorSignerPubKey
} from '../../core/db/operators'

// §5c operator management. Tokens are written to ~/.redlog/tokens/<id>.token
// (0600, outside the project tree so no export sweeps them up — §10), never
// returned to the renderer to copy; the caller reveals the file via
// data:revealPath. create/rotateToken return the token file PATH, not the token.
function writeOperatorToken(id: string, token: string): string {
  const dir = path.join(homedir(), '.redlog', 'tokens')
  fs.mkdirSync(dir, { recursive: true })
  const p = path.join(dir, `${id}.token`)
  fs.writeFileSync(p, token, { mode: 0o600 })
  try { fs.chmodSync(p, 0o600) } catch { /* platforms without POSIX modes */ }
  return p
}

export function registerOperatorsIpc(ipcMain: IpcMain, ctx: IpcContext): void {
  ipcMain.handle('operators:list', () => {
    if (!ctx.getActiveProject()) return []
    return listOperators().map((op) => ({
      id: op.id, name: op.name, isPrimary: op.isPrimary,
      createdAt: op.createdAt, revokedAt: op.revokedAt,
      signerPubKey: op.signerPubKey  // ed25519 public key, for §5c key display
    }))
  })

  ipcMain.handle('operators:create', (_e, opts: { name: string }) => {
    if (!ctx.getActiveProject()) return null
    const name = String(opts?.name ?? '').trim()
    if (!name) return null
    const id = slugifyOperatorId(name)
    try {
      const token = generateToken()
      const op = createOperator({ id, name, token })
      return { id: op.id, name: op.name, signerPubKey: op.signerPubKey, tokenPath: writeOperatorToken(id, token) }
    } catch {
      // slugifyOperatorId appends a random suffix so id collisions are
      // effectively impossible; this is a defensive backstop (DB write failed).
      return { error: 'create_failed', id }
    }
  })
  ipcMain.handle('operators:rotateToken', (_e, id: string) => {
    if (!ctx.getActiveProject() || typeof id !== 'string' || !id) return null
    const token = generateToken()
    if (!updateOperatorToken(id, token)) return null
    return { id, tokenPath: writeOperatorToken(id, token) }
  })
  ipcMain.handle('operators:revoke', (_e, id: string) =>
    ctx.getActiveProject() && typeof id === 'string' ? revokeOperator(id) : false)
  ipcMain.handle('operators:rename', (_e, id: string, name: string) =>
    ctx.getActiveProject() && typeof id === 'string' && typeof name === 'string' ? renameOperator(id, name.trim()) : false)
  ipcMain.handle('operators:pubKey', (_e, id: string) =>
    ctx.getActiveProject() && typeof id === 'string' ? getOperatorSignerPubKey(id) : null)
}
