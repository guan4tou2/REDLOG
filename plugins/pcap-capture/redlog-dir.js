#!/usr/bin/env node
// Resolves the ~/.redlog directory of the operator who started the capture.
// Under `sudo` os.homedir() is root's home, where RedLog has written nothing,
// so the reader would find no port/token and drop every flow. This file only
// ever READS from the directory it returns.
//
// Order: sudo-invoking user's home (only while running as root and SUDO_USER is
// a plain username that the passwd database resolves to an absolute path),
// otherwise os.homedir(). SUDO_USER is an environment variable; it is never
// placed in a path or a command until it has matched USERNAME_RE, and the home
// that is used comes from the passwd database, not from the environment.
'use strict'

const fs = require('fs')
const os = require('os')
const path = require('path')
const { execFileSync } = require('child_process')

const USERNAME_RE = /^[a-z_][a-z0-9_.-]{0,31}$/i

// One /etc/passwd line is name:pw:uid:gid:gecos:home:shell. Exact name match.
function homeFromPasswd(text, user) {
  for (const line of String(text).split('\n')) {
    const f = line.split(':')
    if (f.length >= 6 && f[0] === user) return f[5]
  }
  return null
}

function lookupHome(user, platform) {
  if (platform === 'darwin') {
    // No shell: user is an argv element, and has already matched USERNAME_RE.
    const out = execFileSync('dscl', ['.', '-read', `/Users/${user}`, 'NFSHomeDirectory'],
      { encoding: 'utf8', timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'] })
    const m = /^NFSHomeDirectory:\s*(\S.*)$/m.exec(out)
    return m ? m[1].trim() : null
  }
  return homeFromPasswd(fs.readFileSync('/etc/passwd', 'utf8'), user)
}

/**
 * @param {{env?: Record<string,string|undefined>, uid?: number|null,
 *          homedir?: string, platform?: string,
 *          lookup?: (user: string) => string|null}} [o] injectable for tests
 */
function resolveRedlogDir(o = {}) {
  const env = o.env ?? process.env
  const uid = o.uid !== undefined ? o.uid : (typeof process.getuid === 'function' ? process.getuid() : null)
  const fallback = o.homedir ?? os.homedir()
  const platform = o.platform ?? process.platform
  const lookup = o.lookup ?? ((u) => lookupHome(u, platform))
  const sudoUser = env.SUDO_USER
  if (uid === 0 && sudoUser && sudoUser !== 'root' && USERNAME_RE.test(sudoUser)) {
    let home = null
    try { home = lookup(sudoUser) } catch { home = null }
    if (home && path.isAbsolute(home) && !/[\0\n\r]/.test(home)) return path.join(home, '.redlog')
  }
  return path.join(fallback, '.redlog')
}

module.exports = { resolveRedlogDir, homeFromPasswd, USERNAME_RE }

// `node redlog-dir.js` prints the directory, for the shell wrapper.
if (require.main === module) process.stdout.write(resolveRedlogDir() + '\n')
