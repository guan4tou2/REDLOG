import { test, expect } from '@playwright/test'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { launchWithTempHome, openTestProject } from './helpers'

test('official AI installation is explicit, local and independent of project activation', async () => {
  const { app, page, tmpHome } = await launchWithTempHome()
  try {
    const catalog = await page.evaluate(() => window.redlog.plugins.officialAgents())
    expect(catalog.map(p => p.agentKind)).toEqual(['claude-code', 'codex', 'opencode'])
    expect(catalog.every(p => p.state === 'not-installed')).toBe(true)
    const pluginRoot = join(tmpHome, '.redlog', 'plugins')
    expect(catalog.every(p => !existsSync(join(pluginRoot, p.pluginId)))).toBe(true)
    await openTestProject(page, 'official-ai-install')
    const before = await page.evaluate(() => window.redlog.config.get())
    const project = await page.evaluate(async () => {
      const active = await window.redlog.project.active()
      return (await window.redlog.project.list()).find(p => p.id === active?.id)!
    })
    const evidence = join(project.path, 'agent-transcripts', 'existing.txt')
    mkdirSync(join(project.path, 'agent-transcripts'), { recursive: true })
    writeFileSync(evidence, 'already recorded evidence')

    expect(await page.evaluate(() => window.redlog.plugins.installOfficialAgent('codex'))).toMatchObject({ ok: true, changed: true })
    const installed = await page.evaluate(() => window.redlog.plugins.officialAgents())
    expect(installed.map(p => p.state)).toEqual(['not-installed', 'installed', 'not-installed'])
    expect(await page.evaluate(() => window.redlog.config.get())).toEqual(before)
    const manifest = join(pluginRoot, 'official-ai-codex', 'plugin.json')
    const original = readFileSync(manifest)
    expect(JSON.parse(original.toString()).contributes).toEqual({})
    expect(await page.evaluate(() => window.redlog.plugins.installOfficialAgent('codex'))).toMatchObject({ ok: true, changed: false })
    expect(await page.evaluate(() => window.redlog.plugins.installOfficialAgent('../escape'))).toMatchObject({ ok: false })

    writeFileSync(manifest, 'operator modified this file')
    expect(await page.evaluate(() => window.redlog.plugins.uninstallOfficialAgent('codex'))).toMatchObject({ ok: false })
    expect(readFileSync(manifest, 'utf8')).toBe('operator modified this file')
    writeFileSync(manifest, original)
    expect(await page.evaluate(() => window.redlog.plugins.uninstallOfficialAgent('codex'))).toMatchObject({ ok: true, changed: true })
    expect(existsSync(manifest)).toBe(false)
    expect(readFileSync(evidence, 'utf8')).toBe('already recorded evidence')
    expect(await page.evaluate(() => window.redlog.config.get())).toEqual(before)
  } finally { await app.close() }
})
