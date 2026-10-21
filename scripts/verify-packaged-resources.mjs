#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

const roots = [
  'dist/mac-arm64/RedLog.app/Contents/Resources',
  'dist/mac/RedLog.app/Contents/Resources',
  'dist/win-unpacked/resources',
  'dist/linux-unpacked/resources',
  'dist/linux-arm64-unpacked/resources'
]
const root = roots.map((p) => path.resolve(p)).find((p) => fs.existsSync(p))
if (!root) throw new Error(`No unpacked package resources found under dist/ (${roots.join(', ')})`)

const required = [
  'hooks/shell-bash-hook.sh',
  'hooks/shell-zsh-hook.zsh',
  'hooks/shell-hook.ps1',
  'hooks/shell-common.sh',
  'hooks/redlog-session.py',
  // The output relay every POSIX adapter calls. Missing, `redlog-run` falls
  // through to running the command unrecorded — a degradation quiet enough
  // that only a packaged build would show it.
  'hooks/redlog-relay.py',
  // The class policy both readers share. Missing, the relay cannot classify
  // and every command falls back to `native` — the adapter stops capturing
  // output with no error anywhere.
  'hooks/command-class.json',
  // Copied into every evidence bundle; an export refuses to run without it.
  'tools/redlog-verify.py',
  'plugins/starter-pack/plugin.json',
  // Spec 035: a capture pack whose manifest is missing does not run.
  'plugins/pack-host-monitors/plugin.json',
  'plugins/pack-windows-output/plugin.json'
]
const forbidden = [
  'hooks/shell-preexec-hook.sh',
  'hooks/redlog-hook.zsh',
  'hooks/claude-code-hook.sh',
  'plugins/pack-ai-agents',
  // The plugin code host was removed in Spec 027; its child script must not ship.
  'plugin-runner.js'
]

const missing = required.filter((item) => !fs.existsSync(path.join(root, item)))
const legacy = forbidden.filter((item) => fs.existsSync(path.join(root, item)))
if (missing.length || legacy.length) {
  if (missing.length) console.error(`Missing packaged resources: ${missing.join(', ')}`)
  if (legacy.length) console.error(`Removed resources still packaged: ${legacy.join(', ')}`)
  process.exit(1)
}

if (process.platform === 'darwin' && root.endsWith('/Contents/Resources')) {
  // A launch from an unquarantined build folder also works with Electron's
  // stale linker signature. Verify the final bundle seal, including native
  // helpers, before treating it as an installable macOS candidate.
  const app = path.dirname(path.dirname(root))
  const signed = spawnSync('/usr/bin/codesign', ['--verify', '--deep', '--strict', app], { encoding: 'utf8' })
  if (signed.error || signed.status !== 0) {
    console.error(`Invalid macOS bundle signature: ${signed.error?.message ?? signed.stderr.trim()}`)
    process.exit(1)
  }
}

console.log(`Packaged resource contract verified: ${root}`)
