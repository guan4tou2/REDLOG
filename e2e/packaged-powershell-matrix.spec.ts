import { test, expect, type Page } from '@playwright/test'
import { existsSync, readFileSync, writeFileSync, rmSync, mkdirSync, readdirSync, rmdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { launchWithTempHome, openTestProject } from './helpers'
import { operationPairKey } from '../src/core/operation-pair-key'

// The Windows PowerShell 5.1 / PowerShell 7 acceptance matrix, against an
// installed build: the profile the one-click install writes, real command
// pairing, exit codes, and Redlog-Run's structured output, once per edition.
//
// packaged-smoke drives 5.1 only, with -NoProfile and the hook dot-sourced by
// hand. This loads the profile instead — the file the app wrote — so the
// `$HOME`-relative line it appends is what finds the hook.
//
// REDLOG_PACKAGED_REAL_PROFILE=1 goes one step further and appends that line
// to the operator's REAL $PROFILE for each edition, so PowerShell's own
// profile resolution and the machine's execution policy are in the path. The
// original bytes are restored in `finally` and compared. Without the flag no
// file outside the temp home is touched.
//
//   REDLOG_PACKAGED_APP=<...>\RedLog.exe npx playwright test e2e/packaged-powershell-matrix.spec.ts

const exe = process.env.REDLOG_PACKAGED_APP
const realProfile = process.env.REDLOG_PACKAGED_REAL_PROFILE === '1'

interface Ev { agentType: string; data: Record<string, unknown> }

const events = (page: Page): Promise<Ev[]> =>
  page.evaluate(async () => (await window.redlog.events.query({ limit: 2000 })) as unknown as Ev[])
const rows = (list: Ev[], subtype: string, command: string): Ev[] =>
  list.filter((e) => e.agentType === 'shell' && e.data.subtype === subtype && e.data.command === command)

const editions = [
  { tag: 'ps51', shell: 'powershell.exe', dir: 'WindowsPowerShell' },
  { tag: 'ps7', shell: 'pwsh', dir: 'PowerShell' }
].filter((e) => spawnSync(e.shell, ['-NoProfile', '-Command', 'exit 0'], { stdio: 'ignore' }).status === 0)

/** The operator's real $PROFILE for an edition (Documents is a known folder,
 *  not USERPROFILE, so this ignores the temp home on purpose). */
function realProfilePath(shell: string): string {
  return spawnSync(shell, ['-NoProfile', '-Command', '$PROFILE'], { encoding: 'utf8' }).stdout.trim()
}

test.describe('packaged PowerShell matrix', () => {
  test.skip(process.platform !== 'win32' || !exe, 'Windows only; set REDLOG_PACKAGED_APP to an installed RedLog.exe')

  test('each edition loads the installed profile, pairs commands and records real exit codes and output', async () => {
    test.setTimeout(300_000)
    expect(editions.length, 'at least Windows PowerShell 5.1').toBeGreaterThan(0)
    const { app, page, tmpHome } = await launchWithTempHome(exe)
    const restore: Array<() => void> = []
    try {
      await openTestProject(page, 'ps-matrix')
      const r = await page.evaluate(async () => window.redlog.hooks.install('shell-powershell'))
      expect((r as { success: boolean }).success).toBe(true)

      for (const ed of editions) {
        await test.step(`${ed.tag}: ${realProfile ? 'real $PROFILE' : 'installed profile'}`, async () => {
          const installed = join(tmpHome, 'Documents', ed.dir, 'Microsoft.PowerShell_profile.ps1')
          expect(existsSync(installed), `${ed.tag}: the install wrote ${installed}`).toBe(true)
          const written = readFileSync(installed, 'utf8')
          expect(written).toMatch(/\.redlog\\shell-hook\.ps1/)

          let args: string[]
          if (realProfile) {
            const target = realProfilePath(ed.shell)
            expect(target).toMatch(/Microsoft\.PowerShell_profile\.ps1$/)
            const existed = existsSync(target)
            const before = existed ? readFileSync(target) : null
            const madeDir = !existsSync(dirname(target))
            restore.push(() => {
              if (before) writeFileSync(target, before)
              else rmSync(target, { force: true })
              if (madeDir && existsSync(dirname(target)) && readdirSync(dirname(target)).length === 0) rmdirSync(dirname(target))
              const now = existsSync(target) ? readFileSync(target) : null
              if (!(before ? now?.equals(before) : now === null)) throw new Error(`${target} was not restored`)
            })
            mkdirSync(dirname(target), { recursive: true })
            const sep = before && before.length && !before.toString('utf8').endsWith('\n') ? '\r\n' : ''
            writeFileSync(target, Buffer.concat([before ?? Buffer.alloc(0), Buffer.from(sep + written, 'utf8')]))
            // Profiles load before -Command runs; `$null` just keeps -NoExit reading stdin.
            args = ['-NoLogo', '-NoExit', '-Command', '$null']
          } else {
            args = ['-NoLogo', '-NoProfile', '-NoExit', '-Command', `. '${installed}'`]
          }

          const child = spawn(ed.shell, args, { env: { ...process.env, USERPROFILE: tmpHome, HOME: tmpHome }, stdio: ['pipe', 'pipe', 'pipe'] })
          let out = ''
          child.stdout.on('data', (d) => { out += d })
          child.stderr.on('data', (d) => { out += d })
          const closed = new Promise<void>((res) => child.on('close', () => res()))
          const canary = `echo ${ed.tag}-canary`
          const native = `cmd /c "echo ${ed.tag}>nul& exit 3"`
          const cmdlet = `Get-Item C:\\redlog-missing-${ed.tag}`
          const wrapped = `Redlog-Run cmd /c "echo out-${ed.tag}& echo err-${ed.tag} 1>&2& exit 4"`
          for (const c of ['Write-Output "edition=$($PSVersionTable.PSEdition)/$($PSVersionTable.PSVersion.Major)"', canary, native, cmdlet, wrapped, 'exit']) {
            child.stdin.write(`${c}\r\n`)
            await new Promise((res) => setTimeout(res, 2500))
          }
          child.stdin.end()
          await closed
          console.log(`[${ed.tag}] ${out.replace(/\s+/g, ' ').slice(0, 600)}`)
          expect(out, `${ed.tag}: the hook loaded`).toContain('[redlog] tip')
          expect(out).toMatch(ed.tag === 'ps51' ? /edition=Desktop\/5/ : /edition=Core\/7/)

          await expect.poll(async () => rows(await events(page), 'command_end', cmdlet).length, { timeout: 20_000 }).toBeGreaterThan(0)
          const list = await events(page)
          const end = (c: string): Ev => rows(list, 'command_end', c)[0]
          expect(end(canary).data.exit_code).toBe(0)
          expect(end(native).data.exit_code).toBe(3)
          // A failing cmdlet sets $? but not $LASTEXITCODE. Directly after a
          // native exit 3, the hook must not report that stale 3.
          expect(end(cmdlet).data.exit_code, `${ed.tag}: failed cmdlet after a native exit 3`).toBe(1)
          for (const c of [canary, native, cmdlet]) {
            expect(rows(list, 'command_end', c), `${ed.tag}: ${c} recorded once`).toHaveLength(1)
            const key = operationPairKey(rows(list, 'command_start', c)[0] ?? { agentType: 'shell' })
            expect(key, `${ed.tag}: ${c} start carries a pair key`).not.toBeNull()
            expect(operationPairKey(end(c))).toBe(key)
          }
          const structured = list.find((e) => e.agentType === 'shell' && e.data.subtype === 'command_end' && e.data.captured_by === 'redlog-run' && String(e.data.stdout ?? '').includes(`out-${ed.tag}`))
          expect(structured, `${ed.tag}: Redlog-Run sent structured output`).toBeTruthy()
          expect(structured!.data.exit_code).toBe(4)
          expect(String(structured!.data.stderr)).toContain(`err-${ed.tag}`)
          expect(structured!.data.stdout_truncated).toBe(false)
        })
      }
    } catch (e) {
      console.log(`[DBG] ${(e as Error).message.split('\n').slice(0, 6).join(' | ')}`)
      throw e
    } finally {
      for (const undo of restore.reverse()) undo()
      await app.close()
    }
  })
})
