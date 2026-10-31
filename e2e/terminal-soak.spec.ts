import { test, expect } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { launchWithTempHome, openTestProject, openView, REPO_ROOT } from './helpers'

/**
 * #290 soak, PTY half: a built-in terminal pane kept busy for as long as it is
 * told to, with the window resized as it goes, then closed and read back.
 *
 *   REDLOG_SOAK_MINUTES=60 xvfb-run -a npx playwright test e2e/terminal-soak.spec.ts --reporter=line
 *
 *   REDLOG_SOAK_APP_GROWTH_MIB  App growth after warm-up (first tenth), default 64
 *   REDLOG_SOAK_PTY_MS          one command every this many ms, default 2000
 *   REDLOG_SOAK_PTY_LINES       numbered lines each command prints, default 20
 *   REDLOG_SOAK_RESIZE_MS       window resize interval, default 15000
 *   REDLOG_SOAK_OUT             results file (JSON), default test-results/terminal-soak-<time>.json
 *
 * Every printed line carries a sequence number, so the cast read back after
 * the pane exits says exactly what was lost, duplicated or reordered.
 */
const minutes = Number(process.env.REDLOG_SOAK_MINUTES ?? 0)
const env = (key: string, fallback: number): number => Number(process.env[key] ?? fallback)

test.skip(!minutes, 'opt-in: set REDLOG_SOAK_MINUTES')

const MiB = 1 << 20

function version(cmd: string, args: string[]): string {
  try { return execFileSync(cmd, args, { encoding: 'utf8', cwd: REPO_ROOT }).trim().split(/\r?\n/).join(' | ') }
  catch (e) { return `unavailable: ${(e as Error).message.split('\n')[0]}` }
}

test('a long terminal session with resizes is saved whole, in order, and verifiable', async () => {
  test.skip(process.platform === 'win32', 'POSIX shell interaction; native PowerShell acceptance has its own matrix')
  const durationMs = minutes * 60_000
  test.setTimeout(durationMs + 5 * 60_000)
  const budget = { appGrowthMiB: env('REDLOG_SOAK_APP_GROWTH_MIB', 64) }
  const shape = { commandMs: env('REDLOG_SOAK_PTY_MS', 2000), linesPerCommand: env('REDLOG_SOAK_PTY_LINES', 20), resizeMs: env('REDLOG_SOAK_RESIZE_MS', 15_000) }
  const out = process.env.REDLOG_SOAK_OUT ?? path.join(REPO_ROOT, 'test-results', `terminal-soak-${new Date().toISOString().replace(/[:.]/g, '-')}.json`)
  fs.mkdirSync(path.dirname(out), { recursive: true })
  const samplesFile = out.replace(/\.json$/, '') + '.samples.jsonl'
  const result: Record<string, any> = {
    minutes, budget, shape,
    os: `${os.platform()} ${os.release()} ${os.arch()}`,
    node: process.version,
    commit: version('git', ['rev-parse', 'HEAD']),
    dirty: version('git', ['status', '--porcelain', '--untracked-files=no']) !== '',
    startedAt: new Date().toISOString()
  }
  const save = (): void => fs.writeFileSync(out, JSON.stringify(result, null, 2))

  const { app, page, tmpHome } = await launchWithTempHome(process.env.REDLOG_PACKAGED_APP)
  try {
    fs.writeFileSync(path.join(tmpHome, '.zshrc'), '# Isolated terminal soak shell\n')
    result.shell = await page.evaluate(async () => {
      localStorage.setItem('redlog-locale', 'en')
      const zsh = (await window.redlog.terminal.shells()).find(shell => /\bzsh\b/i.test(shell.label))
      if (!zsh) throw new Error('This soak requires Zsh; install it before running the test')
      localStorage.setItem('redlog-terminal-shell', zsh.id)
      return zsh.label
    })
    await openTestProject(page, 'terminal-soak')
    await openView(page, 'terminal')
    await expect.poll(() => page.evaluate(async () => (await window.redlog.terminal.list()).length)).toBe(1)
    const pane = await page.evaluate(async () => (await window.redlog.terminal.list())[0])
    await expect.poll(() => page.evaluate(async () => (await window.redlog.terminal.list())[0].recording)).toBe(true)
    await page.waitForTimeout(900)

    const appRss = (): Promise<number> => app.evaluate(({ app }) => app.getAppMetrics().reduce((sum, m) => sum + m.memory.workingSetSize * 1024, 0))
    const sizes = [[1280, 800], [900, 620]] as const
    const started = Date.now()
    let commands = 0
    let resizes = 0
    let nextResize = started + shape.resizeMs
    let nextSample = started
    let warm: number | undefined
    const samples: Array<{ t: number; rss: number; castBytes: number; lines: number }> = []
    while (Date.now() - started < durationMs) {
      const first = commands * shape.linesPerCommand + 1
      const last = first + shape.linesPerCommand - 1
      await page.evaluate(({ id, cmd }) => window.redlog.terminal.write(id, cmd), {
        id: pane.id, cmd: `for i in {${first}..${last}}; do printf 'SOAK-%06d %0100d\\n' $i $i; done\r`
      })
      commands++
      if (Date.now() >= nextResize) {
        const [width, height] = sizes[++resizes % 2]
        await app.evaluate(({ BrowserWindow }, size) => BrowserWindow.getAllWindows()[0].setSize(size.width, size.height), { width, height })
        nextResize += shape.resizeMs
      }
      if (Date.now() >= nextSample) {
        const sample = {
          t: Math.round((Date.now() - started) / 1000),
          rss: await appRss(),
          castBytes: (await page.evaluate(async () => (await window.redlog.terminal.list())[0].castBytes)) as number,
          lines: commands * shape.linesPerCommand
        }
        samples.push(sample)
        fs.appendFileSync(samplesFile, JSON.stringify(sample) + '\n')
        if (warm === undefined && sample.t * 1000 >= durationMs / 10) warm = sample.rss
        nextSample += 60_000
      }
      await page.waitForTimeout(shape.commandMs)
    }
    const expectedLines = commands * shape.linesPerCommand
    Object.assign(result, { commands, resizes, expectedLines })
    save()

    await page.evaluate(id => window.redlog.terminal.write(id, 'exit\r'), pane.id)
    const sessionEnd = (): Promise<Record<string, any> | null> => page.evaluate(async id => (await window.redlog.events.query({ agentType: 'shell', limit: -1 }))
      .find(e => e.data.subtype === 'session_end' && e.data.terminalId === id)?.data ?? null, pane.id)
    await expect.poll(sessionEnd, { timeout: 60_000 }).not.toBeNull()
    const end = (await sessionEnd())!

    const parts: string[] = end.castSegments?.length ? end.castSegments.map((s: { path: string }) => s.path) : [String(end.castPath)]
    const bytes = Buffer.concat(parts.map(p => fs.readFileSync(p)))
    const frames = bytes.toString('utf8').split('\n').filter(Boolean).slice(1).map(line => JSON.parse(line) as [number, string, string])
    const output = frames.filter(f => f[1] === 'o').map(f => f[2]).join('')
    const seen = [...output.matchAll(/SOAK-(\d{6}) 0*\d+\r?\n/g)].map(m => Number(m[1]))
    const missing: number[] = []
    for (let n = 1, i = 0; n <= expectedLines; n++) { if (seen[i] === n) i++; else missing.push(n) }
    const commandEnds = await page.evaluate(async () => (await window.redlog.events.query({ agentType: 'shell', limit: -1 }))
      .filter(e => e.data.subtype === 'command_end' && String(e.data.command).includes('SOAK-')).length)
    const chain = await page.evaluate(() => window.redlog.chain.verify())
    const final = await appRss()
    Object.assign(result, {
      endedAt: new Date().toISOString(),
      session: { reason: end.reason, castBytes: end.castBytes, castSha256: end.castSha256, parts: parts.length },
      cast: { bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), frames: frames.length, resizeFrames: frames.filter(f => f[1] === 'r').length },
      lines: { seen: seen.length, unique: new Set(seen).size, missing: missing.slice(0, 20), missingCount: missing.length },
      commandEnds,
      chain,
      memory: { warmMiB: warm === undefined ? null : +(warm / MiB).toFixed(1), finalMiB: +(final / MiB).toFixed(1), growthMiB: warm === undefined ? null : +((final - warm) / MiB).toFixed(1) },
      samples: samples.length
    })
    save()

    expect(result.cast.bytes).toBe(end.castBytes)
    expect(result.cast.sha256).toBe(end.castSha256)
    expect(result.lines.missingCount, JSON.stringify(result.lines)).toBe(0)
    expect(seen.length, 'no line saved twice').toBe(expectedLines)
    expect(result.cast.resizeFrames).toBeGreaterThanOrEqual(resizes)
    expect(commandEnds).toBe(commands)
    expect(chain).toMatchObject({ ok: true })
    if (result.memory.growthMiB !== null) expect(result.memory.growthMiB).toBeLessThanOrEqual(budget.appGrowthMiB)
  } catch (e) {
    console.log(`[DBG] ${(e as Error).message.split('\n').slice(0, 5).join(' | ')}`)
    result.error = (e as Error).message.split('\n').slice(0, 5).join(' | ')
    save()
    throw e
  } finally {
    await app.close()
  }
})
