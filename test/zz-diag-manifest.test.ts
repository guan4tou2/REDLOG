// TEMPORARY diagnostic, never merged: which file of a regenerated bundle
// differs between CI and a developer machine?
import { expect, it, vi } from 'vitest'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { unpackTo } from './fixtures/golden-pre071-generate'
import { BUNDLE, clockMockVectors, generateProvenanceVectors } from './fixtures/provenance-vectors-generate'

it('prints every file of a regenerated bundle', async () => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'redlog-diag-out-'))
  vi.resetModules()
  vi.doMock('../src/core/clock', async (importOriginal) => clockMockVectors(await importOriginal<Record<string, unknown>>()))
  await generateProvenanceVectors(out)
  const dir = unpackTo(path.join(out, BUNDLE), path.join(out, 'unpacked'))
  const walk = (d: string): string[] => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)])
  console.log(`[DIAG] node=${process.version} platform=${process.platform} LANG=${process.env.LANG ?? '-'} TZ=${process.env.TZ ?? '-'}`)
  for (const f of walk(dir).sort()) {
    const buf = fs.readFileSync(f)
    console.log(`[DIAG] ${path.relative(dir, f).split(path.sep).join('/')} bytes=${buf.length} sha=${crypto.createHash('sha256').update(buf).digest('hex').slice(0, 16)} crlf=${buf.includes(Buffer.from('\r\n'))}`)
  }
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8')) as Record<string, unknown>
  const { files: _files, ...rest } = manifest
  console.log(`[DIAG] manifest-without-files ${JSON.stringify(rest)}`)
  for (const name of ['README.md', 'verify.sh', 'verify.cmd']) console.log(`[DIAG] head ${name}: ${JSON.stringify(fs.readFileSync(path.join(dir, name), 'utf8').slice(0, 400))}`)
  expect(true).toBe(true)
}, 120_000)
