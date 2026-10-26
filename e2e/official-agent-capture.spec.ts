import { test, expect } from '@playwright/test'
import { mkdirSync, writeFileSync, appendFileSync, readFileSync, readdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { launchWithTempHome, openTestProject, openView, openSettingsPage } from './helpers'

type AgentKind = 'claude-code' | 'codex'

function transcriptFixture(kind: AgentKind, home: string) {
  const root = kind === 'claude-code' ? join(home, '.claude', 'projects', 'fixture')
    : join(home, 'custom-codex-團隊 [redlog]')
  const line = (value: unknown): string => JSON.stringify(value) + '\n'
  const message = (role: 'user' | 'assistant', text: string): string => kind === 'claude-code'
    ? line({ type: role, uuid: randomUUID(), message: { role, content: [{ type: 'text', text }] } })
    : line({ type: 'response_item', payload: { type: 'message', role, content: [{ type: role === 'user' ? 'input_text' : 'output_text', text }] } })
  return {
    root,
    filename: kind === 'claude-code' ? 'client.jsonl' : 'rollout-client.jsonl',
    privateFilename: kind === 'claude-code' ? 'private.jsonl' : 'rollout-private.jsonl',
    pathPart: kind === 'claude-code' ? '/.claude/projects/' : '/custom-codex-團隊 [redlog]/',
    header: (cwd: string): string => kind === 'claude-code'
      ? line({ type: 'user', uuid: randomUUID(), cwd, message: { role: 'user', content: [] } })
      : line({ type: 'session_meta', payload: { cwd } }),
    user: (text: string): string => message('user', text),
    reply: (text: string): string => message('assistant', text),
    tools: (output: string): string => kind === 'claude-code'
      ? line({ type: 'assistant', uuid: 'fixture-call', message: { role: 'assistant', content: [
        { type: 'tool_use', id: 'fixture-tool', name: 'Bash', input: { command: 'printf AI_INPUT_SENTINEL' } }
      ] } }) + line({ type: 'user', uuid: 'fixture-result', parentUuid: 'fixture-call', message: { role: 'user', content: [
        { type: 'tool_result', tool_use_id: 'fixture-tool', content: output }
      ] } })
      : line({ type: 'response_item', payload: { type: 'function_call', name: 'exec_command', call_id: 'fixture-tool', arguments: JSON.stringify({ cmd: 'printf AI_INPUT_SENTINEL' }) } })
        + line({ type: 'response_item', payload: { type: 'function_call_output', call_id: 'fixture-tool', output } })
  }
}

// Use real source files and the production watchers. Only the native folder
// picker is supplied a fixture path, so settings still save through real IPC.
for (const kind of ['claude-code', 'codex'] as const) test(`${kind}: new authorized conversation survives search, delivery and capture removal`, async () => {
  test.setTimeout(60_000)
  const { app, page, tmpHome } = await launchWithTempHome(process.env.REDLOG_PACKAGED_APP)
  try {
    if (process.env.REDLOG_PACKAGED_APP) expect(await app.evaluate(({ app }) => app.isPackaged)).toBe(true)
    // The removal dialog names its consequences, and this spec reads them.
    await page.evaluate(() => localStorage.setItem('redlog-locale', 'en'))
    await page.reload()
    const work = join(tmpHome, 'client-work')
    const privateWork = join(tmpHome, 'private-work')
    const fixture = transcriptFixture(kind, tmpHome)
    const { user } = fixture
    for (const p of [work, privateWork, fixture.root]) mkdirSync(p, { recursive: true })
    const source = join(fixture.root, fixture.filename)
    const privateSource = join(fixture.root, fixture.privateFilename)
    writeFileSync(source, fixture.header(work) + user('OLD_HISTORY_SENTINEL'))
    writeFileSync(privateSource, fixture.header(privateWork) + user('PRIVATE_HISTORY_SENTINEL'))
    const otherSources = [
      kind === 'claude-code' ? join(tmpHome, '.codex', 'sessions', 'fixture', 'rollout-other.jsonl') : join(tmpHome, '.claude', 'projects', 'fixture', 'session.jsonl')
    ]
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
          if (['/.codex/sessions/', '/.claude/projects/', '/custom-codex-團隊 [redlog]/'].some(part => file.includes(part))) state.aiSourceReads.push(file)
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
    const installedModule = join(tmpHome, '.redlog', 'plugins', `official-ai-${kind}`, 'adapter.cjs')
    const parserLoaded = () => app.evaluate((_electron, file) => {
      const fs = process.getBuiltinModule('fs')!
      if (!fs.existsSync(file)) return false
      return !!process.getBuiltinModule('module')!.createRequire(process.execPath).cache[fs.realpathSync(file)]
    }, installedModule)
    const rows = () => page.evaluate(() => window.redlog.events.query({ agentType: 'agent', limit: 1000 }))
    expect(await rows()).toEqual([])
    expect(await parserLoaded()).toBe(false)
    expect(await reads()).toEqual([])
    await openView(page, 'settings'); await openSettingsPage(page, 'captureControl')
    await expect(page.getByTestId(`agent-install-${kind}`)).toBeVisible()
    expect(await page.getByTestId(`agent-enabled-${kind}`).count()).toBe(0)
    await page.getByTestId(`agent-install-${kind}`).click()
    await expect(page.getByTestId(`agent-enabled-${kind}`)).toBeDisabled()
    expect(await reads()).toEqual([])
    await app.evaluate(({ dialog }, dir) => {
      dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [dir] })) as typeof dialog.showOpenDialog
    }, work)
    await page.getByTestId(`agent-add-path-${kind}`).click()
    if (kind === 'codex') {
      await page.getByTestId(`agent-details-${kind}`).locator('summary').click()
      await app.evaluate(({ dialog }, root) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [root] }) }, fixture.root)
      await page.getByTestId(`agent-source-path-${kind}`).click()
      await expect(page.getByTestId(`agent-root-${kind}`)).toHaveText(fixture.root)
      await expect.poll(async () => (await page.evaluate(() => window.redlog.config.get()))?.agentTailer?.sources?.codex?.sourceRoot).toBe(fixture.root)
      expect((await page.evaluate(() => window.redlog.agents.sources())).find(s => s.id === kind)).toMatchObject({ root: fixture.root, detected: true })
    }
    expect(existsSync(installedModule)).toBe(true)
    expect(await parserLoaded()).toBe(false)
    await expect(page.getByTestId(`agent-enabled-${kind}`)).toBeEnabled()
    await page.getByTestId(`agent-enabled-${kind}`).check()
    await expect.poll(async () => (await page.evaluate(() => window.redlog.config.get()))?.agentTailer?.sources?.[kind]?.enabled).toBe(true)
    // Registration is the observed connection boundary for existing files.
    await expect.poll(async () => (await rows()).some(e => e.data.subtype === 'transcript_capture_started'), { timeout: 10_000 }).toBe(true)
    expect(await parserLoaded()).toBe(true)
    const output = 'AI_OUTPUT_SENTINEL\n' + 'ordinary tool output\n'.repeat(50) + 'AI_OUTPUT_TAIL_SENTINEL'
    appendFileSync(source, user('NEW_AUTHORIZED_SENTINEL') + fixture.reply('AI_REPLY_SENTINEL') + fixture.tools(output))
    appendFileSync(privateSource, user('NEW_PRIVATE_SENTINEL'))
    await expect.poll(async () => JSON.stringify(await rows()), { timeout: 10_000 }).toContain('NEW_AUTHORIZED_SENTINEL')
    await expect.poll(async () => JSON.stringify(await rows())).toContain('AI_OUTPUT_SENTINEL')
    expect((await rows()).some(e => e.data.subtype === 'tool_call' && JSON.stringify(e.data.tool_input).includes('AI_INPUT_SENTINEL'))).toBe(true)
    expect(JSON.stringify(await rows())).not.toMatch(/OLD_HISTORY_SENTINEL|PRIVATE_HISTORY_SENTINEL|NEW_PRIVATE_SENTINEL/)
    expect((await reads()).some(p => p.includes(fixture.pathPart))).toBe(true)
    expect((await reads()).some(p => !p.includes(fixture.pathPart))).toBe(false)
    const captured = await rows()
    expect(captured.some(e => e.data.subtype === 'assistant_message' && e.data.full === 'AI_REPLY_SENTINEL')).toBe(true)
    const toolCall = captured.find(e => e.data.subtype === 'tool_call')!
    const toolResult = captured.find(e => e.data.subtype === 'tool_result')!
    expect(toolResult.data.tool_use_id).toBe(toolCall.data.tool_use_id)
    expect(toolResult.data.session_id).toBe(toolCall.data.session_id)
    expect(toolResult.data.output).toBe(output)

    await openView(page, 'search')
    await page.getByTestId('search-input').fill('AI_OUTPUT_TAIL_SENTINEL')
    await expect(page.getByRole('option')).toHaveCount(1)
    await expect(page.getByRole('option')).toContainText('AI_OUTPUT_SENTINEL')
    await openView(page, 'transcript')
    await expect(page.getByText(/AI_INPUT_SENTINEL/)).toBeVisible()
    const collapsed = page.locator('[data-testid="transcript-toggle"][data-expanded="false"]')
    await expect(collapsed.first()).toBeVisible()
    while (await collapsed.count()) await collapsed.first().click()
    await expect(page.getByText('NEW_AUTHORIZED_SENTINEL', { exact: true })).toBeVisible()
    await expect(page.getByText('AI_REPLY_SENTINEL', { exact: true })).toBeVisible()
    await expect(page.getByText(output, { exact: true })).toBeVisible()

    await page.getByLabel('Export', { exact: true }).click()
    await page.getByLabel('Export range', { exact: true }).selectOption('all')
    await page.getByLabel('Export format', { exact: true }).selectOption('other')
    await page.getByLabel('Other formats', { exact: true }).selectOption('json')
    await expect(page.getByTestId('export-confirm')).toBeEnabled()
    await page.getByTestId('export-confirm').click()
    await expect(page.getByTestId('export-completed')).toBeVisible()
      await page.getByRole('button', { name: 'Close', exact: true }).last().click()
    const exports = join(project.path, 'exports')
    const exported = readdirSync(exports).find(p => p.endsWith('.json') && !p.endsWith('.manifest.json'))!
    const delivered = JSON.parse(readFileSync(join(exports, exported), 'utf8'))
    expect(JSON.stringify(delivered.events)).toContain('AI_OUTPUT_TAIL_SENTINEL')
    expect(JSON.stringify(delivered.events)).toContain('AI_REPLY_SENTINEL')
    expect(JSON.stringify(delivered.events)).not.toMatch(/OLD_HISTORY_SENTINEL|PRIVATE_HISTORY_SENTINEL|NEW_PRIVATE_SENTINEL/)
    expect(delivered.events.some((e: { id: string }) => e.id === toolCall.id)).toBe(true)
    expect(delivered.events.some((e: { id: string }) => e.id === toolResult.id)).toBe(true)
    const idsBeforeReload = captured.map(e => e.id)
    await page.reload()
    await expect.poll(async () => (await rows()).map(e => e.id)).toEqual(expect.arrayContaining(idsBeforeReload))
    expect((await rows()).filter(e => e.data.subtype === 'tool_result')).toHaveLength(1)
    await openView(page, 'settings'); await openSettingsPage(page, 'captureControl')
    const sidecarDir = join(project.path, 'agent-transcripts')
    const sidecars = readdirSync(sidecarDir).filter(p => p.endsWith('.jsonl'))
    expect(sidecars).toHaveLength(1)
    const file = join(sidecarDir, sidecars[0]); const bytes = readFileSync(file)
    expect(bytes.toString()).toContain('NEW_AUTHORIZED_SENTINEL')
    expect(bytes.toString()).not.toContain('OLD_HISTORY_SENTINEL')
    await page.getByTestId(`agent-enabled-${kind}`).uncheck()
    await expect.poll(async () => (await page.evaluate(() => window.redlog.config.get()))?.agentTailer?.sources?.[kind]?.enabled).toBe(false)
    expect(await parserLoaded()).toBe(false)
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
    await page.getByTestId(`agent-details-${kind}`).locator('summary').click()
    await page.getByTestId(`agent-remove-${kind}`).click()
    const removal = page.getByRole('dialog', { name: 'Remove capture integration' })
    await expect(removal).toBeVisible()
    await expect(removal).toContainText('Every project on this computer stops recording this source.')
    await expect(removal).toContainText('Records already captured are kept.')
    await removal.getByRole('button', { name: 'Remove', exact: true }).click()
    await expect(page.getByTestId(`agent-install-${kind}`)).toBeVisible()
    expect(readFileSync(file).equals(bytes)).toBe(true)
    expect(existsSync(join(tmpHome, '.redlog', 'plugins', `official-ai-${kind}`))).toBe(false)
    // Project permission is tied to the removed installation, not any later one.
    await page.evaluate(async kind => {
      const cfg = (await window.redlog.config.get())!
      cfg.agentTailer!.sources![kind]!.enabled = true
      await window.redlog.config.save(cfg)
    }, kind)
    await page.getByTestId(`agent-install-${kind}`).click()
    await expect(page.getByTestId(`agent-enabled-${kind}`)).not.toBeChecked()
    appendFileSync(source, user('AFTER_REINSTALL_SENTINEL'))
    await page.waitForTimeout(500)
    expect(JSON.stringify(await rows())).not.toMatch(/WHILE_DISABLED_SENTINEL|AFTER_REINSTALL_SENTINEL/)
    expect(readFileSync(file).equals(bytes)).toBe(true)
    expect((await page.evaluate(() => window.redlog.plugins.officialAgents())).map(p => p.state)).toEqual(kind === 'claude-code' ? ['installed', 'not-installed'] : ['not-installed', 'installed'])
    // Uninstall directly while active, rather than relying on a prior Stop.
    await page.getByTestId(`agent-enabled-${kind}`).check()
    await expect.poll(parserLoaded).toBe(true)
    const starts = captured.filter(e => e.data.subtype === 'transcript_capture_started').length
    await expect.poll(async () => (await rows()).filter(e => e.data.subtype === 'transcript_capture_started').length).toBeGreaterThan(starts)
    appendFileSync(source, user('REACTIVATED_SENTINEL'))
    await expect.poll(async () => JSON.stringify(await rows())).toContain('REACTIVATED_SENTINEL')
    await page.getByTestId(`agent-details-${kind}`).locator('summary').click()
    await page.getByTestId(`agent-remove-${kind}`).click()
    await page.getByRole('dialog', { name: 'Remove capture integration' }).getByRole('button', { name: 'Remove', exact: true }).click()
    await expect(page.getByTestId(`agent-install-${kind}`)).toBeVisible()
    expect(await parserLoaded()).toBe(false)
    expect(existsSync(installedModule)).toBe(false)
    appendFileSync(source, user('AFTER_ACTIVE_UNINSTALL_SENTINEL'))
    await page.waitForTimeout(500)
    expect(JSON.stringify(await rows())).not.toContain('AFTER_ACTIVE_UNINSTALL_SENTINEL')
    expect(readFileSync(file).equals(bytes)).toBe(true)
    await openTestProject(page, 'AI-other-project')
    if (kind === 'codex') expect((await page.evaluate(() => window.redlog.agents.sources())).find(s => s.id === 'codex')?.root).toBe(join(tmpHome, '.codex', 'sessions'))
    appendFileSync(source, user('AFTER_PROJECT_SWITCH_SENTINEL'))
    await page.waitForTimeout(500)
    expect(await rows()).toEqual([])
    expect(readFileSync(file).equals(bytes)).toBe(true)
  } finally { await app.close() }
})

test('Claude source pause and individual exclusions omit raw content without stopping another conversation', async () => {
  const { app, page, tmpHome } = await launchWithTempHome(process.env.REDLOG_PACKAGED_APP)
  try {
    await page.evaluate(() => localStorage.setItem('redlog-locale', 'en')); await page.reload()
    const work = join(tmpHome, 'client-work'); mkdirSync(work)
    const fixture = transcriptFixture('claude-code', tmpHome); mkdirSync(fixture.root, { recursive: true })
    const first = join(fixture.root, 'first.jsonl'), second = join(fixture.root, 'second.jsonl')
    writeFileSync(first, fixture.header(work)); writeFileSync(second, fixture.header(work))
    const project = await openTestProject(page, 'AI-session-privacy')
    await openView(page, 'settings'); await openSettingsPage(page, 'captureControl')
    await page.getByTestId('agent-install-claude-code').click()
    await app.evaluate(({ dialog }, dir) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [dir] }) }, work)
    await page.getByTestId('agent-add-path-claude-code').click(); await page.getByTestId('agent-enabled-claude-code').check()
    await expect.poll(async () => (await page.evaluate(() => window.redlog.agents.sessions())).filter(s => s.recording).length).toBe(2)
    const rows = () => page.evaluate(() => window.redlog.events.query({ agentType: 'agent', limit: 1000 }))
    appendFileSync(first, fixture.user('PUBLIC_FIRST')); appendFileSync(second, fixture.user('PUBLIC_SECOND'))
    await expect.poll(async () => JSON.stringify(await rows())).toContain('PUBLIC_FIRST')
    expect(await page.evaluate(() => window.redlog.recording.toggle())).toBe(false)
    appendFileSync(first, fixture.user('PRIVATE_PAUSE_SENTINEL'))
    // No notification wait: resume must skip what exists now.
    expect(await page.evaluate(() => window.redlog.recording.toggle())).toBe(true)
    appendFileSync(second, fixture.user('PUBLIC_AFTER_PAUSE'))
    await expect.poll(async () => JSON.stringify(await rows())).toContain('PUBLIC_AFTER_PAUSE')
    const source = page.getByTestId('agent-source-claude-code')
    await source.locator('summary').filter({ hasText: 'Conversations' }).click()
    await source.getByTestId('agent-session-first').click()
    await expect.poll(async () => (await page.evaluate(() => window.redlog.config.get())).agentTailer?.sources?.['claude-code']?.excludedSessions).toContain('first')
    appendFileSync(first, fixture.user('PRIVATE_EXCLUDED_SENTINEL')); appendFileSync(second, fixture.user('PUBLIC_OTHER_CONTINUES'))
    await expect.poll(async () => JSON.stringify(await rows())).toContain('PUBLIC_OTHER_CONTINUES')
    await page.reload(); await openView(page, 'settings'); await openSettingsPage(page, 'captureControl')
    appendFileSync(first, fixture.user('PRIVATE_AFTER_RELOAD_SENTINEL'))
    await source.locator('summary').filter({ hasText: 'Conversations' }).click()
    await expect(source.getByTestId('agent-session-first')).toHaveText('Record new content')
    await source.getByTestId('agent-session-first').click()
    await expect.poll(async () => (await page.evaluate(() => window.redlog.agents.sessions())).find(s => s.sessionId === 'first')?.recording).toBe(true)
    appendFileSync(first, fixture.user('PUBLIC_REAUTHORIZED'))
    await expect.poll(async () => JSON.stringify(await rows())).toContain('PUBLIC_REAUTHORIZED')
    const projectInfo = (await page.evaluate(() => window.redlog.project.list())).find(p => p.id === project.id)!
    const sidecarDir = join(projectInfo.path, 'agent-transcripts')
    const saved = readdirSync(sidecarDir).filter(p => p.endsWith('.jsonl')).map(p => readFileSync(join(sidecarDir, p), 'utf8')).join('')
    expect(saved).not.toMatch(/PRIVATE_PAUSE_SENTINEL|PRIVATE_EXCLUDED_SENTINEL|PRIVATE_AFTER_RELOAD_SENTINEL/)
    expect(JSON.stringify(await rows())).not.toMatch(/PRIVATE_PAUSE_SENTINEL|PRIVATE_EXCLUDED_SENTINEL|PRIVATE_AFTER_RELOAD_SENTINEL/)
    expect((await page.evaluate(() => window.redlog.config.get())).agentTailer?.sources?.['claude-code']?.enabled).toBe(true)
  } finally { await app.close() }
})
