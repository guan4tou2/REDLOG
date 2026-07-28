import dgram from 'dgram'

let cachedOffsetMs: number | null = null
let lastQueryAt = 0
let queryTimer: ReturnType<typeof setInterval> | null = null

const NTP_SERVER = process.env.REDLOG_NTP_SERVER || 'pool.ntp.org'
const NTP_TIMEOUT_MS = 4000

export function monotonicNs(): string {
  return process.hrtime.bigint().toString()
}

export function getNtpOffsetMs(): number | null {
  return cachedOffsetMs
}

export function getLastNtpQuery(): number {
  return lastQueryAt
}

export function queryNtp(server: string = NTP_SERVER): Promise<number> {
  return new Promise((resolve, reject) => {
    const socket = dgram.createSocket('udp4')
    const packet = Buffer.alloc(48)
    packet[0] = 0x1b // LI=0, VN=3, Mode=3 (client)

    let done = false
    const finish = (err: Error | null, offsetMs?: number): void => {
      if (done) return
      done = true
      try { socket.close() } catch { /* */ }
      if (err) reject(err)
      else resolve(offsetMs ?? 0)
    }

    const timer = setTimeout(() => finish(new Error('NTP timeout')), NTP_TIMEOUT_MS)

    socket.on('message', (msg) => {
      clearTimeout(timer)
      const t4 = Date.now()

      // Transmit Timestamp: bytes 40-47 — seconds since 1900-01-01
      const secs = msg.readUInt32BE(40)
      const frac = msg.readUInt32BE(44)
      const NTP_EPOCH_OFFSET = 2208988800 // seconds between 1900 and 1970
      const serverMs = (secs - NTP_EPOCH_OFFSET) * 1000 + Math.floor((frac / 0xffffffff) * 1000)

      const offset = serverMs - t4
      finish(null, offset)
    })

    socket.on('error', (err) => {
      clearTimeout(timer)
      finish(err)
    })

    socket.send(packet, 123, server, (err) => {
      if (err) {
        clearTimeout(timer)
        finish(err)
      }
    })
  })
}

async function tick(): Promise<void> {
  try {
    const offset = await queryNtp()
    cachedOffsetMs = Math.round(offset)
    lastQueryAt = Date.now()
  } catch {
    // keep previous cached value; leave null on first failure
  }
}

export function startNtpLoop(intervalMs = 5 * 60 * 1000): void {
  stopNtpLoop()
  queryTimer = setInterval(tick, intervalMs)
  setTimeout(tick, 5_000)
}

export function stopNtpLoop(): void {
  if (queryTimer) {
    clearInterval(queryTimer)
    queryTimer = null
  }
}
