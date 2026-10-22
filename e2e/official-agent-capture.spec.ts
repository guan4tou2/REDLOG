import { test, expect } from '@playwright/test'
import { mkdirSync, writeFileSync, appendFileSync, readFileSync, readdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { launchWithTempHome, openTestProject, openView, openSettingsPage } from './helpers'

// Use real source files and the production watchers. Only the native folder
// picker is supplied a fixture path, so settings still save through real IPC.
test('AI integration records only new, authorized turns and stops without deleting evidence', async () => {
  test.setTimeout(60_000)
  const { app, page, tmpHome } = await launchWithTempHome(process.env.REDLOG_PACKAGED_APP)
  try {
    // The removal dialog names its consequences, and this spec reads them.
    await page.evaluate(() => localStorage.setItem('redlog-locale', 'en'))
    await page.reload()
    const work = join(tmpHome, 'client-work')
    const privateWork = join(tmpHome, 'private-work')
    const sources = join(tmpHome, '.codex', 'sessions', '2026', '10', '22')
    for (const p of [work, privateWork, sources]) mkdirSync(p, { recursive: true })
    const user = (text: string): string => JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] } }) + '\n'
    const source = join(sources, 'rollout-client.jsonl')
    const privateSource = join(sources, 'rollout-private.jsonl')
    writeFileSync(source, JSON.stringify({ type: 'session_meta', payload: { cwd: work } }) + '\n' + user('OLD_HISTORY_SENTINEL'))
    writeFileSync(privateSource, JSON.stringify({ type: 'session_meta', payload: { cwd: privateWork } }) + '\n' + user('PRIVATE_HISTORY_SENTINEL'))
    const otherSources = [join(tmpHome, '.claude', 'projects', 'fixture', 'session.jsonl'), join(tmpHome, '.local', 'share', 'opencode', 'storage', 'message', 'ses_fixture', 'msg_fixture.json')]
    for (const file of otherSources) { mkdirSync(join(file, '..'), { recursive: true }); writeFileSync(file, '{}\n') }
    // Observe actual filesystem opens/reads, not just an empty event table.
    await app.evaluate(async () => {
      const fs = process.getBuiltinModule('fs') as typeof import('node:fs')
      const state = globalThis as unknown as { aiSourceReads: string[] }
      state.aiSourceReads = []
      const observedFs = fs as unknown as Record<string, unknown>
      for (const method of ['openSync', 'readFileSync'] as const) {
        const original = fs[method]
        observedFs[method] = function(this: unknown, ...args: unknown[]) {
          const file = String(args[0]).replaceAll('\\', '/')
          if (['/.codex/sessions/', '/.claude/projects/', '/opencode/storage/'].some(part => file.includes(part))) state.aiSourceReads.push(file)
          return Reflect.apply(original, this, args)
        }
      }
    })
    const reads = () => app.evaluate(() => (globalThis as unknown as { aiSourceReads: string[] }).aiSourceReads)
    await openTestProject(page, 'AI-capture-acceptance')
    const project = await page.evaluate(async () => {
      const active = await window.redlog.project.active()
      return (await window.redlog.project.list()).find(p => p.id === active?.id)!
    })
    const rows = () => page.evaluate(() => window.redlog.events.query({ agentType: 'agent', limit: 1000 }))
    expect(await rows()).toEqual([])
    expect(await reads()).toEqual([])
    await openView(page, 'settings'); await openSettingsPage(page, 'captureControl')
    await expect(page.getByTestId('agent-install-codex')).toBeVisible()
    expect(await page.getByTestId('agent-enabled-codex').count()).toBe(0)
    await page.getByTestId('agent-install-codex').click()
    await expect(page.getByTestId('agent-enabled-codex')).toBeDisabled()
    expect(await reads()).toEqual([])
    await app.evaluate(({ dialog }, dir) => {
      dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [dir] })) as typeof dialog.showOpenDialog
    }, work)
    await page.getByTestId('agent-add-path-codex').click()
    await expect(page.getByTestId('agent-enabled-codex')).toBeEnabled()
    await page.getByTestId('agent-enabled-codex').check()
    await expect.poll(async () => (await page.evaluate(() => window.redlog.config.get()))?.agentTailer?.sources?.codex?.enabled).toBe(true)
    // Registration is the observed connection boundary for existing files.
    await expect.poll(async () => (await rows()).some(e => e.data.subtype === 'transcript_capture_started'), { timeout: 10_000 }).toBe(true)
    appendFileSync(source, user('NEW_AUTHORIZED_SENTINEL') +
      JSON.stringify({ type: 'response_item', payload: { type: 'function_call', name: 'exec_command', call_id: 'fixture-call', arguments: JSON.stringify({ cmd: 'printf AI_INPUT_SENTINEL' }) } }) + '\n' +
      JSON.stringify({ type: 'response_item', payload: { type: 'function_call_output', call_id: 'fixture-call', output: 'AI_OUTPUT_SENTINEL' } }) + '\n')
    appendFileSync(privateSource, user('NEW_PRIVATE_SENTINEL'))
    await expect.poll(async () => JSON.stringify(await rows()), { timeout: 10_000 }).toContain('NEW_AUTHORIZED_SENTINEL')
    await expect.poll(async () => JSON.stringify(await rows())).toContain('AI_OUTPUT_SENTINEL')
    expect((await rows()).some(e => e.data.subtype === 'tool_call' && JSON.stringify(e.data.tool_input).includes('AI_INPUT_SENTINEL'))).toBe(true)
    expect(JSON.stringify(await rows())).not.toMatch(/OLD_HISTORY_SENTINEL|PRIVATE_HISTORY_SENTINEL|NEW_PRIVATE_SENTINEL/)
    expect((await reads()).some(p => p.includes('/.codex/sessions/'))).toBe(true)
    expect((await reads()).some(p => p.includes('/.claude/projects/') || p.includes('/opencode/storage/'))).toBe(false)
    const sidecarDir = join(project.path, 'agent-transcripts')
    const sidecars = readdirSync(sidecarDir).filter(p => p.endsWith('.jsonl'))
    expect(sidecars).toHaveLength(1)
    const file = join(sidecarDir, sidecars[0]); const bytes = readFileSync(file)
    expect(bytes.toString()).toContain('NEW_AUTHORIZED_SENTINEL')
    expect(bytes.toString()).not.toContain('OLD_HISTORY_SENTINEL')
    await page.getByTestId('agent-enabled-codex').uncheck()
    await expect.poll(async () => (await page.evaluate(() => window.redlog.config.get()))?.agentTailer?.sources?.codex?.enabled).toBe(false)
    await app.evaluate(() => { (globalThis as unknown as { aiSourceReads: string[] }).aiSourceReads = [] })
    const count = (await rows()).length
    appendFileSync(source, user('WHILE_DISABLED_SENTINEL'))
    // Give a delayed file notification time to run; it must be ignored.
    await page.waitForTimeout(500)
    expect((await rows()).length).toBe(count)
    expect(await reads()).toEqual([])
    expect(readFileSync(file).equals(bytes)).toBe(true)
    // A local removal is machine-wide, so it asks first and names what stops
    // and what stays.
    await page.getByTestId('agent-remove-codex').click()
    const removal = page.getByRole('dialog', { name: 'Remove capture integration' })
    await expect(removal).toBeVisible()
    await expect(removal).toContainText('Every project on this computer stops recording this source.')
    await expect(removal).toContainText('Records already captured are kept.')
    await removal.getByRole('button', { name: 'Remove', exact: true }).click()
    await expect(page.getByTestId('agent-install-codex')).toBeVisible()
    expect(readFileSync(file).equals(bytes)).toBe(true)
    expect(existsSync(join(tmpHome, '.redlog', 'plugins', 'official-ai-codex'))).toBe(false)
    // Project permission is tied to the removed installation, not any later one.
    await page.evaluate(async () => {
      const cfg = (await window.redlog.config.get())!
      cfg.agentTailer!.sources!.codex!.enabled = true
      await window.redlog.config.save(cfg)
    })
    await page.getByTestId('agent-install-codex').click()
    await expect(page.getByTestId('agent-enabled-codex')).not.toBeChecked()
    appendFileSync(source, user('AFTER_REINSTALL_SENTINEL'))
    await page.waitForTimeout(500)
    expect(JSON.stringify(await rows())).not.toMatch(/WHILE_DISABLED_SENTINEL|AFTER_REINSTALL_SENTINEL/)
    expect(readFileSync(file).equals(bytes)).toBe(true)
    expect((await page.evaluate(() => window.redlog.plugins.officialAgents())).map(p => p.state)).toEqual(['not-installed', 'installed', 'not-installed'])
  } finally { await app.close() }
})
