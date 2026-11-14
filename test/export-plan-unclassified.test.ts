import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { closeDB, getDB, initDB } from '../src/core/db/index'
import { closeHttpBodyIndex } from '../src/core/http-body-index'
import { buildExportPlan } from '../src/core/export-planning'
import type { ExportRequest } from '../src/core/export-plan'
import { addExportEvent } from './helpers/export-fixtures'

// A command with no detected target has its output replaced on export when a
// scope with targets is set (scope-sanitize `isUnclassifiedScope`). The preview
// used to count only out-of-scope rows, so these outputs went without a number.
let dir: string

function project(scope: { targets: string[]; excludeTargets?: string[] }): void {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'redlog-plan-unclassified-'))
  initDB(dir)
  const lines = ['engagement:', '  id: eng-1', 'scope:', '  targets:', ...scope.targets.map(t => `    - ${t}`)]
  if (scope.targets.length === 0) lines[lines.length - 1] = '  targets: []'
  if (scope.excludeTargets?.length) lines.push('  excludeTargets:', ...scope.excludeTargets.map(t => `    - ${t}`))
  fs.writeFileSync(path.join(dir, 'config.yaml'), lines.join('\n'))
  getDB().transaction(() => {
    // (a) a command that names no target, with output
    addExportEvent('events', 'a-targetless', 1000, { targetId: null, data: { command: 'cat /etc/passwd | grep root', stdout: 'root:x:0:0\n' } })
    // (b) a row with no target and nothing a scope mask would touch
    addExportEvent('events', 'b-bare', 1001, { targetId: null, agentType: 'system', subtype: 'recording_paused', data: {} })
    // (c) an in-scope command
    addExportEvent('events', 'c-in', 1002, { targetId: 'app.acme.test', data: { command: 'curl app.acme.test', stdout: 'ok' } })
    // (d) an out-of-scope command
    addExportEvent('events', 'd-out', 1003, { targetId: 'other.test', data: { command: 'curl other.test', stdout: 'secret' } })
  })()
}

const plan = (request: ExportRequest) =>
  buildExportPlan({ id: 'eng-1', name: 'p', path: dir, createdAt: 1, lastOpened: 1 } as never, request)

afterEach(() => { closeDB(); closeHttpBodyIndex(); fs.rmSync(dir, { recursive: true, force: true }) })

describe('the plan counts what the no-target rule masked', () => {
  describe('with scope targets', () => {
    beforeEach(() => project({ targets: ['app.acme.test', '10.20.0.0/24'] }))

    it('counts the targetless command whose output was replaced, not the bare row', () => {
      const { counts } = plan({ format: 'json', maskOutOfScope: true })
      expect(counts.maskedUnclassified).toBe(1)
      expect(counts.maskedOutOfScope).toBe(1)
      // a and d had their stdout replaced; b and c are delivered as recorded
      expect(counts.sanitized).toBe(2)
    })

    it('is absent when masking is off', () => {
      const { counts } = plan({ format: 'json', maskOutOfScope: false })
      expect('maskedUnclassified' in counts).toBe(false)
      expect(counts.maskedOutOfScope).toBe(0)
      expect(counts.sanitized).toBe(0)
    })

    it('a bundle counts the same', () => {
      expect(plan({ format: 'bundle', maskOutOfScope: true }).counts.maskedUnclassified).toBe(1)
    })

    it('HAR, which carries no commands, has nothing of the kind to count', () => {
      expect('maskedUnclassified' in plan({ format: 'har' }).counts).toBe(false)
    })
  })

  it('is absent when the scope has no targets: nothing is unclassified', () => {
    project({ targets: [], excludeTargets: ['other.test'] })
    const { counts } = plan({ format: 'json', maskOutOfScope: true })
    expect('maskedUnclassified' in counts).toBe(false)
    expect(counts.maskedOutOfScope).toBe(1)
  })

  it('is absent when no scope is set at all', () => {
    project({ targets: [] })
    expect('maskedUnclassified' in plan({ format: 'json', maskOutOfScope: true }).counts).toBe(false)
  })
})
