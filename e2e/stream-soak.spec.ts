import { test, expect, type Page } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import os from 'node:os'
import { launchWithTempHome, requireMitmdump, REPO_ROOT } from './helpers'
import { startStreamSources, proxiedGet, proxiedWebSocket, treeRss, hardKill, sseEvent } from './stream-sources'

/**
 * #290 soak: hours of SSE and bidirectional WebSocket through the app's own
 * mitmdump, then a hard kill of the producer and an app restart.
 *
 * Opt-in only (it runs for as long as it is told to):
 *
 *   REDLOG_SOAK_MINUTES=120 npx playwright test e2e/stream-soak.spec.ts --reporter=line
 *
 * The memory budget is fixed before the run, from the environment, and the
 * run fails when it is exceeded rather than reporting a curve and leaving the
 * judgement to whoever reads it:
 *
 *   REDLOG_SOAK_APP_GROWTH_MIB   App (all Electron processes) growth after warm-up, default 64
 *   REDLOG_SOAK_MITM_GROWTH_MIB  mitmdump process tree growth after warm-up, default 64
 *   REDLOG_SOAK_WS_BYTES         size of each pushed binary frame, default 4096
 *   REDLOG_SOAK_WS_PUSH_MS       push interval, default 1000
 *   REDLOG_SOAK_SSE_MS           SSE event interval, default 1000
 *   REDLOG_SOAK_OUT              results file (JSON), default test-results/stream-soak-<time>.json
 *
 * Warm-up is the first tenth of the run. Samples go to <out>.samples.jsonl as
 * they are taken, so a run that dies still leaves its curve.
 */
const minutes = Number(process.env.REDLOG_SOAK_MINUTES ?? 0)
const env = (key: string, fallback: number): number => Number(process.env[key] ?? fallback)

test.skip(!minutes, 'opt-in: set REDLOG_SOAK_MINUTES')

const MiB = 1 << 20

async function scanner(page: Page, subtype: string): Promise<Array<{ id: string; data: Record<string, any> }>> {
  return page.evaluate(s => window.redlog.events.query({ agentType: 'scanner', limit: -1 })
    .then(rows => rows.filter(row => row.data.subtype === s).map(row => ({ id: row.id, data: row.data }))), subtype)
}

async function appRss(app: import('@playwright/test').ElectronApplication): Promise<number> {
  return app.evaluate(({ app }) => app.getAppMetrics().reduce((sum, m) => sum + m.memory.workingSetSize * 1024, 0))
}

function version(cmd: string, args: string[]): string {
  try { return execFileSync(cmd, args, { encoding: 'utf8', cwd: REPO_ROOT }).trim().split(/\r?\n/).join(' | ') }
  catch (e) { return `unavailable: ${(e as Error).message.split('\n')[0]}` }
}

test('long SSE and WebSocket stay saved within budget, then survive a producer kill and an app restart', async () => {
  requireMitmdump()
  const durationMs = minutes * 60_000
  test.setTimeout(durationMs + 10 * 60_000)
  const budget = { appGrowthMiB: env('REDLOG_SOAK_APP_GROWTH_MIB', 64), mitmGrowthMiB: env('REDLOG_SOAK_MITM_GROWTH_MIB', 64) }
  const shape = { sseMs: env('REDLOG_SOAK_SSE_MS', 1000), ssePad: 512, wsPushMs: env('REDLOG_SOAK_WS_PUSH_MS', 1000), wsBytes: env('REDLOG_SOAK_WS_BYTES', 4096) }
  const out = process.env.REDLOG_SOAK_OUT ?? join(REPO_ROOT, 'test-results', `stream-soak-${new Date().toISOString().replace(/[:.]/g, '-')}.json`)
  mkdirSync(dirname(out), { recursive: true })
  const samplesFile = out.replace(/\.json$/, '') + '.samples.jsonl'
  const result: Record<string, any> = {
    minutes, budget, shape,
    os: `${os.platform()} ${os.release()} ${os.arch()}`,
    node: process.version,
    mitmdump: version('mitmdump', ['--version']),
    commit: version('git', ['rev-parse', 'HEAD']),
    dirty: version('git', ['status', '--porcelain', '--untracked-files=no']) !== '',
    // The addon mitmdump actually loaded, so a run on a dirty tree still says
    // which producer it measured.
    addonSha256: createHash('sha256').update(readFileSync(join(REPO_ROOT, 'hooks', 'mitmproxy-addon.py'))).digest('hex'),
    packagedApp: process.env.REDLOG_PACKAGED_APP ?? null,
    startedAt: new Date().toISOString()
  }
  const save = (): void => writeFileSync(out, JSON.stringify(result, null, 2))

  const sources = await startStreamSources()
  let { app, page, tmpHome } = await launchWithTempHome(process.env.REDLOG_PACKAGED_APP)
  let ws: import('ws').WebSocket | undefined
  let sse: ReturnType<typeof proxiedGet> | undefined
  try {
    const project = await page.evaluate(() => window.redlog.project.create('stream-soak', { network: { offline: true } }))
    await page.evaluate(() => window.redlog.httpCapture.start())
    await expect.poll(() => page.evaluate(() => window.redlog.httpCapture.status().then(s => s.state)), { timeout: 30_000 }).toBe('running')
    const status = await page.evaluate(() => window.redlog.httpCapture.status())
    const proxy = new URL(status.url!)
    const mitmPid = status.pid as number
    result.proxy = { url: status.url, pid: mitmPid }

    // One-shot shapes first: a body over the 10 MiB cap, a slow non-SSE
    // trickle and a broken response. Each is checked after the soak.
    const large = proxiedGet(proxy, sources.url('/large?bytes=' + 16 * MiB))
    const slow = proxiedGet(proxy, sources.url('/slow?chunks=20&interval=1000'))
    const broken = proxiedGet(proxy, sources.url('/disconnect'))

    sse = proxiedGet(proxy, sources.url(`/sse?interval=${shape.sseMs}&pad=${shape.ssePad}`))
    ws = await proxiedWebSocket(proxy, sources.url(`/ws?push=${shape.wsPushMs}&size=${shape.wsBytes}`))
    const wsSeen = { clientText: 0, clientBinary: 0, serverFrames: 0 }
    ws.on('message', () => { wsSeen.serverFrames++ })
    const sendTimer = setInterval(() => {
      if (ws?.readyState !== 1) return
      wsSeen.clientText++
      ws.send(`client ${wsSeen.clientText} 中文`)
      if (wsSeen.clientText % 5 === 0) { wsSeen.clientBinary++; ws.send(Buffer.from([0, 255, 27, 10, wsSeen.clientBinary & 0xff]), { binary: true }) }
    }, 2000)

    // Saved counts come from the flow's own completion query once its id is
    // known: loading every scanner row each minute would put the soak's own
    // reads into the App memory it is measuring.
    const flows = { sse: '', ws: '' }
    const saved = async (kind: 'sse' | 'ws'): Promise<number> => {
      if (!flows[kind]) flows[kind] = String((await scanner(page, kind === 'sse' ? 'http_response_chunk' : 'ws_message'))[0]?.data.flow_id ?? '')
      if (!flows[kind]) return 0
      return (await page.evaluate(id => window.redlog.events.streamCompletion(id), flows[kind]))?.saved ?? 0
    }
    const samples: Array<Record<string, number>> = []
    const started = Date.now()
    const sampleEvery = Math.min(60_000, Math.max(5_000, durationMs / 20))
    while (Date.now() - started < durationMs) {
      await page.waitForTimeout(Math.min(sampleEvery, durationMs - (Date.now() - started)))
      const sample = {
        t: Math.round((Date.now() - started) / 1000),
        appRss: await appRss(app),
        mitmRss: treeRss(mitmPid),
        sseBytesReceived: sse.received.bytes,
        wsFramesReceived: wsSeen.serverFrames,
        sseChunksSaved: await saved('sse'),
        wsMessagesSaved: await saved('ws')
      }
      samples.push(sample)
      appendFileSync(samplesFile, JSON.stringify(sample) + '\n')
    }
    clearInterval(sendTimer)
    result.samples = samples.length

    // Budget: growth from the end of warm-up to the last sample.
    const warm = samples[Math.floor(samples.length / 10)] ?? samples[0]
    const last = samples[samples.length - 1]
    const peak = (key: string): number => Math.max(...samples.map(s => s[key]))
    result.memory = {
      appWarmMiB: +(warm.appRss / MiB).toFixed(1), appLastMiB: +(last.appRss / MiB).toFixed(1), appPeakMiB: +(peak('appRss') / MiB).toFixed(1),
      mitmWarmMiB: +(warm.mitmRss / MiB).toFixed(1), mitmLastMiB: +(last.mitmRss / MiB).toFixed(1), mitmPeakMiB: +(peak('mitmRss') / MiB).toFixed(1)
    }
    result.memory.appGrowthMiB = +(result.memory.appLastMiB - result.memory.appWarmMiB).toFixed(1)
    result.memory.mitmGrowthMiB = +(result.memory.mitmLastMiB - result.memory.mitmWarmMiB).toFixed(1)
    save()

    // One-shots: the over-cap body is truncated with its total known; the
    // broken one is an error, not an empty success.
    const responses = await scanner(page, 'http_response')
    const largeRow = responses.find(r => String(r.data.url ?? '').includes('/large'))
    result.large = { clientBytes: large.received.bytes, saved: largeRow ? { size: largeRow.data.response_body?.size ?? largeRow.data.response_body_ref?.size, truncated: largeRow.data.response_body?.truncated ?? largeRow.data.response_body_ref?.truncated } : null }
    result.slow = { clientBytes: slow.received.bytes, saved: responses.some(r => String(r.data.url ?? '').includes('/slow')) }
    result.disconnect = { clientError: broken.received.error ?? null, errors: (await scanner(page, 'http_error')).filter(r => String(r.data.url ?? '').includes('/disconnect')).length }

    // Fault: kill the producer mid-stream. Nothing it holds in memory can be
    // written after this; what was saved must stay saved and read as unknown.
    const beforeKill = {
      sseBytesReceived: sse.received.bytes,
      sseChunksSaved: (await scanner(page, 'http_response_chunk')).length,
      wsMessagesSaved: (await scanner(page, 'ws_message')).length,
      wsClientSent: wsSeen.clientText + wsSeen.clientBinary,
      wsServerReceived: wsSeen.serverFrames
    }
    hardKill(mitmPid)
    // Requests already in flight to the API still land after the kill; wait
    // until the saved counts stop moving, then take them as the saved prefix.
    let settled = ''
    for (let previous = ''; ; previous = settled) {
      await page.waitForTimeout(2000)
      settled = `${(await scanner(page, 'http_response_chunk')).length}/${(await scanner(page, 'ws_message')).length}`
      if (settled === previous) break
    }
    const chunks = await scanner(page, 'http_response_chunk')
    const flowId = String(chunks[0]?.data.flow_id ?? '')
    const wsFlow = String((await scanner(page, 'ws_message'))[0]?.data.flow_id ?? '')
    result.kill = {
      ...beforeKill,
      sseChunksSettled: chunks.length,
      wsMessagesSettled: (await scanner(page, 'ws_message')).length,
      sseCompletion: await page.evaluate(id => window.redlog.events.streamCompletion(id), flowId),
      wsCompletion: await page.evaluate(id => window.redlog.events.streamCompletion(id), wsFlow)
    }
    save()

    // Restart: same HOME, reopen the project, read back what was saved.
    await app.close()
    ;({ app, page } = await launchWithTempHome(process.env.REDLOG_PACKAGED_APP, { home: tmpHome }))
    await page.evaluate(id => window.redlog.project.open(id), (project as { id: string }).id)
    const afterChunks = await scanner(page, 'http_response_chunk')
    const seqs = afterChunks.filter(r => r.data.flow_id === flowId).map(r => Number(r.data.seq)).sort((a, b) => a - b)
    const savedSse = Buffer.concat(afterChunks.filter(r => r.data.flow_id === flowId).sort((a, b) => a.data.seq - b.data.seq)
      .map(r => r.data.response_body ? Buffer.from(r.data.response_body.data, 'base64') : Buffer.alloc(0)))
    result.restart = {
      sseChunks: seqs.length,
      sseSeqGaps: seqs.filter((s, i) => i > 0 && s !== seqs[i - 1] + 1).length,
      sseDuplicates: seqs.length - new Set(seqs).size,
      sseCompletion: await page.evaluate(id => window.redlog.events.streamCompletion(id), flowId),
      wsMessages: (await scanner(page, 'ws_message')).filter(r => r.data.flow_id === wsFlow).length,
      wsCompletion: await page.evaluate(id => window.redlog.events.streamCompletion(id), wsFlow)
    }
    // Inline chunk bodies must be a byte-exact prefix of what the client got.
    // Sidecar-held chunks are checked through the HAR below instead.
    const exported = await page.evaluate(async () => {
      const config = await window.redlog.config.get()
      await window.redlog.config.save({ ...config!, scope: { ...config!.scope, personalDomains: [] } })
      const plan = await window.redlog.data.resolveExportPlan({ format: 'har' })
      if (!plan.ok) throw new Error(String(plan.error))
      return window.redlog.data.executeExportPlan({ planId: plan.plan.id })
    })
    if (!exported.ok) throw new Error('HAR export failed')
    const har = JSON.parse(readFileSync(exported.artifactPath, 'utf8'))
    const harChunks = har.log.entries.flatMap((e: any) => e._redlog?.streamChunks ?? []).concat((har.log._redlog?.partialFlows ?? []).flatMap((f: any) => f.streamChunks ?? []))
    const harSse = Buffer.concat(harChunks.map((p: any) => p.body.encoding === 'base64' ? Buffer.from(p.body.text, 'base64') : Buffer.from(p.body.text, 'utf8')))
    const clientSse = Buffer.from(sse.received.text(), 'utf8')
    // Either side can be longer after a kill: a chunk saved but never
    // forwarded, or forwarded while its event was still queued and lost. Over
    // the length both have, the bytes must be the same.
    const common = Math.min(harSse.length, clientSse.length)
    let mismatchAt = -1
    for (let i = 0; i < common; i++) if (harSse[i] !== clientSse[i]) { mismatchAt = i; break }
    result.export = {
      harSseBytes: harSse.length,
      clientSseBytes: clientSse.length,
      sseMismatchAt: mismatchAt,
      harSseAgreesWithClient: common > 0 && mismatchAt === -1,
      harWsMessages: har.log.entries.flatMap((e: any) => e._redlog?.webSocketMessages ?? []).length + (har.log._redlog?.partialFlows ?? []).flatMap((f: any) => f.webSocketMessages ?? []).length,
      inlineSavedBytes: savedSse.length
    }
    result.firstEventSample = sseEvent(1, 0).length
    result.finishedAt = new Date().toISOString()
    save()

    expect(result.restart.sseChunks, 'saved SSE prefix survives the restart').toBe(result.kill.sseChunksSettled)
    expect(result.restart.wsMessages, 'saved WS messages survive the restart').toBe(result.kill.wsMessagesSettled)
    expect(result.restart.sseDuplicates).toBe(0)
    expect(result.restart.sseSeqGaps, 'no hole inside the saved prefix').toBe(0)
    expect(result.restart.sseCompletion?.state).toBe('completion-unknown')
    expect(result.restart.wsCompletion?.state).toBe('completion-unknown')
    expect(result.export.harSseAgreesWithClient, 'exported SSE bytes are what the client received').toBe(true)
    expect(result.memory.appGrowthMiB, 'App memory within the agreed budget').toBeLessThanOrEqual(budget.appGrowthMiB)
    expect(result.memory.mitmGrowthMiB, 'mitmdump memory within the agreed budget').toBeLessThanOrEqual(budget.mitmGrowthMiB)
  } catch (e) {
    result.error = (e as Error).message.split('\n').slice(0, 5).join(' | ')
    result.captureStatus = await page.evaluate(() => window.redlog.httpCapture.status()).catch(() => null)
    console.log(`[SOAK] ${result.error}`, result.captureStatus)
    throw e
  } finally {
    save()
    console.log(`[SOAK] results: ${out}`)
    ws?.terminate(); sse?.abort()
    await sources.close()
    await app.close().catch(() => {})
  }
})
