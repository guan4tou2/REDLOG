import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { posix } from 'node:path'
import { spawnSync } from 'node:child_process'
import yaml from 'js-yaml'

for (const platform of ['windows','linux']) describe(`${platform} installed smoke triggers`,()=>{
  const workflow=yaml.load(readFileSync(`.github/workflows/${platform}-install-smoke.yml`,'utf8')) as {on:{workflow_dispatch:unknown;pull_request:{paths:string[]}}}
  const selected=(file:string)=>workflow.on.pull_request.paths.some(pattern=>posix.matchesGlob(file,pattern))
  it('covers capture, evidence, query and export changes while retaining manual dispatch',()=>{
    expect(Object.hasOwn(workflow.on,'workflow_dispatch')).toBe(true)
    for(const file of ['src/core/export-plan.ts','src/core/export-selection.ts','src/core/evidence-content.ts','src/core/http-body-index.ts','src/core/db/event-queries.ts','src/core/ingest.ts','src/main/ipc/data-export.ts','optional-plugins/claude-code/adapter.ts','electron.vite.config.ts','package-lock.json']) expect(selected(file),file).toBe(true)
  })
  it('does not package for copy-only or planning changes',()=>{
    for(const file of ['src/renderer/src/i18n/en.json','docs/TESTING.md','specs/064-recording-first-workspace/spec.md']) expect(selected(file),file).toBe(false)
  })
})

const run=(args:string[])=>{
  const clean={...process.env};delete clean.REDLOG_PACKAGED_APP
  const result=spawnSync(process.execPath,['scripts/run-installed-smoke.mjs',...args],{cwd:process.cwd(),env:clean,encoding:'utf8',timeout:20000})
  return {code:result.status,output:result.stdout+result.stderr}
}
it('refuses an unselected installed binary without opening an app',()=>{
  expect(run([])).toMatchObject({code:1,output:expect.stringContaining('REDLOG_PACKAGED_APP')})
})
it('lists only the recording/restart journey without launching Electron',()=>{
  const result=run(['--list'])
  expect(result.code).toBe(0)
  expect(result.output).toContain('records, exports, verifies and survives a restart')
  expect(result.output).toContain('Total: 1 test')
  expect(result.output).not.toContain('new authorized conversation')
})
