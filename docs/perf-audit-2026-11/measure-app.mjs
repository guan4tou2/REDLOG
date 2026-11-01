#!/usr/bin/env node
// Drive the production build (out/) and measure it — PERF-AUDIT-2026-11 §1, §2, §4.
//
//   npm run build
//   node docs/perf-audit-2026-11/measure-app.mjs startup [runs]
//   node docs/perf-audit-2026-11/measure-app.mjs create <home> <name>
//   node docs/perf-audit-2026-11/measure-app.mjs project <home> <name> <outDir>
//   node docs/perf-audit-2026-11/measure-app.mjs export <home> <name> json|ndjson|har|bundle <outDir>
//
// startup  fresh home each run: process launch → main process created →
//          renderer navigation → first contentful paint → project picker
//          listed (the first frame an operator can act on).
// create   create and open a project through the bridge, then quit, so
//          seed-project.ts can fill it with the app's own operator and key.
// project  open that project by clicking it in the picker, then the Timeline:
//          initial load, horizontal scroll frames, a filter change, a search,
//          memory per process. Every ipcMain.handle handler is wrapped to time
//          it, and the main process is CPU-profiled across the project open.
//
// The environment is production-like: no REDLOG_E2E, no NODE_ENV=test, and
// SHELL/MSYSTEM removed so a Git Bash parent does not leak into the app.

import { _electron as electron } from '@playwright/test'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
// PERF_MAIN points at another build's main entry (the §5 minified what-if).
const MAIN = process.env.PERF_MAIN ?? path.join(repo, 'out', 'main', 'index.js')
const [cmd, ...rest] = process.argv.slice(2)

function newHome(prefix) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  fs.mkdirSync(path.join(home, 'AppData', 'Roaming'), { recursive: true })
  return home
}

function env(home) {
  const e = { ...process.env, HOME: home, USERPROFILE: home, CLAUDE_CONFIG_DIR: path.join(home, '.claude'), CODEX_HOME: path.join(home, '.codex') }
  for (const k of ['SHELL', 'MSYSTEM', 'REDLOG_E2E', 'NODE_ENV', 'MSYS_NO_PATHCONV']) delete e[k]
  return e
}

async function mainWindow(app) {
  for (let i = 0; i < 200; i++) {
    const w = app.windows().find((p) => !/overlay\.html/.test(p.url()))
    if (w) return w
    await new Promise((r) => setTimeout(r, 25))
  }
  return app.firstWindow()
}

const median = (xs) => { const s = [...xs].sort((a, b) => a - b); return s[Math.floor(s.length / 2)] }
const pct = (xs, p) => { const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))] }

async function metrics(app) {
  return app.evaluate(({ app: a }) => a.getAppMetrics().map((m) => ({
    type: m.type, name: m.name ?? '', workingSetMiB: +(m.memory.workingSetSize / 1024).toFixed(1),
    privateMiB: +((m.memory.privateBytes ?? 0) / 1024).toFixed(1)
  })))
}

async function wrapIpc(app) {
  return app.evaluate(({ ipcMain }) => {
    const handlers = ipcMain._invokeHandlers
    if (!handlers) return false
    globalThis.__perfIpc = []
    for (const [ch, fn] of handlers) {
      if (fn.__perf) continue
      const w = async (...a) => {
        const at = Date.now()
        const s = performance.now()
        try { return await fn(...a) } finally { globalThis.__perfIpc.push({ ch, at, ms: +(performance.now() - s).toFixed(1) }) }
      }
      w.__perf = true
      handlers.set(ch, w)
    }
    return true
  })
}
const takeIpc = (app) => app.evaluate(() => { const x = globalThis.__perfIpc ?? []; globalThis.__perfIpc = []; return x })

async function startMainProfile(app) {
  await app.evaluate(async () => {
    const inspector = process.mainModule.require('inspector')
    const s = new inspector.Session()
    s.connect()
    globalThis.__perfSession = s
    const post = (m, p) => new Promise((res, rej) => s.post(m, p ?? {}, (e, r) => e ? rej(e) : res(r)))
    await post('Profiler.enable')
    await post('Profiler.setSamplingInterval', { interval: 200 })
    await post('Profiler.start')
  })
}
async function stopMainProfile(app, file) {
  const json = await app.evaluate(async () => new Promise((res, rej) =>
    globalThis.__perfSession.post('Profiler.stop', (e, r) => e ? rej(e) : res(JSON.stringify(r.profile)))))
  fs.writeFileSync(file, json)
}

function summariseIpc(calls) {
  const by = new Map()
  for (const c of calls) {
    const x = by.get(c.ch) ?? { ch: c.ch, n: 0, totalMs: 0, maxMs: 0 }
    x.n++; x.totalMs += c.ms; x.maxMs = Math.max(x.maxMs, c.ms)
    by.set(c.ch, x)
  }
  return [...by.values()].map((x) => ({ ...x, totalMs: +x.totalMs.toFixed(1) })).sort((a, b) => b.totalMs - a.totalMs)
}

// Same route as e2e/helpers.ts openView: a sidebar button when there is one,
// otherwise the command palette (the Timeline has no sidebar entry).
async function openView(page, view) {
  const direct = page.locator(`[data-view-btn="${view}"]`).first()
  if (await direct.count()) await direct.click()
  else {
    await page.locator('nav [aria-current="page"]').focus()
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+k' : 'Control+k')
    await page.locator(`[data-command-id="nav:${view}"]`).click()
  }
  await page.waitForSelector(`[data-testid="view-root"][data-view="${view}"]`, { timeout: 60_000 })
}

async function waitPicker(page) {
  await page.waitForSelector('[data-testid="project-picker"]', { timeout: 60_000 })
  await page.waitForFunction(() => !document.querySelector('[data-testid="project-list-status"][data-state="loading"]'), null, { timeout: 60_000 })
}

if (cmd === 'startup') {
  const runs = Number(rest[0] ?? 5)
  const results = []
  for (let r = 0; r < runs; r++) {
    const home = newHome('redlog-perf-start-')
    const t0 = Date.now()
    const app = await electron.launch({ args: [MAIN], cwd: repo, env: env(home) })
    const tConnected = Date.now()
    const page = await mainWindow(app)
    await waitPicker(page)
    const tPicker = Date.now()
    const created = await app.evaluate(() => process.getCreationTime())
    const nav = await page.evaluate(() => {
      const n = performance.getEntriesByType('navigation')[0]
      const fcp = performance.getEntriesByType('paint').find((p) => p.name === 'first-contentful-paint')
      const scripts = performance.getEntriesByType('resource').filter((e) => e.initiatorType === 'script' || /\.js$/.test(e.name))
      return { timeOrigin: performance.timeOrigin, dcl: n?.domContentLoadedEventEnd, load: n?.loadEventEnd, fcp: fcp?.startTime,
        scriptFetchMs: Math.round(scripts.reduce((s, e) => s + e.duration, 0)), heapMiB: +(performance.memory.usedJSHeapSize / 1048576).toFixed(1) }
    })
    const mem = await metrics(app)
    const row = {
      run: r + 1,
      launchToMainProcess: Math.round(created - t0),
      launchToPlaywrightConnected: tConnected - t0,
      launchToRendererNavigation: Math.round(nav.timeOrigin - t0),
      navigationToDCL: Math.round(nav.dcl),
      navigationToFCP: Math.round(nav.fcp),
      launchToFCP: Math.round(nav.timeOrigin + nav.fcp - t0),
      launchToPickerListed: tPicker - t0,
      rendererHeapMiB: nav.heapMiB,
      workingSetMiB: Object.fromEntries(mem.map((m, i) => [`${m.type}${m.name ? `:${m.name}` : ''}#${i}`, m.workingSetMiB]))
    }
    console.log(JSON.stringify(row))
    results.push(row)
    await app.close()
  }
  const keys = ['launchToMainProcess', 'launchToRendererNavigation', 'navigationToFCP', 'launchToFCP', 'launchToPickerListed']
  console.log(JSON.stringify({ median: Object.fromEntries(keys.map((k) => [k, median(results.map((x) => x[k]))])) }))
}

if (cmd === 'create') {
  const [home, name] = rest
  fs.mkdirSync(path.join(home, 'AppData', 'Roaming'), { recursive: true })
  const app = await electron.launch({ args: [MAIN], cwd: repo, env: env(home) })
  const page = await mainWindow(app)
  await waitPicker(page)
  await page.evaluate(() => localStorage.setItem('redlog-locale', 'en'))
  const project = await page.evaluate(async (n) => {
    const p = await window.redlog.project.create(n)
    await window.redlog.project.open(p.id)
    return p
  }, name)
  await new Promise((r) => setTimeout(r, 4000))
  const dir = await app.evaluate(() => process.mainModule.require('path').join(process.mainModule.require('os').homedir(), '.redlog', 'projects'))
  console.log(JSON.stringify({ project, projectDir: path.join(dir, project.id) }))
  await app.close()
}

// Peak working set of a process since it started, from Windows' own counter —
// a sampler on the main process would be blocked by the very synchronous work
// it is trying to see.
function peakOf(pid) {
  const r = spawnSync('powershell', ['-NoProfile', '-Command',
    `$p = Get-Process -Id ${pid}; "{0} {1} {2}" -f $p.WorkingSet64, $p.PeakWorkingSet64, $p.PeakPagedMemorySize64`], { encoding: 'utf8' })
  const [ws, peakWs, peakPaged] = r.stdout.trim().split(/\s+/).map(Number)
  return { workingSetMiB: +(ws / 1048576).toFixed(1), peakWorkingSetMiB: +(peakWs / 1048576).toFixed(1), peakPagedMiB: +(peakPaged / 1048576).toFixed(1) }
}
function dirBytes(p) {
  const st = fs.statSync(p)
  if (!st.isDirectory()) return st.size
  return fs.readdirSync(p).reduce((s, f) => s + dirBytes(path.join(p, f)), 0)
}

if (cmd === 'export') {
  // One fresh launch per format, so the peak counter belongs to that export.
  const [home, name, format, outDir] = rest
  fs.mkdirSync(outDir, { recursive: true })
  const app = await electron.launch({ args: [MAIN], cwd: repo, env: env(home) })
  const page = await mainWindow(app)
  await waitPicker(page)
  await page.locator('[data-testid="project-picker"] div.cursor-pointer', { hasText: name }).first().click()
  await page.waitForSelector('[data-testid="view-root"]', { timeout: 120_000 })
  await page.waitForTimeout(8000)
  const pid = await app.evaluate(() => process.pid)
  const before = peakOf(pid)
  await startMainProfile(app)
  const r = await page.evaluate(async (fmt) => {
    const t0 = performance.now()
    const resolved = await window.redlog.data.resolveExportPlan({ format: fmt, subset: { kind: 'all' } })
    const t1 = performance.now()
    if (!resolved.ok) return { error: resolved.error, resolveMs: t1 - t0 }
    const done = await window.redlog.data.executeExportPlan({ planId: resolved.plan.id })
    const t2 = performance.now()
    return { resolveMs: Math.round(t1 - t0), executeMs: Math.round(t2 - t1), ok: done.ok, error: done.error, check: done.check,
      artifactPath: done.artifactPath ?? done.path ?? done.outDir ?? null, counts: resolved.plan.counts }
  }, format)
  await stopMainProfile(app, path.join(outDir, `main-export-${format}.cpuprofile`))
  const after = peakOf(pid)
  let artifactBytes = null
  try { if (r.artifactPath) artifactBytes = dirBytes(r.artifactPath) } catch { /* reported as null */ }
  const row = { format, ...r, artifactMiB: artifactBytes === null ? null : +(artifactBytes / 1048576).toFixed(1), mainBefore: before, mainAfter: after }
  console.log(JSON.stringify(row))
  fs.writeFileSync(path.join(outDir, `export-${format}.json`), JSON.stringify(row, null, 2))
  await app.close()
}

if (cmd === 'project') {
  const [home, name, outDir] = rest
  fs.mkdirSync(outDir, { recursive: true })
  const out = {}
  const t0 = Date.now()
  const app = await electron.launch({ args: [MAIN], cwd: repo, env: env(home) })
  await wrapIpc(app)
  const page = await mainWindow(app)
  await waitPicker(page)
  out.launchToPickerListed = Date.now() - t0
  out.pickerIpc = summariseIpc(await takeIpc(app))
  // The picker lists projects before this wrap can run on a fast start; list
  // again so the cost of project:list on this home is measured either way.
  const l0 = Date.now()
  await page.evaluate(() => window.redlog.project.list())
  out.projectListRoundTripMs = Date.now() - l0
  await takeIpc(app)
  out.memoryAtPicker = await metrics(app)

  // ── project open, by clicking it ──
  await startMainProfile(app)
  const o0 = Date.now()
  await page.locator('[data-testid="project-picker"] div.cursor-pointer', { hasText: name }).first().click()
  await page.waitForSelector('[data-testid="view-root"]', { timeout: 120_000 })
  out.clickToViewRoot = Date.now() - o0
  await page.waitForTimeout(5000)
  await stopMainProfile(app, path.join(outDir, 'main-project-open.cpuprofile'))
  out.openIpc = summariseIpc(await takeIpc(app)).slice(0, 25)
  out.memoryAfterOpen = await metrics(app)

  // ── Timeline initial load ──
  const tl0 = Date.now()
  await openView(page, 'timeline')
  await page.waitForFunction(() => document.querySelectorAll('[data-timeline-event]').length > 0, null, { timeout: 120_000 })
  out.timelineClickToFirstDots = Date.now() - tl0
  await page.waitForFunction(() => /\d/.test(document.querySelector('[data-testid="timeline-range-status"]')?.textContent ?? ''), null, { timeout: 120_000 }).catch(() => {})
  out.timelineClickToRangeStatus = Date.now() - tl0
  await page.waitForTimeout(2000)
  out.timelineIpc = summariseIpc(await takeIpc(app))
  out.timelineDom = await page.evaluate(() => ({
    dots: document.querySelectorAll('[data-timeline-event]').length,
    nodes: document.getElementsByTagName('*').length,
    range: document.querySelector('[data-testid="timeline-range-status"]')?.textContent,
    heapMiB: +(performance.memory.usedJSHeapSize / 1048576).toFixed(1)
  }))
  out.memoryAfterTimeline = await metrics(app)

  // ── horizontal scroll: 120 steps of a quarter viewport, one per frame ──
  out.scroll = await page.evaluate(async () => {
    const el = document.querySelector('div.cursor-grab')
    if (!el) return { error: 'no scroll container' }
    const frames = []
    let last = performance.now()
    const longTasks = []
    const po = new PerformanceObserver((l) => { for (const e of l.getEntries()) longTasks.push(e.duration) })
    try { po.observe({ type: 'longtask', buffered: false }) } catch { /* not supported */ }
    for (let i = 0; i < 120; i++) {
      el.scrollLeft = Math.max(0, el.scrollLeft - el.clientWidth / 4)
      await new Promise((r) => requestAnimationFrame(() => r()))
      const now = performance.now(); frames.push(now - last); last = now
    }
    await new Promise((r) => setTimeout(r, 500))
    po.disconnect()
    const s = [...frames].sort((a, b) => a - b)
    return { frames: frames.length, p50: +s[Math.floor(s.length * 0.5)].toFixed(1), p95: +s[Math.floor(s.length * 0.95)].toFixed(1),
      max: +s[s.length - 1].toFixed(1), over50ms: frames.filter((f) => f > 50).length, longTasks: longTasks.length,
      longTaskMs: Math.round(longTasks.reduce((a, b) => a + b, 0)), dots: document.querySelectorAll('[data-timeline-event]').length }
  })
  await page.waitForTimeout(1500)
  out.scrollIpc = summariseIpc(await takeIpc(app))

  // ── filter change: Type = shell through the FilterBar ──
  const toggle = page.locator('[aria-controls="filter-bar-panel"]').first()
  if (await toggle.count()) {
    if ((await toggle.getAttribute('aria-expanded')) !== 'true') await toggle.click()
    const f0 = Date.now()
    await page.locator('#filter-bar-panel select').nth(1).selectOption('shell')
    await page.waitForFunction(() => /\d/.test(document.querySelector('[data-testid="timeline-range-status"]')?.textContent ?? ''), null, { timeout: 120_000 }).catch(() => {})
    await page.waitForTimeout(1500)
    const calls = await takeIpc(app)
    out.filterChange = { ipc: summariseIpc(calls), lastIpcEndMs: Math.max(0, ...calls.map((c) => c.at + c.ms - f0)) }
    await page.locator('#filter-bar-panel select').nth(1).selectOption('')
    await page.waitForTimeout(1500)
    await takeIpc(app)
  } else out.filterChange = { error: 'no filter toggle' }

  // ── IPC round trips with the Timeline's own request shapes ──
  out.bridge = await page.evaluate(async () => {
    const r = {}
    const time = async (k, fn) => { const s = performance.now(); const v = await fn(); r[k] = { ms: +(performance.now() - s).toFixed(1), n: Array.isArray(v?.items) ? v.items.length : (typeof v === 'number' ? v : undefined) } }
    const ev = window.redlog.events
    await time('queryPage first 200', () => ev.queryPage({ excludeHousekeeping: true, limit: 200 }))
    await time('count all', () => ev.count({ filter: {}, excludeHousekeeping: true }))
    await time('queryPage type=scanner', () => ev.queryPage({ agentType: 'scanner', excludeHousekeeping: true, limit: 200 }))
    await time('count type=scanner', () => ev.count({ filter: { agentType: 'scanner' }, excludeHousekeeping: true }))
    await time('queryPage target=10.10.11.5', () => ev.queryPage({ targetId: '10.10.11.5', excludeHousekeeping: true, limit: 200 }))
    await time('count target=10.10.11.5', () => ev.count({ filter: { targetId: '10.10.11.5' }, excludeHousekeeping: true }))
    const parsed = (text) => ({ text, conditions: [], tokens: text.split(/\s+/).map((raw) => ({ raw, read: 'text' })) })
    await time('runQuery text=ffuf', () => ev.runQuery({ parsed: parsed('ffuf'), limit: 50, excludeHousekeeping: true }))
    await time('count text=ffuf', () => ev.count({ parsed: parsed('ffuf'), filter: {}, excludeHousekeeping: true }))
    await time('runQuery text=nonexistentzzz', () => ev.runQuery({ parsed: parsed('nonexistentzzz'), limit: 50, excludeHousekeeping: true }))
    await time('distinctAgentTypes', () => ev.distinctAgentTypes())
    await time('aggregateTargets', () => ev.aggregateTargets())
    await time('distinctHosts', () => ev.distinctHosts())
    return r
  })
  await takeIpc(app)

  // ── search view, as an operator types it ──
  try {
    await openView(page, 'search')
    await page.locator('#reading-tab-events').click().catch(() => {})
    const s0 = Date.now()
    await page.getByTestId('search-input').fill('crackmapexec')
    await page.waitForFunction(() => document.querySelector('[data-testid="search-results"]')?.getAttribute('aria-busy') === 'false'
      && document.querySelectorAll('[data-testid="search-results"] [role="option"]').length > 0, null, { timeout: 120_000 })
    out.searchTypeToResults = Date.now() - s0
    out.searchIpc = summariseIpc(await takeIpc(app))
  } catch (e) { out.searchError = String(e).split('\n')[0] }

  out.memoryEnd = await metrics(app)
  out.rendererHeapEndMiB = await page.evaluate(() => +(performance.memory.usedJSHeapSize / 1048576).toFixed(1))
  fs.writeFileSync(path.join(outDir, 'project.json'), JSON.stringify(out, null, 2))
  console.log(JSON.stringify(out, null, 2))
  await app.close()
}
