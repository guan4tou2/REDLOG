import { EventEmitter } from 'events'
import os from 'os'
import path from 'path'
import fs from 'fs'
import * as pty from 'node-pty'
import { insertEvent } from '../db/events'
import { eventBus } from '../services/event-bus'
import { getProjectDir } from '../db/index'
import { extractTarget, extractFileTransfer } from '../services/target-extractor'

interface TermSession {
  id: string
  pty: pty.IPty
  castFd: number
  startTime: number
  inputBuffer: string
}

export class TerminalManager extends EventEmitter {
  private sessions = new Map<string, TermSession>()
  private engagementId = 'default'
  private operatorId = 'operator-1'

  configure(opts: { engagementId?: string; operatorId?: string }): void {
    if (opts.engagementId) this.engagementId = opts.engagementId
    if (opts.operatorId) this.operatorId = opts.operatorId
  }

  create(cols: number, rows: number): string {
    const id = crypto.randomUUID()
    const shell = process.env.SHELL || (process.platform === 'win32' ? 'powershell.exe' : '/bin/zsh')

    const castDir = path.join(getProjectDir(), 'terminal')
    fs.mkdirSync(castDir, { recursive: true })
    const castPath = path.join(castDir, `session-${id.slice(0, 8)}.cast`)

    const header = JSON.stringify({
      version: 2,
      width: cols,
      height: rows,
      timestamp: Math.floor(Date.now() / 1000),
      env: { SHELL: shell, TERM: 'xterm-256color' }
    })
    fs.writeFileSync(castPath, header + '\n')
    const castFd = fs.openSync(castPath, 'a')

    const p = pty.spawn(shell, [], {
      name: 'xterm-256color',
      cols,
      rows,
      cwd: os.homedir(),
      env: { ...process.env, TERM: 'xterm-256color' }
    })

    const session: TermSession = { id, pty: p, castFd, startTime: Date.now(), inputBuffer: '' }
    this.sessions.set(id, session)

    p.onData((data) => {
      const offset = ((Date.now() - session.startTime) / 1000).toFixed(6)
      const line = JSON.stringify([parseFloat(offset), 'o', data])
      fs.writeSync(castFd, line + '\n')

      this.emit('data', id, data)
    })

    p.onExit(({ exitCode }) => {
      fs.closeSync(castFd)
      this.sessions.delete(id)

      try {
        insertEvent('terminal', {
          subtype: 'session_end',
          sessionTermId: id,
          exitCode,
          duration: Date.now() - session.startTime,
          castFile: castPath
        }, { engagementId: this.engagementId, operatorId: this.operatorId })
      } catch { /* DB may be closed during shutdown */ }

      this.emit('exit', id, exitCode)
    })

    const evt = insertEvent('terminal', {
      subtype: 'session_start',
      sessionTermId: id,
      shell,
      cols,
      rows,
      castFile: castPath
    }, { engagementId: this.engagementId, operatorId: this.operatorId })
    eventBus.publish(evt)

    return id
  }

  write(sessionId: string, data: string): void {
    const session = this.sessions.get(sessionId)
    if (!session) return

    session.pty.write(data)

    const offset = ((Date.now() - session.startTime) / 1000).toFixed(6)
    const line = JSON.stringify([parseFloat(offset), 'i', data])
    fs.writeSync(session.castFd, line + '\n')

    session.inputBuffer += data
    if (data.includes('\r') || data.includes('\n')) {
      const command = session.inputBuffer.trim()
      session.inputBuffer = ''
      if (command.length > 0 && command.length < 2000) {
        const target = extractTarget(command)
        const transfer = extractFileTransfer(command)
        const evt = insertEvent('terminal', {
          subtype: 'command',
          sessionTermId: sessionId,
          command,
          ...(target && { detectedTarget: target }),
          ...(transfer && { fileTransfer: transfer })
        }, {
          engagementId: this.engagementId,
          operatorId: this.operatorId,
          ...(target && { targetId: target })
        })
        eventBus.publish(evt)
        if (target) this.emit('target', target, command)
        if (transfer) this.emit('transfer', transfer, command)
      }
    }
  }

  resize(sessionId: string, cols: number, rows: number): void {
    this.sessions.get(sessionId)?.pty.resize(cols, rows)
  }

  destroy(sessionId: string): void {
    const session = this.sessions.get(sessionId)
    if (!session) return
    session.pty.kill()
  }

  destroyAll(): void {
    for (const [id] of this.sessions) {
      this.destroy(id)
    }
  }

  getSessionIds(): string[] {
    return [...this.sessions.keys()]
  }
}
