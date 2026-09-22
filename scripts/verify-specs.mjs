#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'

const root = process.cwd()
const specsRoot = path.join(root, 'specs')
const failures = []

for (const name of fs.readdirSync(specsRoot).sort()) {
  const dir = path.join(specsRoot, name)
  const specFile = path.join(dir, 'spec.md')
  if (!fs.statSync(dir).isDirectory() || !fs.existsSync(specFile)) continue
  const spec = fs.readFileSync(specFile, 'utf8')
  if (!/^\*\*Status\*\*:\s*Verified\s*$/m.test(spec)) continue
  const tasksFile = path.join(dir, 'tasks.md')
  const verificationFile = path.join(dir, 'verification.md')
  if (!fs.existsSync(tasksFile)) failures.push(`${name}: Verified without tasks.md`)
  else if (/^- \[ \]/m.test(fs.readFileSync(tasksFile, 'utf8'))) failures.push(`${name}: Verified with unchecked tasks`)
  if (!fs.existsSync(verificationFile)) failures.push(`${name}: Verified without verification.md`)
}

const executableRoots = ['README.md', 'electron-builder.yml', 'package.json', 'src', 'hooks', 'plugins', 'cli', '.github']
const forbidden = ['shell-preexec-hook.sh', 'redlog-hook.zsh', 'claude-code-hook.sh']
const textExtensions = new Set(['.md', '.yml', '.yaml', '.json', '.ts', '.tsx', '.js', '.mjs', '.sh', '.zsh', '.ps1'])

function visit(candidate) {
  if (!fs.existsSync(candidate)) return
  const stat = fs.statSync(candidate)
  if (stat.isDirectory()) {
    for (const child of fs.readdirSync(candidate)) visit(path.join(candidate, child))
    return
  }
  if (!textExtensions.has(path.extname(candidate))) return
  const text = fs.readFileSync(candidate, 'utf8')
  for (const alias of forbidden) {
    if (text.includes(alias)) failures.push(`${path.relative(root, candidate)}: removed compatibility entry ${alias}`)
  }
}
for (const entry of executableRoots) visit(path.join(root, entry))

if (failures.length) {
  console.error(failures.join('\n'))
  process.exit(1)
}
console.log('Spec Kit gates passed: Verified tasks are complete and executable aliases are current.')
