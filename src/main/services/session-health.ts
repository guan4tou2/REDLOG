import { BrowserWindow } from 'electron'

interface SessionHealthConfig {
  breakReminderMinutes: number
  fatigueYellowMinutes: number
  fatigueRedMinutes: number
}

export type FatigueLevel = 'green' | 'yellow' | 'red'

export interface HealthStatus {
  sessionMinutes: number
  fatigueLevel: FatigueLevel
  lastBreakMinutesAgo: number
  breaksDue: boolean
}

export class SessionHealthMonitor {
  private config: SessionHealthConfig = {
    breakReminderMinutes: 240,
    fatigueYellowMinutes: 180,
    fatigueRedMinutes: 360
  }
  private sessionStart = Date.now()
  private lastBreak = Date.now()
  private interval: ReturnType<typeof setInterval> | null = null
  private mainWindow: BrowserWindow | null = null

  configure(config: SessionHealthConfig, mainWindow: BrowserWindow | null): void {
    this.config = config
    this.mainWindow = mainWindow
  }

  start(): void {
    this.sessionStart = Date.now()
    this.lastBreak = Date.now()
    this.interval = setInterval(() => this.check(), 60_000)
  }

  stop(): void {
    if (this.interval) {
      clearInterval(this.interval)
      this.interval = null
    }
  }

  recordBreak(): void {
    this.lastBreak = Date.now()
  }

  getStatus(): HealthStatus {
    const now = Date.now()
    const sessionMinutes = Math.floor((now - this.sessionStart) / 60_000)
    const lastBreakMinutesAgo = Math.floor((now - this.lastBreak) / 60_000)

    let fatigueLevel: FatigueLevel = 'green'
    if (sessionMinutes >= this.config.fatigueRedMinutes) {
      fatigueLevel = 'red'
    } else if (sessionMinutes >= this.config.fatigueYellowMinutes) {
      fatigueLevel = 'yellow'
    }

    return {
      sessionMinutes,
      fatigueLevel,
      lastBreakMinutesAgo,
      breaksDue: lastBreakMinutesAgo >= this.config.breakReminderMinutes
    }
  }

  private check(): void {
    const status = this.getStatus()
    if (status.breaksDue && this.mainWindow && !this.mainWindow.isDestroyed()) {
      this.mainWindow.webContents.send('session-health:break-reminder', status)
    }
    if (status.fatigueLevel !== 'green' && this.mainWindow && !this.mainWindow.isDestroyed()) {
      this.mainWindow.webContents.send('session-health:fatigue', status)
    }
  }
}
