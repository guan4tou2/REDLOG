import { test, expect } from '@playwright/test'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { launchWithTempHome, openTestProject, openView, resizeMainWindow } from './helpers'
import en from '../src/renderer/src/i18n/en.json'
import zh from '../src/renderer/src/i18n/zh-TW.json'

// Deliberate IPC failures get their own isolated process. Reuse it for the
// entire read-state journey; do not contaminate installed capture acceptance.
test('empty, pending and failed reads remain distinguishable and recoverable at high zoom', async ({}, info) => {
  test.setTimeout(120_000)
  const { app, page } = await launchWithTempHome()
  const win = await app.browserWindow(page)
  try {
    await openTestProject(page, 'read-state-layout')
    const sources = [
      { view: 'bookmarks', channel: 'bookmarks:list', empty: [], key: 'bookmarks.empty', error: 'bookmarks-load-error' },
      { view: 'screenshots', channel: 'events:queryScreenshotPage', empty: { items: [], hasMore: false, nextCursor: null }, key: 'screenshots.empty', error: 'screenshots-load-error' },
      { view: 'http_history', channel: 'events:queryHttpFlowPage', empty: { items: [], flowCount: 0, hasMore: false, nextCursor: null }, key: 'httpHistory.empty', error: 'http-load-error' }
    ] as const
    async function answer(channel: string, value: unknown, fail = false, pending = false) {
      await app.evaluate(({ ipcMain }, a) => {
        ipcMain.removeHandler(a.channel)
        ipcMain.handle(a.channel, () => {
          if (a.fail) throw new Error('Synthetic unavailable database: ' + 'long-path/'.repeat(45))
          if (a.pending) return new Promise(resolve => {
            ;(globalThis as unknown as { layoutRead: () => void }).layoutRead = () => resolve(a.value)
          })
          return a.value
        })
      }, { channel, value, fail, pending })
    }
    const matrix: unknown[] = []
    for (const [locale, strings] of [['en', en], ['zh-TW', zh]] as const) {
      await page.evaluate(l => localStorage.setItem('redlog-locale', l), locale)
      await page.reload()
      for (const source of sources) {
        await answer(source.channel, source.empty, false, true)
        await openView(page, source.view)
        await expect(page.getByRole('status').filter({ hasText: strings['common.loading'] })).toBeVisible()
        await expect(page.getByText(strings[source.key], { exact: false })).toHaveCount(0)
        await app.evaluate(() => (globalThis as unknown as { layoutRead: () => void }).layoutRead())
        await expect(page.getByText(strings[source.key], { exact: false })).toBeVisible()
        for (const [width, height, zoom] of [[1280, 800, 1], [800, 600, 2]]) {
          await resizeMainWindow(app, width, height)
          await win.evaluate((w, z) => w.webContents.setZoomFactor(z), zoom)
          const empty = page.getByText(strings[source.key], { exact: false })
          await empty.scrollIntoViewIfNeeded()
          await expect(empty).toBeInViewport()
          matrix.push({ locale, view: source.view, state: 'empty', width, height, zoom })
        }
        await answer(source.channel, source.empty, true)
        await openView(page, 'dashboard')
        await openView(page, source.view)
        const error = page.getByTestId(source.error)
        await expect(error).toBeVisible()
        await expect(page.getByText(strings[source.key], { exact: false })).toHaveCount(0)
        const retry = error.getByRole('button', { name: strings['common.retry'], exact: true })
        await retry.scrollIntoViewIfNeeded()
        await expect(retry).toBeInViewport()
        expect(await page.getByTestId('view-root').evaluate(el => el.scrollWidth <= el.clientWidth + 2)).toBe(true)
        const capture = await win.evaluate(async w => (await w.capturePage()).toPNG().toString('base64'))
        writeFileSync(info.outputPath(`${locale}-${source.view}-error-800-2.png`), Buffer.from(capture, 'base64'))
        matrix.push({ locale, view: source.view, state: 'error', width: 800, height: 600, zoom: 2 })
        await answer(source.channel, source.empty)
        await retry.click()
        await expect(error).toHaveCount(0)
        await expect(page.getByText(strings[source.key], { exact: false })).toBeVisible()
        // At 200%, the source's recovery/setup action must also be reachable.
        if (source.view === 'bookmarks') {
          await page.getByRole('button', { name: strings['bookmarks.quickCapture'], exact: true }).click()
          await expect(page.getByRole('textbox', { name: strings['bookmarks.fieldTitle'], exact: true })).toBeVisible()
          await page.getByRole('button', { name: strings['bookmarks.cancel'], exact: true }).click()
        }
        await resizeMainWindow(app, 1280, 800)
        await win.evaluate(w => w.webContents.setZoomFactor(1))
      }
      await answer('events:distinctAgentTypes', [], true)
      await page.reload()
      await openView(page, 'http_history')
      await page.locator('button[aria-controls="filter-bar-panel"]').click()
      const error = page.getByTestId('filter-lists-error')
      await expect(error).toBeVisible()
      await resizeMainWindow(app, 800, 600)
      await win.evaluate(w => w.webContents.setZoomFactor(2))
      const retry = error.getByRole('button', { name: strings['filter.listsRetry'], exact: true })
      await retry.scrollIntoViewIfNeeded()
      await expect(retry).toBeInViewport()
      await answer('events:distinctAgentTypes', [])
      await retry.click()
      await expect(error).toHaveCount(0)
      await resizeMainWindow(app, 1280, 800)
      await win.evaluate(w => w.webContents.setZoomFactor(1))
    }
    writeFileSync(info.outputPath('read-states.json'), JSON.stringify(matrix, null, 2))
  } catch (error) {
    console.error('[read-state-layout]', (error as Error).message)
    await page.screenshot({ path: info.outputPath('failure.png') }).catch(() => {})
    throw error
  } finally { await app.close() }
})

// The first journey proved the three shared-list-loader sources. This one goes
// after the view-specific loaders the first journey does not reach, so that a
// view confusing "empty" with "failed" fails here:
//
// - timeline   — read events:queryPage → spinner / timeline-empty-filtered
//                (the default-filter empty; noEvents is the no-conditions
//                branch) / timeline-load-failed + retry (FR-010 contract)
// - transcript — same channel → transcript.loading / transcript.empty /
//                transcript-load-error + retry
// - targets    — read events:aggregateTargets → held empty UI (no spinner by
//                design) / targets.empty / targets-load-error + retry; the
//                partial state is scope: the main read succeeds while
//                config:get fails → targets-scope-failed + its own retry
// - loot       — read events:queryPage → spinner / loot.empty /
//                loot-load-error + retry
// - scope      — read scope:getObservationCount (+ 4 siblings in one Promise.all)
//                → spinner / scope.observationsTitle heading / scope.loadFailed + retry
// - dashboard  — the only distinguishable read is the aggregator's:
//                config:get pending → dashboard-loading; and the partial
//                state a dashboard-with-data renders — a seeded command makes
//                the project non-first-run, scope counts fail on mount and the
//                issue store surfaces dashboard-issue-scope; the row's fix
//                button ("recheck scope") is the real recovery path, so the
//                leg ends through it, with the unknown title gone.
//
// terminal is deliberately absent: ptx opens instantly and terminal:list is
// read-to-adopt-or-fallback with no empty / pending / error surface of its
// own (any failure just opens one more shell tab) — there is no read-state
// contract to pin down. search's partial reads are pinned in ui-closeout
// (search-index-status / search-types-failed / search-partial-warning), not
// duplicated here.
//
// One isolated app for the whole journey (same reasoning as the first test),
// one temp-home project, both locales, each leg stubbing the channel it reads
// and leaving only plain values behind so no later leg inherits a fault.
test('remaining views distinguish pending, empty, failed and partial reads', async ({}, info) => {
  test.setTimeout(240_000)
  const { app, page, tmpHome } = await launchWithTempHome()
  const win = await app.browserWindow(page)
  try {
    await openTestProject(page, 'read-state-matrix')
    const base = `http://127.0.0.1:${readFileSync(join(tmpHome, '.redlog', 'api-port'), 'utf-8').trim()}`
    const token = readFileSync(join(tmpHome, '.redlog', 'api-token'), 'utf-8').trim()
    // The seed path is documented in e2e/README.md: it goes through the app's
    // own ingest port. One captured command is enough so the dashboard leaves
    // its first-run branch (which renders no issue store) for the partial leg.
    const seed = (agentType: string, data: Record<string, unknown>): Promise<Response> =>
      fetch(`${base}/api/events/seed`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({ agent_type: agentType, data })
      })
    async function answer(channel: string, value: unknown, fail = false, pending = false): Promise<void> {
      await app.evaluate(({ ipcMain }, a) => {
        ipcMain.removeHandler(a.channel)
        ipcMain.handle(a.channel, () => {
          if (a.fail) throw new Error('Synthetic unavailable database: ' + 'long-path/'.repeat(45))
          if (a.pending) {
            // Every call to this handler while it is pending pushes its own
            // resolver onto the queue — a journey view read through
            // Promise.all (transcript's buckets, scope's five channels)
            // produces several at once, and the first release must answer
            // all of them, not just the one installed last.
            return new Promise<unknown>(resolve => {
              const holder = globalThis as unknown as { layoutReadMatrix?: Array<() => void> }
              ;(holder.layoutReadMatrix ??= []).push(() => resolve(a.value))
            })
          }
          return a.value
        })
      }, { channel, value, fail, pending })
    }
    async function releaseOne(): Promise<void> {
      await app.evaluate(() => {
        const holder = globalThis as unknown as { layoutReadMatrix?: Array<() => void> }
        const resolvers = holder.layoutReadMatrix ?? []
        holder.layoutReadMatrix = []
        for (const resolve of resolvers) resolve()
      })
    }
    const emptyPage = { items: [], hasMore: false, nextCursor: null }
    for (const [locale, strings] of [['en', en], ['zh-TW', zh]] as const) {
      await page.evaluate(l => localStorage.setItem('redlog-locale', l), locale)
      await page.reload()
      await page.waitForLoadState('domcontentloaded')

      // Dashboard: the aggregator holds loading while its own read is pending.
      const realConfig = await page.evaluate(() => (window as { redlog: { config: { get: () => Promise<unknown> } } }).redlog.config.get())
      await answer('config:get', realConfig, false, true)
      await openView(page, 'screenshots')
      await openView(page, 'dashboard')
      await expect(page.getByTestId('dashboard-loading')).toBeVisible()
      await releaseOne()
      await expect(page.getByTestId('dashboard-loading')).toHaveCount(0)

      // Targets: no spinner by design ("holds the empty state until the first
      // aggregation resolves"), so pending asserts that neither empty nor
      // error is showing. Then empty → error + retry → recovery.
      const targetsRoot = page.getByTestId('view-root')
      const targetsEmpty = targetsRoot.getByText(strings['targets.empty'], { exact: false })
      await answer('events:aggregateTargets', [], false, true)
      await openView(page, 'targets')
      await expect(targetsEmpty).toHaveCount(0)
      await expect(page.getByTestId('targets-load-error')).toHaveCount(0)
      await releaseOne()
      await expect(targetsEmpty).toBeVisible()
      await answer('events:aggregateTargets', [], true)
      await openView(page, 'dashboard')
      await openView(page, 'targets')
      const targetsError = page.getByTestId('targets-load-error')
      await expect(targetsError).toBeVisible()
      await expect(targetsEmpty).toHaveCount(0)
      await answer('events:aggregateTargets', [])
      await targetsError.getByRole('button', { name: strings['common.retry'], exact: true }).click()
      await expect(targetsError).toHaveCount(0)
      await expect(targetsEmpty).toBeVisible()
      // Partial: the main read succeeds (real handler restored to [] reads),
      // the scope config read fails, and the unsigned in-scope field shows as
      // its own status line — with scope's retry, not the list's.
      await answer('config:get', realConfig, true)
      await answer('events:aggregateTargets', [])
      await openView(page, 'dashboard')
      await openView(page, 'targets')
      const scopeFailed = page.getByTestId('targets-scope-failed')
      await expect(scopeFailed).toBeVisible()
      await expect(scopeFailed.getByText(strings['targets.scopeFailed'], { exact: false })).toBeVisible()
      await answer('config:get', realConfig)
      await scopeFailed.getByRole('button', { name: strings['common.retry'], exact: true }).click()
      await expect(scopeFailed).toHaveCount(0)

      // Loot: spinner on the first read, then empty, then error through the
      // same testid the list uses for both initial and older-page failures —
      // this leg pins the initial one (loot.loadFailed).
      const lootRoot = page.getByTestId('view-root')
      const lootEmpty = lootRoot.getByText(strings['loot.empty'], { exact: false })
      await answer('events:queryPage', emptyPage, false, true)
      await openView(page, 'loot')
      await expect(lootRoot.locator('[role="status"]').first()).toBeVisible()
      await expect(lootEmpty).toHaveCount(0)
      await releaseOne()
      await expect(lootEmpty).toBeVisible()
      await answer('events:queryPage', emptyPage, true)
      await openView(page, 'dashboard')
      await openView(page, 'loot')
      const lootError = page.getByTestId('loot-load-error')
      await expect(lootError).toBeVisible()
      await expect(lootError.getByText(strings['loot.loadFailed'], { exact: false })).toBeVisible()
      await answer('events:queryPage', emptyPage)
      await lootError.getByRole('button', { name: strings['common.retry'], exact: true }).click()
      await expect(lootError).toHaveCount(0)
      await expect(lootEmpty).toBeVisible()

      // Timeline: one channel for list and status, so the empties are
      // distinguishable, not aliases of each other (FR-010). Live admission is
      // the one path that bypasses a stubbed channel — rows join the map
      // through events:matchIds directly — so it must be pinned too: on a
      // host where the managed proxy starts (or fails to), that system event
      // would otherwise land in a timeline that is supposed to show an
      // unreconciled pending or empty read. It stays stubbed to the end of
      // the journey; no later leg admits rows by match.
      //
      // The default project filter keeps active conditions (chained-only,
      // non-work hidden), so an empty read inside default settings renders
      // timeline-empty-filtered, not timeline.noEvents — that one is the
      // no-conditions branch. Both stand before the failure branch, which is
      // what the matrix needs: pending spinner, then a real empty, then a
      // real failure.
      await answer('events:matchIds', [])
      await answer('events:queryPage', emptyPage, false, true)
      await openView(page, 'timeline')
      const timelineEmpty = page.getByTestId('timeline-empty-filtered')
      await expect(page.getByRole('status').filter({ hasText: strings['common.loading'] })).toBeVisible()
      await expect(timelineEmpty).toHaveCount(0)
      await releaseOne()
      await expect(timelineEmpty).toBeVisible()
      await answer('events:queryPage', emptyPage, true)
      await openView(page, 'dashboard')
      await openView(page, 'timeline')
      const timelineError = page.getByTestId('timeline-load-failed')
      await expect(timelineError).toBeVisible()
      await expect(timelineEmpty).toHaveCount(0)
      await answer('events:queryPage', emptyPage)
      await timelineError.getByRole('button', { name: strings['common.retry'], exact: true }).click()
      await expect(timelineError).toHaveCount(0)
      await expect(timelineEmpty).toBeVisible()

      // Transcript: the same channel, another view, another error contract.
      const transcriptRoot = page.getByTestId('view-root')
      const transcriptEmpty = transcriptRoot.getByText(strings['transcript.empty'], { exact: false })
      await answer('events:queryPage', emptyPage, false, true)
      await openView(page, 'transcript')
      await expect(transcriptRoot.getByText(strings['transcript.loading'], { exact: false })).toBeVisible()
      await expect(transcriptEmpty).toHaveCount(0)
      await releaseOne()
      await expect(transcriptEmpty).toBeVisible()
      await answer('events:queryPage', emptyPage, true)
      // The Activity workspace keeps its read state across a trip to another
      // view (#589), so leaving and re-entering no longer re-reads. A reload
      // is the fresh mount that meets the failing channel.
      await page.reload()
      await page.waitForLoadState('domcontentloaded')
      await openView(page, 'transcript')
      const transcriptError = page.getByTestId('transcript-load-error')
      await expect(transcriptError).toBeVisible()
      await expect(transcriptEmpty).toHaveCount(0)
      await answer('events:queryPage', emptyPage)
      await transcriptError.getByRole('button', { name: strings['common.retry'], exact: true }).click()
      await expect(transcriptError).toHaveCount(0)
      await expect(transcriptEmpty).toBeVisible()

      // Scope: a three-channel Promise.all → pending when ANY member hangs,
      // failed when any rejects (scope.loadFailed), loaded = the observations heading.
      const scopeRoot = page.getByTestId('view-root')
      const scopeEmpty = scopeRoot.getByRole('heading', { name: strings['scope.observationsTitle'] })
      await answer('scope:getObservationCount', 0, false, true)
      await openView(page, 'scope')
      await expect(scopeRoot.locator('[role="status"]').first()).toBeVisible()
      await expect(scopeEmpty).toHaveCount(0)
      await releaseOne()
      // Restore the pending channel to a plain value before the fail leg.
      await answer('scope:getObservationCount', 0)
      await expect(scopeEmpty).toBeVisible()
      // The page is isConfigured + getObservations + getObservationCount. The
      // chain length and the last recompute are read on their own since #691:
      // one of those failing leaves its part out, not the page.
      await answer('scope:getObservationCount', 0, true)
      await openView(page, 'dashboard')
      await openView(page, 'scope')
      const scopeError = scopeRoot.locator('[role="alert"]')
      await expect(scopeError).toBeVisible()
      await expect(scopeError.getByText(strings['scope.loadFailed'], { exact: false })).toBeVisible()
      await answer('scope:getObservationCount', 0)
      await scopeError.getByRole('button', { name: strings['common.retry'], exact: true }).click()
      await expect(scopeError).toHaveCount(0)
      await expect(scopeEmpty).toBeVisible()

      // Dashboard partial: a project with data renders the issue store, so a
      // failed scope read becomes dashboard-issue-scope, not a zero tile.
      // The row's own fix button is the recovery: recheck re-reads, so the
      // unknown title goes and the unset-scope pending state raises instead —
      // a change of tier, not a disappearance.
      await seed('shell', { subtype: 'command_end', command: 'id', exit_code: 0 })
      await answer('scope:getObservationCount', 0, true)
      await answer('scope:isConfigured', false, true)
      await page.reload()
      await page.waitForLoadState('domcontentloaded')
      const issue = page.getByTestId('dashboard-issue-scope')
      await expect(issue).toBeVisible()
      await expect(issue.getByText(strings['issues.scopeUnknown'], { exact: false })).toBeVisible()
      await answer('scope:getObservationCount', 0)
      await answer('scope:isConfigured', false)
      await page.getByTestId('dashboard-issue-fix-scope').click()
      await expect(page.getByText(strings['issues.scopeUnknown'], { exact: false })).toHaveCount(0)
      await expect(issue.getByText(strings['issues.scopeUnset'], { exact: false })).toBeVisible()
    }
  } catch (error) {
    console.error('[read-state-matrix]', (error as Error).message)
    await page.screenshot({ path: info.outputPath('failure-matrix.png') }).catch(() => {})
    throw error
  } finally { await app.close() }
})
