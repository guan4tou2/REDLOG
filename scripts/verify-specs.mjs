#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'

const root = process.cwd()
const specsRoot = path.join(root, 'specs')
const failures = []

const STATUSES = ['Draft', 'Implemented', 'Verified', 'Withdrawn']
// Constitution 1.1.0: verification.md follows the template from this spec on.
// 032 was verified before the template existed.
const TEMPLATE_FROM = 33
const GATES = ['Clarify', 'Checklist', 'Analyze', 'Converge']
// Verified before the verification record had a fixed shape. An entry that is
// no longer needed fails the gate, so this list can only shrink.
const KNOWN_GAPS = {
  '001-export-plan-consistency': ['red'],
  '002-scope-and-spool-isolation': ['red', 'plan'],
  '010-http-flow-query': ['red'],
  '011-loot-projection-completeness': ['red'],
  '021-personal-traffic-visibility': ['red'],
  '022-external-session-recorder': ['red'], // RED described in prose, under no heading
  '025-one-secret-pattern-table': ['red'] // RED described in prose, under no heading
}

const read = (file) => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null)

// The body of a `## heading` section, with template comments removed.
function section(text, heading) {
  const lines = text.split(/\r?\n/)
  const start = lines.findIndex((line) => new RegExp(`^##\\s+${heading}\\b`, 'i').test(line))
  if (start === -1) return ''
  const rest = lines.slice(start + 1)
  const end = rest.findIndex((line) => /^#{1,2}\s/.test(line))
  return (end === -1 ? rest : rest.slice(0, end)).join('\n').replace(/<!--[\s\S]*?-->/g, '').trim()
}

// Records written before the template name the RED phase three ways.
const hasRedRecord = (text) =>
  /^#{2,3}\s+(RED\b|test-first evidence\b)/im.test(text) || /^\s*[-*]\s+RED:/m.test(text)

const verifiedSpecs = new Set()

for (const name of fs.readdirSync(specsRoot).sort()) {
  const dir = path.join(specsRoot, name)
  if (!fs.statSync(dir).isDirectory()) continue
  const spec = read(path.join(dir, 'spec.md'))
  if (spec === null) {
    failures.push(`${name}: no spec.md`)
    continue
  }
  // An annotated or misspelt status used to exempt the spec from every check.
  const status = spec.match(/^\*\*Status\*\*:\s*(.*?)\s*$/m)?.[1]
  if (!STATUSES.includes(status)) {
    const found = status === undefined ? 'line missing' : `"${status}"`
    failures.push(`${name}: status ${found}; expected **Status**: ${STATUSES.join(' | ')}`)
    continue
  }
  if (status !== 'Verified') continue
  verifiedSpecs.add(name)

  const gaps = KNOWN_GAPS[name] ?? []
  const need = (gap, met, problem) => {
    if (!gaps.includes(gap)) {
      if (!met) failures.push(`${name}: ${problem}`)
    } else if (met) {
      failures.push(`${name}: no longer lacks "${gap}"; remove it from KNOWN_GAPS`)
    }
  }

  const tasks = read(path.join(dir, 'tasks.md'))
  if (tasks === null) failures.push(`${name}: Verified without tasks.md`)
  else if (/^\s*[-*] \[ \]/m.test(tasks)) failures.push(`${name}: Verified with unchecked tasks`)
  need('plan', fs.existsSync(path.join(dir, 'plan.md')), 'Verified without plan.md')

  const verification = read(path.join(dir, 'verification.md'))?.trim()
  if (!verification) {
    failures.push(`${name}: Verified without a verification.md record`)
    continue
  }
  need('red', hasRedRecord(verification), 'verification.md records no RED failure')

  if (parseInt(name, 10) >= TEMPLATE_FROM) {
    for (const heading of ['RED', 'GREEN']) {
      if (!section(verification, heading)) failures.push(`${name}: verification.md ## ${heading} is missing or empty`)
    }
    const gates = section(verification, 'Gates')
    for (const gate of GATES) {
      const result = gates.match(new RegExp(`^\\|\\s*${gate}\\b[^|]*\\|\\s*([^|]*?)\\s*\\|`, 'mi'))?.[1]
      if (!result) failures.push(`${name}: verification.md ## Gates has no result for ${gate}`)
    }
  }
}

for (const name of Object.keys(KNOWN_GAPS)) {
  if (!verifiedSpecs.has(name)) failures.push(`KNOWN_GAPS lists ${name}, which is not a Verified spec`)
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
console.log('Spec Kit gates passed: statuses are known, Verified specs carry complete tasks, a plan and a verification record, and executable aliases are current.')
