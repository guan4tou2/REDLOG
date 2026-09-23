#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'

const roots = [
  'dist/mac-arm64/RedLog.app/Contents/Resources',
  'dist/mac/RedLog.app/Contents/Resources',
  'dist/win-unpacked/resources',
  'dist/linux-unpacked/resources'
]
const root = roots.map((p) => path.resolve(p)).find((p) => fs.existsSync(p))
if (!root) throw new Error(`No unpacked package resources found under dist/ (${roots.join(', ')})`)

const required = [
  'hooks/shell-bash-hook.sh',
  'hooks/shell-zsh-hook.zsh',
  'hooks/shell-hook.ps1',
  'hooks/shell-common.sh',
  'hooks/redlog-session.py',
  'plugins/starter-pack/plugin.json'
]
const forbidden = [
  'hooks/shell-preexec-hook.sh',
  'hooks/redlog-hook.zsh',
  'hooks/claude-code-hook.sh',
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

console.log(`Packaged resource contract verified: ${root}`)
