// The API token can read every event, export the evidence bundle, sanitise
// recorded output and switch recording. Until per-producer append-only
// credentials exist (Spec 071), it must not leave this machine, so nothing
// RedLog ships — hook scripts, CLI, plugins, UI text, docs — may tell an
// operator to copy it to another host. `hooks/vps-deploy.sh` did, and was
// removed.
//
// The heuristic is text-based and line-based: a line that names the token
// file or a token variable together with a remote-copy tool is a violation,
// and so is any mention of REDLOG_REMOTE_TOKEN, whose only use was carrying
// the token to a remote host. History (docs/records, docs/archive, CHANGELOG)
// and specs are not shipped and are not scanned. A copy split over several
// lines, or through an alias, is not seen.
import { describe, expect, it } from 'vitest'
import fs from 'fs'
import path from 'path'
import glob from 'fast-glob'
import { repoRelative } from './helpers/repo-path'

const ROOT = path.join(__dirname, '..')

const SHIPPED = [
  'hooks/**/*', 'shell/**/*', 'cli/**/*', 'plugins/**/*', 'optional-plugins/**/*', 'tools/**/*',
  'src/renderer/src/i18n/*.json', 'README.md', 'docs/**/*.md'
]
const NOT_SHIPPED = ['docs/records/**', 'docs/archive/**', '**/node_modules/**', '**/__pycache__/**', '**/*.pyc']

const TOKEN = /api-token|REDLOG_TOKEN|LOCAL_TOKEN|\$TOKEN\b|Bearer/
const REMOTE_COPY = /\b(ssh|scp|rsync|sftp)\b/
const REMOTE_TOKEN_VAR = /REDLOG_REMOTE_TOKEN/

function copiesTokenOffMachine(line: string): boolean {
  return REMOTE_TOKEN_VAR.test(line) || (TOKEN.test(line) && REMOTE_COPY.test(line))
}

describe('the API token stays on this machine', () => {
  it('recognises the lines the removed VPS deploy used', () => {
    expect(copiesTokenOffMachine('    echo "$LOCAL_TOKEN" | ssh -p "$SSH_PORT" "$TARGET" "cat > ~/.redlog/api-token && chmod 600 ~/.redlog/api-token"')).toBe(true)
    expect(copiesTokenOffMachine('    REDLOG_REMOTE_TOKEN="$(cat ~/.redlog/api-token)" hooks/vps-deploy.sh install user@vps')).toBe(true)
    expect(copiesTokenOffMachine('scp ~/.redlog/api-token op@jump:.redlog/')).toBe(true)
    // Reading the token locally, and ssh on its own, are fine.
    expect(copiesTokenOffMachine('header = "Authorization: Bearer $(cat ~/.redlog/api-token)"')).toBe(false)
    expect(copiesTokenOffMachine('auto-detects ligolo-ng / chisel / `ssh -D/-L/-R` / sshuttle')).toBe(false)
  })

  it('no shipped script, UI string or doc tells an operator to copy it to another host', () => {
    const files = glob.sync(SHIPPED, { cwd: ROOT, ignore: NOT_SHIPPED, onlyFiles: true, dot: false })
    expect(files.length, 'nothing was scanned').toBeGreaterThan(20)
    const hits: string[] = []
    for (const rel of files) {
      const text = fs.readFileSync(path.join(ROOT, rel), 'utf8')
      if (text.includes('\u0000')) continue  // binary
      text.split('\n').forEach((line, i) => {
        if (copiesTokenOffMachine(line)) hits.push(`${repoRelative(ROOT, path.join(ROOT, rel))}:${i + 1}: ${line.trim().slice(0, 160)}`)
      })
    }
    expect(hits, hits.join('\n')).toEqual([])
  })
})
