import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

export default function setup() {
  if (process.platform !== 'win32' || !process.env.CI) return
  const child = spawn(process.execPath, [fileURLToPath(new URL('./helpers/stall-canary.mjs', import.meta.url))], { stdio: 'inherit' })
  child.on('error', error => console.error(`[canary] error ${error.message}`))
  return async () => {
    if (child.exitCode !== null || child.signalCode !== null) return
    await new Promise<void>(resolve => {
      child.once('exit', () => resolve())
      child.once('error', () => resolve())
      child.kill()
    })
  }
}
