import { test, expect } from '@playwright/test'
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { launchWithTempHome, openTestProject, openView } from './helpers'

test('a live shell survives picker and project switches with separate verifiable recordings', async () => {
  test.skip(process.platform === 'win32', 'POSIX shell interaction; native PowerShell acceptance has its own matrix')
  test.setTimeout(90_000)
  const { app, page, tmpHome } = await launchWithTempHome(process.env.REDLOG_PACKAGED_APP)
  try {
    await page.evaluate(() => localStorage.setItem('redlog-locale', 'en'))
    const b = await openTestProject(page, 'rotation-B')
    const a = await openTestProject(page, 'rotation-A')
    await openView(page, 'terminal')
    await expect.poll(() => page.evaluate(async () => (await window.redlog.terminal.list()).length)).toBe(1)
    const pane = await page.evaluate(async () => (await window.redlog.terminal.list())[0])
    await expect.poll(() => page.evaluate(async () => (await window.redlog.events.query({ agentType: 'shell', limit: -1 })).some(e => e.data.subtype === 'session_start' && e.data.source === 'builtin-terminal'))).toBe(true)
    // Wait for enrollment injection, then use the actual PTY rather than seed
    // rows: cwd and a command in flight must survive the boundary.
    await page.waitForTimeout(900)
    const cwd = path.join(tmpHome, 'loot'); fs.mkdirSync(cwd)
    await page.evaluate(({ id, dir }) => window.redlog.terminal.write(id, `cd '${dir}'; printf 'A-only\\n'\r`), { id: pane.id, dir: cwd })
    await expect.poll(() => page.evaluate(async () => (await window.redlog.events.query({ agentType: 'shell', limit: -1 })).some(e => e.data.subtype === 'command_end' && String(e.data.command).includes('A-only')))).toBe(true)
    await page.evaluate(id => window.redlog.terminal.write(id, "printf 'OLD_SCROLL_SENTINEL\\n'; for n in {1..240}; do printf 'padding-%03d %080d\\n' $n $n; done\r"), pane.id)
    await expect.poll(() => page.evaluate(async () => (await window.redlog.events.query({ agentType: 'shell', limit: -1 })).some(e => e.data.subtype === 'command_end' && String(e.data.command).includes('OLD_SCROLL_SENTINEL')))).toBe(true)
    const finished = path.join(tmpHome, 'inflight-finished')
    await page.evaluate(({ id, finished }) => window.redlog.terminal.write(id, `sleep 2; printf 'after-boundary\\n'; touch '${finished}'\r`), { id: pane.id, finished })
    await expect.poll(() => page.evaluate(async () => (await window.redlog.events.query({ agentType: 'shell', limit: -1 })).some(e => e.data.subtype === 'command_start' && String(e.data.command).includes('after-boundary')))).toBe(true)
    await page.getByTestId('titlebar-leave-project').click()
    await expect(page.getByRole('dialog')).toBeVisible()
    await expect(page.getByRole('checkbox')).toHaveCount(0)
    await expect(page.getByRole('dialog')).toContainText('stay open')
    await page.getByRole('button', { name: 'Stop recording and leave', exact: true }).click()
    await expect(page.getByTestId('picker-terminals')).toBeVisible()
    await expect(page.getByTestId('terminal-recording-gap')).toContainText('not recorded')
    expect(await page.evaluate(async () => (await window.redlog.terminal.list())[0].pid)).toBe(pane.pid)
    await expect.poll(() => fs.existsSync(finished)).toBe(true)
    await page.evaluate(id => window.redlog.terminal.write(id, "printf 'picker-only\\n'\r"), pane.id)
    await expect.poll(() => page.locator('.xterm-screen').innerText()).toContain('picker-only')
    // Open B through the real picker card; the shared main lifecycle performs
    // the rotation. The injected enrollment must not stop this owned shell.
    await page.getByText('rotation-B', { exact: true }).click()
    await expect(page.getByTestId('view-root')).toHaveAttribute('data-view', 'dashboard')
    await openView(page, 'terminal')
    expect(await page.evaluate(async () => (await window.redlog.terminal.list())[0].pid)).toBe(pane.pid)
    await page.evaluate(id => window.redlog.terminal.write(id, "printf 'B-only:%s\\n' \"$PWD\"\r"), pane.id)
    await expect.poll(() => page.evaluate(async () => (await window.redlog.events.query({ agentType: 'shell', limit: -1 })).some(e => e.data.subtype === 'command_end' && String(e.data.command).includes('B-only')))).toBe(true)
    const bRows = await page.evaluate(async () => window.redlog.events.query({ agentType: 'shell', limit: -1 }))
    expect(bRows.some(e => String(e.data.command).includes('picker-only'))).toBe(false)
    const bStart = bRows.find(e => e.data.subtype === 'session_start' && e.data.source === 'builtin-terminal')!
    expect(bStart.data.continues).toMatchObject({ projectId: a.id })
    const bVerify = await page.evaluate(() => window.redlog.chain.verify())
    expect(bVerify, JSON.stringify(bVerify)).toMatchObject({ ok: true })
    await page.getByTestId('titlebar-leave-project').click()
    await page.getByRole('button', { name: 'Stop recording and leave', exact: true }).click()
    await page.getByText('rotation-A', { exact: true }).click()
    await openView(page, 'terminal')
    const aRows = await page.evaluate(async () => window.redlog.events.query({ agentType: 'shell', limit: -1 }))
    const aEnd = aRows.find(e => e.data.subtype === 'session_end' && e.data.reason === 'project-switched')!
    const aBytes = fs.readFileSync(String(aEnd.data.castPath))
    expect(aEnd.data.castSha256).toBe(crypto.createHash('sha256').update(aBytes).digest('hex'))
    expect(aBytes.toString()).not.toMatch(/B-only|picker-only/)
    expect(aRows.some(e => e.data.subtype === 'command_boundary')).toBe(true)
    const aVerify = await page.evaluate(() => window.redlog.chain.verify())
    expect(aVerify, JSON.stringify(aVerify)).toMatchObject({ ok: true })
    const replay = await page.evaluate(id => window.redlog.terminal.replaySession(id), aEnd.id)
    expect(replay.ok).toBe(true)
    expect(replay.text).toContain('A-only')
    expect(replay.text).not.toMatch(/B-only|picker-only/)
    const bBytes = fs.readFileSync(String(bStart.data.castPath)).toString()
    expect(bBytes).toContain(`B-only:${cwd}`)
    expect(bBytes).not.toMatch(/A-only|picker-only/)
    expect(await page.evaluate(async () => (await window.redlog.terminal.list())[0].pid)).toBe(pane.pid)
    await expect(page.locator('.xterm-screen')).toBeVisible()
    await page.getByRole('button', { name: 'Search buffer', exact: true }).click()
    const search = page.getByPlaceholder('Search terminal buffer… Enter = next, Shift+Enter = previous', { exact: true })
    await search.fill('OLD_SCROLL_SENTINEL'); await search.press('Enter')
    await expect.poll(() => page.locator('.xterm-screen').innerText()).toContain('OLD_SCROLL_SENTINEL')
    await page.getByRole('button', { name: 'Search buffer', exact: true }).click()
    await (await app.browserWindow(page)).evaluate(window => window.focus())
    await page.locator('.xterm-viewport').evaluate(element => { element.scrollTop = element.scrollHeight })
    await page.locator('.xterm-helper-textarea').focus()
    await expect(page.locator('.xterm-helper-textarea')).toBeFocused()
    // A per-pane stop applies to its raw cast too, not only command rows.
    await page.keyboard.type('redlog stop'); await page.keyboard.press('Enter')
    await expect.poll(() => page.evaluate(async () => {
      const pane = (await window.redlog.terminal.list())[0]
      if (!pane.paused) return { state: pane, screen: document.querySelector('.xterm-screen')?.textContent?.slice(-1200) }
      return true
    })).toBe(true)
    await page.keyboard.type("printf 'PRIVATE_PAUSED_SENTINEL\\n'"); await page.keyboard.press('Enter')
    await expect.poll(() => page.locator('.xterm-screen').innerText()).toContain('PRIVATE_PAUSED_SENTINEL')
    await page.keyboard.type('redlog start'); await page.keyboard.press('Enter')
    await expect.poll(() => page.evaluate(async () => (await window.redlog.terminal.list())[0].recording)).toBe(true)
    await page.keyboard.type("printf 'PUBLIC_RESUMED_SENTINEL\\n'"); await page.keyboard.press('Enter')
    await expect.poll(() => page.evaluate(async () => (await window.redlog.events.query({ agentType: 'shell', limit: -1 })).some(e => e.data.subtype === 'command_end' && String(e.data.command).includes('PUBLIC_RESUMED_SENTINEL')))).toBe(true)
    const liveStart = await page.evaluate(async () => (await window.redlog.events.query({ agentType: 'shell', limit: -1 })).find(e => e.data.subtype === 'session_start' && e.data.source === 'builtin-terminal')!)
    const liveBytes = fs.readFileSync(String(liveStart.data.castPath), 'utf8')
    expect(liveBytes).not.toContain('PRIVATE_PAUSED_SENTINEL')
    expect(liveBytes).toContain('PUBLIC_RESUMED_SENTINEL')
    await page.screenshot({ path: test.info().outputPath('terminal-project-rotation.png') })
  } catch (error) {
    console.error('Terminal project rotation failed:', error)
    throw error
  } finally { await app.close() }
})
