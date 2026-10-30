import { test, expect } from '@playwright/test'
import { spawn, spawnSync } from 'node:child_process'
import { createServer, get, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { launchWithTempHome, makeTempHome, REPO_ROOT } from './helpers'
import { ManagedHttpProxy, buildManagedProxyArgs, probeManagedProxy } from '../src/main/services/managed-http-proxy'

// Acceptance for #459 and #460 against the real mitmdump and the real app.
// Each test prints a [459] or [460] line with what it measured, so a run is
// also the record the issues ask for: the version, the queue limit, and what
// actually happened.

const ADDON = join(REPO_ROOT, 'hooks', 'mitmproxy-addon.py')
const hasMitmdump = (): boolean => spawnSync('mitmdump', ['--version'], { timeout: 10_000 }).status === 0
const mitmVersion = (): string => String(spawnSync('mitmdump', ['--version'], { timeout: 10_000 }).stdout).split('\n')[0].trim()

function listen(server: Server): Promise<number> {
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve((server.address() as { port: number }).port)))
}

function close(server: Server): Promise<void> {
  server.closeAllConnections()
  return new Promise(resolve => server.close(() => resolve()))
}

/** One GET through the proxy; resolves with the status, or the error. */
function viaProxy(proxyUrl: string, target: string): Promise<number | string> {
  const proxy = new URL(proxyUrl)
  return new Promise(resolve => {
    const req = get({ host: proxy.hostname, port: proxy.port, path: target, headers: { host: new URL(target).host }, agent: false },
      (res: IncomingMessage) => { res.resume(); res.on('end', () => resolve(res.statusCode ?? 0)); res.on('error', e => resolve(e.message)) })
    req.on('error', e => resolve(e.message))
    req.setTimeout(20_000, () => { req.destroy(new Error('timeout')) })
  })
}

function filesUnder(dir: string): string[] {
  if (!existsSync(dir)) return []
  return readdirSync(dir).flatMap(name => {
    const full = join(dir, name)
    return statSync(full).isDirectory() ? filesUnder(full) : [full]
  })
}

function hardKill(pid: number): void {
  if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'])
  else process.kill(pid, 'SIGKILL')
}

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true } catch { return false }
}

test('#459 flows begun in project A and answered after the switch to B leave B nothing of A', async () => {
  test.skip(!hasMitmdump(), 'Requires installed mitmdump for real source acceptance')
  test.setTimeout(150_000)
  const MARKER = 'A-ONLY-7f3c9e'
  const held = new Map<string, ServerResponse>()
  const upstream = createServer((req, res) => {
    const owner = new URL(req.url ?? '/', 'http://x').searchParams.get('owner') ?? ''
    if (req.url?.startsWith('/slow')) { held.set(owner, res); return }
    res.writeHead(200, { 'content-type': 'text/plain' }); res.end('fast')
  })
  const upPort = await listen(upstream)
  const answerLate = (owner: string): void => {
    const res = held.get(owner)!
    res.writeHead(200, { 'content-type': 'text/plain', 'set-cookie': `session=${MARKER}; Path=/` })
    res.end(`${MARKER} body`)
  }
  const { app, page, tmpHome } = await launchWithTempHome()
  // Two producers. The app's own, which a switch stops. And one the app does
  // not own — an operator's mitmdump loading the same addon — which outlives
  // the switch, so its late answer for A is sent while B is open. Its pending
  // TTL is cut to seconds so the sweep runs inside the test.
  const TTL_SEC = 3
  const externalPort = 18000 + Math.floor(Math.random() * 2000)
  const external = spawn('mitmdump', buildManagedProxyArgs(ADDON, externalPort), {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, HOME: tmpHome, USERPROFILE: tmpHome, REDLOG_PROXY_READY_TOKEN: 'external-ready', PYTHONUNBUFFERED: '1',
      REDLOG_PENDING_TTL_SEC: String(TTL_SEC) }
  })
  let externalOutput = ''
  external.stdout?.on('data', chunk => { externalOutput += String(chunk) })
  external.stderr?.on('data', chunk => { externalOutput += String(chunk) })
  const externalUrl = `http://127.0.0.1:${externalPort}`
  try {
    const statusOf = () => page.evaluate(() => window.redlog.httpCapture.status())
    const scanner = () => page.evaluate(() => window.redlog.events.query({ agentType: 'scanner', limit: -1 }))
    const urls = async (owner: string) => (await scanner()).filter(e => String(e.data.url ?? '').includes(`owner=${owner}`)).map(e => e.data.subtype)
    await expect.poll(() => probeManagedProxy(externalUrl, 'external-ready'), { timeout: 60_000 }).toBe(true)
    const a = await page.evaluate(() => window.redlog.project.create('gap-a', { network: { offline: true } }))
    await page.evaluate(() => window.redlog.httpCapture.start())
    await expect.poll(async () => (await statusOf()).state, { timeout: 40_000 }).toBe('running')
    const proxyA = await statusOf()

    // Same project: an unanswered request outlives its TTL, and the next flow
    // through the producer sweeps it into a dropped marker in A.
    void viaProxy(externalUrl, `http://127.0.0.1:${upPort}/slow?owner=a-same`)
    await expect.poll(async () => (await urls('a-same')).length, { timeout: 20_000 }).toBe(1)
    await page.waitForTimeout((TTL_SEC + 1) * 1000)
    expect(await viaProxy(externalUrl, `http://127.0.0.1:${upPort}/fast?owner=a-tick`)).toBe(200)
    await expect.poll(() => urls('a-same'), { timeout: 20_000 }).toContain('http_request_dropped')

    const managedSlow = viaProxy(proxyA.url!, `http://127.0.0.1:${upPort}/slow?owner=a-managed`)
    const externalSlow = viaProxy(externalUrl, `http://127.0.0.1:${upPort}/slow?owner=a-external`)
    void viaProxy(externalUrl, `http://127.0.0.1:${upPort}/slow?owner=a-ttl`)
    await expect.poll(async () => [...await urls('a-managed'), ...await urls('a-external'), ...await urls('a-ttl')].length, { timeout: 20_000 }).toBe(3)
    await expect.poll(() => held.size).toBe(4)

    // Switching closes A, which stops A's proxy, and opens B.
    const b = await page.evaluate(() => window.redlog.project.create('gap-b', { network: { offline: true } }))
    expect(b.id).not.toBe(a.id)
    const managedAliveAfterSwitch = proxyA.pid ? alive(proxyA.pid) : null
    expect(external.exitCode).toBeNull()

    // A's upstream answers now, late, with a cookie and a body only A may hold.
    answerLate('a-managed')
    answerLate('a-external')
    const managedOutcome = await managedSlow
    const externalOutcome = await externalSlow
    expect(externalOutcome).toBe(200)

    await page.evaluate(() => window.redlog.httpCapture.start())
    await expect.poll(async () => (await statusOf()).state, { timeout: 40_000 }).toBe('running')
    const proxyB = await statusOf()
    // a-ttl, A's and never answered, is past its TTL now: B's next flow through
    // the same producer is what sweeps it.
    await page.waitForTimeout((TTL_SEC + 1) * 1000)
    expect(await viaProxy(proxyB.url!, `http://127.0.0.1:${upPort}/fast?owner=b-managed`)).toBe(200)
    expect(await viaProxy(externalUrl, `http://127.0.0.1:${upPort}/fast?owner=b-external`)).toBe(200)
    // B is recording from both producers, so an absence below means something.
    await expect.poll(async () => [(await urls('b-managed')).length > 0, (await urls('b-external')).length > 0], { timeout: 20_000 }).toEqual([true, true])
    await page.waitForTimeout(3_000)
    // Refusals for A after the first are counted a window at a time; once the
    // window has run, the producer's next send writes them.
    expect(await viaProxy(externalUrl, `http://127.0.0.1:${upPort}/fast?owner=b-flush`)).toBe(200)
    await page.waitForTimeout(1_000)

    const bEvents = await scanner()
    expect(bEvents.filter(e => /owner=a-/.test(String(e.data.url ?? '')) || JSON.stringify(e.data).includes(MARKER))).toEqual([])
    const bDir = join(tmpHome, '.redlog', 'projects', b.id)
    expect(existsSync(bDir)).toBe(true)
    const bFiles = filesUnder(bDir)
    expect(bFiles.filter(file => readFileSync(file).includes(MARKER))).toEqual([])
    const spool = filesUnder(join(tmpHome, '.redlog', 'pending'))
    expect(spool.filter(file => readFileSync(file).includes(MARKER))).toEqual([])
    const spoolForB = spool.filter(file => { try { return JSON.parse(readFileSync(file, 'utf8'))._identity?.engagementId === b.id } catch { return false } })
    expect(spoolForB).toEqual([])

    // What A could not be given is said in A: a gap with a count and a window,
    // and nothing of what was refused.
    const switchGaps = (rows: Awaited<ReturnType<typeof scanner>>) =>
      rows.filter(e => e.data.subtype === 'capture_gap' && e.data.reason === 'project-switched')
    expect(switchGaps(bEvents)).toEqual([])
    const spoolForA = spool.filter(file => { try { return JSON.parse(readFileSync(file, 'utf8'))._identity?.engagementId === a.id } catch { return false } })
    expect(spoolForA.length).toBeGreaterThan(0)

    await page.evaluate(id => window.redlog.project.open(id), a.id)
    await expect.poll(async () => switchGaps(await scanner()).length, { timeout: 30_000 }).toBeGreaterThan(0)
    const aGaps = switchGaps(await scanner())
    expect(aGaps.every(g => g.engagementId === a.id && Number(g.data.skipped_units) > 0
      && Number(g.data.gap_started_at) <= Number(g.data.gap_ended_at))).toBe(true)
    expect(JSON.stringify(aGaps)).not.toContain(MARKER)
    expect(JSON.stringify(aGaps)).not.toMatch(/owner=a-|127\.0\.0\.1/)
    const aGapUnits = aGaps.reduce((n, g) => n + Number(g.data.skipped_units), 0)
    console.log(`[459] mitmdump ${mitmVersion()} on ${process.platform}.`
      + ` App's producer ${managedAliveAfterSwitch ? 'still alive' : 'gone'} after the switch; its late answer reached the client as ${managedOutcome}.`
      + ` External producer alive across the switch; its late answer reached the client as ${externalOutcome}.`
      + ` B holds 0 of A's events; 0 of ${bFiles.length} B files and 0 of ${spool.length} spool files carry A's bytes.`
      + ` A holds managed ${JSON.stringify(await urls('a-managed'))}, external ${JSON.stringify(await urls('a-external'))},`
      + ` swept after the switch ${JSON.stringify(await urls('a-ttl'))}, swept before it ${JSON.stringify(await urls('a-same'))};`
      + ` A holds ${aGaps.length} project-switched gap(s) for ${aGapUnits} refused event(s), B holds none.`)
  } catch (e) {
    console.log(`[DBG] ${(e as Error).message.split('\n').slice(0, 5).join(' | ')}`)
    console.log(`[DBG] external producer output tail: ${externalOutput.slice(-1500)}`)
    throw e
  } finally {
    for (const res of held.values()) res.destroy()
    if (external.pid && external.exitCode === null) hardKill(external.pid)
    await app.close()
    await close(upstream)
  }
})

test('#460 a full queue under real load: counted, not lost to a pause, said when unsaved, and partly lost to a kill', async () => {
  test.skip(!hasMitmdump(), 'Requires installed mitmdump for real source acceptance')
  test.setTimeout(240_000)
  const upstream = createServer((_req, res) => { res.writeHead(200, { 'content-type': 'text/plain' }); res.end('ok') })
  const upPort = await listen(upstream)

  // The RedLog API the addon posts to, held so its four workers block and the
  // 64 send slots fill, then let go so they drain.
  let holding = true
  const heldPosts: ServerResponse[] = []
  const api = createServer((req, res) => {
    req.resume()
    req.on('end', () => { if (holding) heldPosts.push(res); else res.end('{}') })
  })
  const apiPort = await listen(api)
  const release = (): void => { holding = false; for (const res of heldPosts.splice(0)) res.end('{}') }

  const producerHome = makeTempHome('redlog-queue-gap-')
  const redlogDir = join(producerHome, '.redlog')
  const pending = join(redlogDir, 'pending')
  mkdirSync(redlogDir, { recursive: true })
  writeFileSync(join(redlogDir, 'api-port'), String(apiPort))
  writeFileSync(join(redlogDir, 'api-token'), 'acceptance-token')

  const { app, page, tmpHome } = await launchWithTempHome()
  let output = ''
  const proxy = new ManagedHttpProxy({
    spawn: ((command: string, args: string[], options: Parameters<typeof spawn>[2]) => {
      const child = spawn(command, args, { ...options, env: { ...options?.env, HOME: producerHome, USERPROFILE: producerHome, PYTHONIOENCODING: 'utf-8', PYTHONUNBUFFERED: '1' } })
      child.stdout?.on('data', chunk => { output += String(chunk) })
      child.stderr?.on('data', chunk => { output += String(chunk) })
      return child
    }) as never
  })
  const refusals = (): number => (output.match(/\[redlog\] capture queue full/g) ?? []).length
  try {
    const project = await page.evaluate(() => window.redlog.project.create('queue-gap', { network: { offline: true } }))
    // The producer speaks for the open project, as the app's own proxy would.
    copyFileSync(join(tmpHome, '.redlog', 'active-identity.json'), join(redlogDir, 'active-identity.json'))

    const status = await proxy.start({ addonPath: ADDON, port: 18000 + Math.floor(Math.random() * 2000) })
    expect(status.state, output).toBe('running')
    // A full queue costs the record, never the client: every flow still completes.
    const load = async (tag: string, n: number): Promise<void> => {
      const outcomes = await Promise.all(Array.from({ length: n }, (_, i) =>
        viaProxy(status.url!, `http://127.0.0.1:${upPort}/load?${tag}=${i}`)))
      expect(outcomes.filter(outcome => outcome !== 200)).toEqual([])
    }
    // Let the held posts go, then one more flow: its successful send is what
    // writes whatever the open window still holds.
    const drain = async (): Promise<void> => {
      release()
      await page.waitForTimeout(1_000)
      expect(await viaProxy(status.url!, `http://127.0.0.1:${upPort}/flush`)).toBe(200)
      await page.waitForTimeout(1_000)
    }

    // Phase 1, paused: every refusal falls inside the pause.
    await page.evaluate(() => window.redlog.recording.toggle())
    holding = true
    await load('paused', 120)
    const pausedRefusals = refusals()
    expect(pausedRefusals).toBeGreaterThan(0)
    await drain()
    await page.evaluate(() => window.redlog.recording.toggle())
    const pausedGaps = filesUnder(pending)
    const pausedUnits = pausedGaps.reduce((n, f) => n + Number(JSON.parse(readFileSync(f, 'utf8')).data.skipped_units ?? 0), 0)
    expect(pausedUnits).toBe(pausedRefusals)
    const appPending = join(tmpHome, '.redlog', 'pending')
    mkdirSync(appPending, { recursive: true })
    for (const f of pausedGaps) renameSync(f, join(appPending, `paused-${f.split(/[\\/]/).pop()}`))

    // Phase 2, the spool cannot be written: the loss is only in the log, so
    // the proxy has to read it from there.
    rmSync(pending, { recursive: true, force: true })
    writeFileSync(pending, 'not a directory')
    holding = true
    const before = refusals()
    await load('unsaved', 120)
    const unsavedRefusals = refusals() - before
    await drain()
    expect(unsavedRefusals).toBeGreaterThan(0)
    expect(output).toMatch(/\[redlog\] capture gap not saved: \d+ event/)
    await expect.poll(() => proxy.status().unsavedGapEvents).toBe(unsavedRefusals)
    rmSync(pending, { force: true })
    mkdirSync(pending)

    // Phase 3, recording: refusals while the API is held, then the producer is
    // killed outright before it can flush what its open window holds.
    holding = true
    const beforeKill = refusals()
    await load('killed', 120)
    const killedRefusals = refusals() - beforeKill
    hardKill(status.pid!)
    await expect.poll(() => proxy.status().state).not.toBe('running')
    const killedGaps = filesUnder(pending)
    const killedUnits = killedGaps.reduce((n, f) => n + Number(JSON.parse(readFileSync(f, 'utf8')).data.skipped_units ?? 0), 0)
    expect(killedGaps.length).toBeGreaterThan(0)
    expect(killedUnits).toBeGreaterThan(0)
    expect(killedUnits).toBeLessThanOrEqual(killedRefusals)
    for (const f of killedGaps) renameSync(f, join(appPending, `killed-${f.split(/[\\/]/).pop()}`))
    release()

    // Reopen: the drain replays the spool. The paused gaps are not a loss.
    await page.evaluate(() => window.redlog.project.close())
    await page.evaluate(id => window.redlog.project.open(id), project.id)
    const gaps = () => page.evaluate(() => window.redlog.events.query({ agentType: 'scanner', limit: -1 })
      .then(rows => rows.filter(row => row.data.subtype === 'capture_gap' && row.data.reason === 'queue-full')))
    await expect.poll(async () => (await gaps()).reduce((n, g) => n + Number(g.data.skipped_units), 0), { timeout: 45_000 }).toBe(killedUnits)
    expect(readdirSync(appPending).filter(name => name.endsWith('.json'))).toEqual([])

    const replayed = (await gaps()).map(g => g.data.skipped_units)
    console.log(`[460] mitmdump ${mitmVersion()} on ${process.platform}, send queue 64 slots / 4 workers, 120 concurrent flows per phase:`
      + ` paused ${pausedRefusals} refused -> ${pausedGaps.length} gap file(s), ${pausedUnits} units, all dropped on replay;`
      + ` unsaved ${unsavedRefusals} refused -> unsavedGapEvents ${proxy.status().unsavedGapEvents};`
      + ` killed ${killedRefusals} refused -> ${killedGaps.length} gap file(s), ${killedUnits} units written, ${killedRefusals - killedUnits} lost to the kill;`
      + ` replayed queue-full gaps ${JSON.stringify(replayed)}`)
  } catch (e) {
    console.log(`[DBG] ${(e as Error).message.split('\n').slice(0, 5).join(' | ')}`)
    console.log(`[DBG] producer output tail: ${output.slice(-1500)}`)
    throw e
  } finally {
    release()
    proxy.stop()
    await app.close()
    await close(api)
    await close(upstream)
  }
})
