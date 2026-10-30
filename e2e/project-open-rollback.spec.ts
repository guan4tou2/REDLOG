import { test, expect } from '@playwright/test'
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { launchWithTempHome } from './helpers'

// Faults affect only this app's temporary HOME, through real IPC and stores.
for (const fault of ['config-write', 'db-open', 'db-pragma', 'source-config'] as const) {
  test(`project open rolls back after ${fault} and can retry without misattributing spool`, async () => {
    const { app, page, tmpHome } = await launchWithTempHome()
    try {
      const a = await page.evaluate(() => window.redlog.project.create('owner-a', { network: { offline: true } }))
      const b = await page.evaluate(() => window.redlog.project.create('owner-b', { network: { offline: true } }))
      const originalEvents = await page.evaluate(() => window.redlog.events.query({}))
      await page.evaluate(id => window.redlog.project.open(id), a.id)
      const projectDir = join(tmpHome, '.redlog', 'projects', b.id)
      const configPath = join(projectDir, 'config.yaml')
      const dbPath = join(projectDir, 'timeline.db')
      const config = readFileSync(configPath)
      const identityPath = join(tmpHome, '.redlog', 'active-identity.json')
      const identityA = readFileSync(identityPath)
      const pending = join(tmpHome, '.redlog', 'pending')
      mkdirSync(pending, { recursive: true })
      const spoolPath = join(pending, 'rollback-proof.json')
      const spool = JSON.stringify({ agent_type: 'shell', data: { subtype: 'command_end', command: 'echo rollback-proof', exit_code: 0 }, _identity: { engagementId: b.id, operatorId: 'spool-operator' } })
      writeFileSync(spoolPath, spool)
      const rawPath = join(projectDir, 'original-evidence.txt')
      writeFileSync(rawPath, 'original evidence bytes\n')

      if (fault === 'config-write') {
        renameSync(configPath, `${configPath}.saved`)
        mkdirSync(configPath)
      } else if (fault === 'db-open' || fault === 'db-pragma') {
        renameSync(dbPath, `${dbPath}.saved`)
        if (fault === 'db-open') mkdirSync(dbPath)
        else {
          // Preserve any WAL pages as well: otherwise SQLite can recover the
          // deliberately corrupted main file and the fault never occurs.
          for (const suffix of ['-wal', '-shm']) {
            if (existsSync(dbPath + suffix)) renameSync(dbPath + suffix, dbPath + suffix + '.saved')
          }
          writeFileSync(dbPath, Buffer.alloc(4096, 0x7f))
        }
      } else {
        // Parsed successfully, but a required source config is unusable. Fails
        // after DB open and several subsystem configurations, before replay.
        writeFileSync(configPath, config.toString().replace(/^network:.*?(?=^\S)/ms, 'network: null\n'))
      }

      if (fault === 'source-config') {
        await page.evaluate(() => localStorage.setItem('redlog-locale', 'en'))
        await page.reload()
        await expect(page.getByTestId('view-root')).toBeVisible()
        await page.locator('nav [aria-current="page"]').first().focus()
        await page.keyboard.press(process.platform === 'darwin' ? 'Meta+k' : 'Control+k')
        await page.locator(`[data-command-id="project:${b.id}"]`).click()
        await page.getByRole('dialog').getByRole('button', { name: 'Stop recording and switch', exact: true }).click()
        await expect(page.getByTestId('project-picker')).toBeVisible()
        await expect(page.getByText('Could not open the project', { exact: true })).toBeVisible()
      } else {
        const failure = await page.evaluate(async id => {
          try { await window.redlog.project.open(id); return null }
          catch (error) { return String(error) }
        }, b.id)
        expect(failure).toBeTruthy()
      }
      expect(readFileSync(rawPath, 'utf8')).toBe('original evidence bytes\n')
      expect(readFileSync(spoolPath, 'utf8')).toBe(spool)
      const active = await page.evaluate(() => window.redlog.project.active())
      if (fault === 'config-write') {
        expect(active?.id).toBe(a.id)
        expect(readFileSync(identityPath)).toEqual(identityA)
      } else {
        expect(active).toBeNull()
        expect(existsSync(identityPath)).toBe(false)
        const port = readFileSync(join(tmpHome, '.redlog', 'api-port'), 'utf8').trim()
        expect((await fetch(`http://127.0.0.1:${port}/api/whoami`)).status).toBe(503)
        // Reload must show the real recoverable state, not a half-open project.
        await page.reload()
        await expect(page.getByTestId('project-picker')).toBeVisible()
      }

      if (fault === 'config-write') {
        rmSync(configPath, { recursive: true })
        renameSync(`${configPath}.saved`, configPath)
      } else if (fault === 'db-open' || fault === 'db-pragma') {
        rmSync(dbPath, { recursive: true })
        renameSync(`${dbPath}.saved`, dbPath)
        for (const suffix of ['-wal', '-shm']) {
          if (existsSync(dbPath + suffix + '.saved')) renameSync(dbPath + suffix + '.saved', dbPath + suffix)
        }
      } else writeFileSync(configPath, config)

      // A must not consume B's pending evidence, even after a failed B open.
      await page.evaluate(id => window.redlog.project.open(id), a.id)
      expect(readFileSync(spoolPath, 'utf8')).toBe(spool)
      const inA = await page.evaluate(() => window.redlog.events.query({ agentType: 'shell' }))
      expect(inA.filter(e => e.data.command === 'echo rollback-proof')).toHaveLength(0)
      await page.evaluate(id => window.redlog.project.open(id), b.id)
      expect(existsSync(spoolPath)).toBe(false)
      const reopenedEvents = await page.evaluate(() => window.redlog.events.query({}))
      for (const event of originalEvents) expect(reopenedEvents.find(row => row.id === event.id)).toEqual(event)
      const afterFirst = await page.evaluate(() => window.redlog.events.query({ agentType: 'shell' }))
      const recovered = afterFirst.filter(e => e.data.command === 'echo rollback-proof')
      expect(recovered).toHaveLength(1)
      expect(recovered[0].engagementId).toBe(b.id)
      await page.evaluate(id => window.redlog.project.open(id), b.id)
      const afterRetry = await page.evaluate(() => window.redlog.events.query({ agentType: 'shell' }))
      expect(afterRetry.filter(e => e.data.command === 'echo rollback-proof')).toEqual(recovered)
      expect((await page.evaluate(() => window.redlog.chain.verify())).ok).toBe(true)
      expect(readFileSync(rawPath, 'utf8')).toBe('original evidence bytes\n')
    } catch (error) {
      console.log(`[project rollback] ${String(error)}`)
      throw error
    } finally {
      await app.close()
    }
  })
}
