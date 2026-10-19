import fs from 'node:fs'
import path from 'node:path'

// Whether RedLog looks for a newer version by itself at launch. Machine-wide,
// because the check happens before any project is open, and it is the one
// thing about updating the operator may want off. The default is on, so the
// switch is the existence of a file, as for the debug log: nothing to migrate
// and no config key to be absent. Air-gap still wins over this either way.

const FLAG = 'update-check-off'

export function isAutoCheckEnabled(dir: string): boolean {
  return !fs.existsSync(path.join(dir, FLAG))
}

export function setAutoCheckEnabled(dir: string, on: boolean): void {
  if (on) {
    fs.rmSync(path.join(dir, FLAG), { force: true })
  } else {
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, FLAG), '')
  }
}
