import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { resolveEvidenceFile } from '../src/core/evidence-file'

describe('resolving an evidence file the renderer names', () => {
  let project: string
  let outside: string

  beforeEach(() => {
    project = fs.mkdtempSync(path.join(os.tmpdir(), 'redlog-evfile-'))
    outside = fs.mkdtempSync(path.join(os.tmpdir(), 'redlog-evfile-out-'))
    fs.mkdirSync(path.join(project, 'artifacts'))
    fs.mkdirSync(path.join(project, 'screenshots'))
    fs.writeFileSync(path.join(project, 'artifacts', 'abc123-report.xml'), 'x')
    fs.writeFileSync(path.join(project, 'screenshots', '1_manual.jpg'), 'x')
    fs.writeFileSync(path.join(outside, 'secret.txt'), 'x')
  })
  afterEach(() => {
    fs.rmSync(project, { recursive: true, force: true })
    fs.rmSync(outside, { recursive: true, force: true })
  })

  it('resolves an artifact by its project-relative path, as it is recorded', () => {
    expect(resolveEvidenceFile(project, 'artifact', 'artifacts/abc123-report.xml'))
      .toBe(path.join(project, 'artifacts', 'abc123-report.xml'))
  })

  it('resolves a screenshot by the absolute path its event carries', () => {
    const abs = path.join(project, 'screenshots', '1_manual.jpg')
    expect(resolveEvidenceFile(project, 'screenshot', abs)).toBe(abs)
  })

  it('refuses a path that walks out of the folder', () => {
    expect(resolveEvidenceFile(project, 'artifact', '../../etc/passwd')).toBeNull()
    expect(resolveEvidenceFile(project, 'artifact', `artifacts/../../${path.basename(outside)}/secret.txt`)).toBeNull()
    expect(resolveEvidenceFile(project, 'screenshot', path.join(outside, 'secret.txt'))).toBeNull()
  })

  it('does not let a screenshot path reach into artifacts, or the other way round', () => {
    expect(resolveEvidenceFile(project, 'screenshot', 'artifacts/abc123-report.xml')).toBeNull()
    expect(resolveEvidenceFile(project, 'artifact', path.join(project, 'screenshots', '1_manual.jpg'))).toBeNull()
  })

  // Creating a link needs a privilege most Windows runners do not give.
  it.skipIf(process.platform === 'win32')('refuses a link inside the folder that points outside it', () => {
    fs.symlinkSync(path.join(outside, 'secret.txt'), path.join(project, 'artifacts', 'link.txt'))
    expect(resolveEvidenceFile(project, 'artifact', 'artifacts/link.txt')).toBeNull()
  })

  it('refuses the folder itself, a directory, a missing file and non-string input', () => {
    fs.mkdirSync(path.join(project, 'artifacts', 'sub'))
    expect(resolveEvidenceFile(project, 'artifact', 'artifacts')).toBeNull()
    expect(resolveEvidenceFile(project, 'artifact', 'artifacts/sub')).toBeNull()
    expect(resolveEvidenceFile(project, 'artifact', 'artifacts/gone.bin')).toBeNull()
    expect(resolveEvidenceFile(project, 'artifact', '')).toBeNull()
    expect(resolveEvidenceFile(project, 'artifact', undefined)).toBeNull()
    expect(resolveEvidenceFile(project, 'artifact', 'artifacts/a\0b')).toBeNull()
    expect(resolveEvidenceFile(project, 'artifact', 42)).toBeNull()
  })
})
