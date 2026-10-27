import { it, expect } from 'vitest'
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'

it('ignores electron-vite generated configuration while retaining real source dirtiness', () => {
  const dir = mkdtempSync(join(tmpdir(), 'redlog-build-status-'))
  const git = (...args: string[]): string => execFileSync('git', args, {cwd:dir,encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim()
  try {
    git('init','--quiet')
    writeFileSync(join(dir,'.gitignore'),readFileSync(join(process.cwd(),'.gitignore')))
    writeFileSync(join(dir,'electron.vite.config.ts'),'export default {}\n')
    git('add','.gitignore','electron.vite.config.ts')
    git('-c','user.name=Fixture','-c','user.email=fixture@example.test','commit','--quiet','-m','fixture')
    writeFileSync(join(dir,'electron.vite.config.1793062800000.mjs'),'// compiler generated\n')
    expect(git('status','--porcelain','--untracked-files=normal')).toBe('')
    writeFileSync(join(dir,'electron.vite.config.ts'),'export default {changed:true}\n')
    expect(git('status','--porcelain')).toContain('electron.vite.config.ts')
    writeFileSync(join(dir,'operator-notes.txt'),'untracked source\n')
    expect(git('status','--porcelain','--untracked-files=normal')).toContain('operator-notes.txt')
  } finally { rmSync(dir,{recursive:true,force:true}) }
})
