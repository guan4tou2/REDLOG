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
 *   REDLOG_SOAK_RESIZE_VIA=cdp  resize the viewport through CDP, not the window through app.evaluate
 *   REDLOG_SOAK_GC=1            force a full collection in both JS heaps before each sample
 *   REDLOG_SOAK_PROFILE_AT      start one minute of allocation sampling in both heaps at
 *                               this minute; writes <out>.main.heapprofile / .renderer.heapprofile
 *
 * Every printed line carries a sequence number, so the cast read back after
 * the pane exits says exactly what was lost, duplicated or reordered.
 *
 * Each minute's sample splits RSS by process type and records both JS heaps,
 * because "the App grew" does not say where: the growth #290 found came from
 * the main process, outside the renderer that holds the terminal.
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
  // A soak that dies part way must say how: the App's last output and what
  // happened to the window, not only the next call's "page closed".
  const lifecycle: string[] = []
  const tail: string[] = []
  const keep = (line: string): void => { tail.push(line); if (tail.length > 80) tail.shift() }
  app.process().stdout?.on('data', (d: Buffer) => d.toString().split('\n').filter(Boolean).forEach(keep))
  app.process().stderr?.on('data', (d: Buffer) => d.toString().split('\n').filter(Boolean).forEach(l => keep(`[err] ${l}`)))
  app.process().on('exit', (code, signal) => lifecycle.push(`${new Date().toISOString()} app exit code=${code} signal=${signal}`))
  page.on('crash', () => lifecycle.push(`${new Date().toISOString()} renderer crashed`))
  page.on('close', () => lifecycle.push(`${new Date().toISOString()} page closed`))
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
    // Where the growth is: per process type, and each JS heap (after a forced
    // collection with REDLOG_SOAK_GC=1, so a slope can be told from garbage
    // not yet collected).
    const cdp = await page.context().newCDPSession(page)
    const forceGc = process.env.REDLOG_SOAK_GC === '1'
    const detail = async (): Promise<Record<string, unknown>> => {
      if (forceGc) await cdp.send('HeapProfiler.collectGarbage')
      const renderer = await cdp.send('Runtime.getHeapUsage')
      const dom = await cdp.send('Memory.getDOMCounters')
      const main = await app.evaluate(({ app }, gc) => {
        const req = process.mainModule!.require
        if (gc) {
          req('v8').setFlagsFromString('--expose-gc')
          req('vm').runInNewContext('gc')()
        }
        const m = process.memoryUsage()
        const byType: Record<string, number> = {}
        for (const p of app.getAppMetrics()) byType[p.type] = (byType[p.type] ?? 0) + p.memory.workingSetSize * 1024
        return { byType, heapUsed: m.heapUsed, heapTotal: m.heapTotal, external: m.external, arrayBuffers: m.arrayBuffers, rss: m.rss }
      }, forceGc)
      return { main, renderer: { used: renderer.usedSize, total: renderer.totalSize }, dom }
    }
    // Allocation sampling in both JS heaps for one minute, from this minute.
    const profileAt = env('REDLOG_SOAK_PROFILE_AT', -1)
    let profiling: 'no' | 'on' | 'done' = 'no'
    const startProfile = async (): Promise<void> => {
      await cdp.send('HeapProfiler.startSampling', { samplingInterval: 16384, includeObjectsCollectedByMajorGC: true, includeObjectsCollectedByMinorGC: true })
      await app.evaluate(() => {
        const { Session } = process.mainModule!.require('inspector')
        const s = new Session(); s.connect()
        ;(globalThis as any).__soakProfiler = s
        s.post('HeapProfiler.startSampling', { samplingInterval: 16384, includeObjectsCollectedByMajorGC: true, includeObjectsCollectedByMinorGC: true })
      })
    }
    const stopProfile = async (): Promise<void> => {
      const renderer = await cdp.send('HeapProfiler.stopSampling')
      fs.writeFileSync(out.replace(/\.json$/, '') + '.renderer.heapprofile', JSON.stringify(renderer.profile))
      const main = await app.evaluate(() => new Promise<string>((resolve, reject) => {
        const s = (globalThis as any).__soakProfiler
        s.post('HeapProfiler.stopSampling', (err: Error | null, r: { profile: unknown }) => err ? reject(err) : resolve(JSON.stringify(r.profile)))
      }))
      fs.writeFileSync(out.replace(/\.json$/, '') + '.main.heapprofile', main)
    }
    const sizes = [[1280, 800], [900, 620]] as const
    const resizeViaCdp = process.env.REDLOG_SOAK_RESIZE_VIA === 'cdp'
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
        if (resizeViaCdp) {
          // The page's viewport, not the window: xterm refits and the PTY is
          // resized as before, with no call into the main process's JS, so
          // the harness's own inspector traffic can be told from the App's.
          await cdp.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 0, mobile: false })
        } else {
          // The window this page is in: the app also has an overlay window.
          await (await app.browserWindow(page)).evaluate((win, size) => win.setSize(size.width, size.height), { width, height })
        }
        nextResize += shape.resizeMs
      }
      if (Date.now() >= nextSample) {
        const sample = {
          t: Math.round((Date.now() - started) / 1000),
          rss: await appRss(),
          castBytes: (await page.evaluate(async () => (await window.redlog.terminal.list())[0].castBytes)) as number,
          lines: commands * shape.linesPerCommand,
          ...(await detail())
        }
        samples.push(sample)
        fs.appendFileSync(samplesFile, JSON.stringify(sample) + '\n')
        if (warm === undefined && sample.t * 1000 >= durationMs / 10) warm = sample.rss
        nextSample += 60_000
        if (profiling === 'on') { await stopProfile(); profiling = 'done' }
        else if (profiling === 'no' && profileAt >= 0 && sample.t >= profileAt * 60) { await startProfile(); profiling = 'on' }
      }
      await page.waitForTimeout(shape.commandMs)
    }
    // The budget is judged here, at the end of the session: the read-back
    // below loads every shell row into the renderer, and that is the soak's
    // own cost, not the App's.
    const atEnd = await appRss()
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
    const afterReadBack = await appRss()
    Object.assign(result, {
      endedAt: new Date().toISOString(),
      session: { reason: end.reason, castBytes: end.castBytes, castSha256: end.castSha256, parts: parts.length },
      cast: { bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), frames: frames.length, resizeFrames: frames.filter(f => f[1] === 'r').length },
      lines: { seen: seen.length, unique: new Set(seen).size, missing: missing.slice(0, 20), missingCount: missing.length },
      commandEnds,
      chain,
      memory: {
        warmMiB: warm === undefined ? null : +(warm / MiB).toFixed(1),
        atEndMiB: +(atEnd / MiB).toFixed(1),
        growthMiB: warm === undefined ? null : +((atEnd - warm) / MiB).toFixed(1),
        afterReadBackMiB: +(afterReadBack / MiB).toFixed(1)
      },
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
    Object.assign(result, { lifecycle, appOutputTail: tail })
    save()
    throw e
  } finally {
    await app.close()
  }
})
