import { test, expect } from '@playwright/test'
import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { mkdirSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { launchWithTempHome, openTestProject, openView, openSettingsPage } from './helpers'

// Opt-in vendor serializer acceptance. All model responses come from loopback;
// no real account, key, external model or operator transcript is used.
for (const precreated of [false, true]) test(`installed Claude Code preserves prompt/tool/result with ${precreated ? 'existing' : 'new'} source directory`, async () => {
  test.skip(!process.env.REDLOG_CLAUDE_BIN, 'Requires an explicitly selected installed Claude Code binary')
  test.setTimeout(60_000)
  const { app, page, tmpHome } = await launchWithTempHome(process.env.REDLOG_PACKAGED_APP)
  const server = createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk
    const body = JSON.parse(raw || '{}')
    if (!req.url?.includes('messages')) { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{}'); return }
    const finished = body.messages?.some((m: { content?: unknown }) => Array.isArray(m.content) && m.content.some((c: { type?: string }) => c.type === 'tool_result'))
    const content = finished ? { type: 'text', text: 'REAL_CLAUDE_REPLY' }
      : { type: 'tool_use', id: 'redlog_local_call', name: 'Bash', input: { command: 'printf REAL_CLAUDE_TOOL_OUTPUT', description: 'Local RedLog acceptance' } }
    const message = { id: 'msg_redlog_local', type: 'message', role: 'assistant', model: 'redlog-local-fixture', content: [content], stop_reason: finished ? 'end_turn' : 'tool_use', stop_sequence: null, usage: { input_tokens: 100, output_tokens: 10 } }
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    for (const [event, data] of [
      ['message_start', { type: 'message_start', message: { ...message, content: [], stop_reason: null } }],
      ['content_block_start', { type: 'content_block_start', index: 0, content_block: finished ? { type: 'text', text: '' } : { ...content, input: {} } }],
      ['content_block_delta', { type: 'content_block_delta', index: 0, delta: finished ? { type: 'text_delta', text: content.text } : { type: 'input_json_delta', partial_json: JSON.stringify(content.input) } }],
      ['content_block_stop', { type: 'content_block_stop', index: 0 }],
      ['message_delta', { type: 'message_delta', delta: { stop_reason: message.stop_reason }, usage: { output_tokens: 10 } }],
      ['message_stop', { type: 'message_stop' }]
    ]) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
    res.end()
  })
  try {
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const port = (server.address() as { port: number }).port
    const work = join(tmpHome, 'client-work'); mkdirSync(work)
    if (precreated) mkdirSync(join(tmpHome, '.claude', 'projects'), { recursive: true })
    const project = await openTestProject(page, 'Real-Claude-Code-serializer')
    await page.evaluate(() => localStorage.setItem('redlog-locale', 'en')); await page.reload()
    await openView(page, 'settings'); await openSettingsPage(page, 'captureControl')
    await page.getByTestId('agent-install-claude-code').click()
    await app.evaluate(({ dialog }, dir) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [dir] }) }, work)
    await page.getByTestId('agent-add-path-claude-code').click(); await page.getByTestId('agent-enabled-claude-code').check()
    await expect.poll(async () => (await page.evaluate(() => window.redlog.config.get())).agentTailer?.sources?.['claude-code']?.enabled).toBe(true)
    // Deliberately do not inherit OAuth, nested-agent flags, real homes or keys.
    const env = { PATH: process.env.PATH!, TMPDIR: process.env.TMPDIR ?? tmpHome, HOME: tmpHome, USERPROFILE: tmpHome, CLAUDE_CONFIG_DIR: join(tmpHome, '.claude'), ANTHROPIC_API_KEY: 'redlog-local-fixture', ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}`, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', DISABLE_AUTOUPDATER: '1', DISABLE_TELEMETRY: '1', DISABLE_ERROR_REPORTING: '1', CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1' }
    const child = spawn(process.env.REDLOG_CLAUDE_BIN!, ['-p', 'REAL_CLAUDE_PROMPT', '--session-id', randomUUID(), '--model', 'redlog-local-fixture', '--output-format', 'json', '--tools', 'Bash', '--allowedTools', 'Bash', '--max-turns', '3', '--setting-sources', '', '--disable-slash-commands', '--no-chrome', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}'], { cwd: work, env })
    let stderr = ''; child.stderr.on('data', chunk => { stderr += chunk }); child.stdout.resume()
    const timer = setTimeout(() => child.kill(), 30_000)
    try { const code = await new Promise<number | null>((resolve, reject) => { child.once('error', reject); child.once('close', resolve) }); expect(code, stderr).toBe(0) }
    finally { clearTimeout(timer); if (child.exitCode === null) child.kill() }
    const events = () => page.evaluate(() => window.redlog.events.query({ agentType: 'agent', limit: 1000 }))
    await expect.poll(async () => JSON.stringify(await events())).toContain('REAL_CLAUDE_REPLY')
    const saved = await events()
    expect(saved.some(e => e.data.full === 'REAL_CLAUDE_PROMPT')).toBe(true)
    expect(saved.some(e => e.data.subtype === 'tool_call' && JSON.stringify(e.data.tool_input).includes('printf REAL_CLAUDE_TOOL_OUTPUT'))).toBe(true)
    expect(saved.some(e => e.data.subtype === 'tool_result' && e.data.output === 'REAL_CLAUDE_TOOL_OUTPUT')).toBe(true)
    const info = (await page.evaluate(() => window.redlog.project.list())).find(p => p.id === project.id)!
    const raw = readdirSync(join(info.path, 'agent-transcripts')).filter(p => p.endsWith('.jsonl')).map(p => readFileSync(join(info.path, 'agent-transcripts', p), 'utf8')).join('')
    expect(raw).toContain('REAL_CLAUDE_PROMPT'); expect(raw).toContain('REAL_CLAUDE_TOOL_OUTPUT')
  } finally { server.closeAllConnections(); server.close(); await app.close() }
})
