import { test, expect } from '@playwright/test'
import fs from 'node:fs'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { launchWithTempHome } from './helpers'

const mount = process.env.REDLOG_ENOSPC_MOUNT

test('a real bounded filesystem full failure never acknowledges or poisons body evidence and can retry', async () => {
  test.skip(process.platform !== 'darwin' || !mount, 'Requires an explicitly mounted disposable <=80MiB fault volume')
  test.setTimeout(90000)
  const stats = fs.statfsSync(mount!)
  expect(stats.bsize * stats.blocks).toBeLessThanOrEqual(80 * 1024 * 1024)
  expect(stats.bsize * stats.blocks).toBeGreaterThan(1024 * 1024)
  const { app, page, tmpHome } = await launchWithTempHome(process.env.REDLOG_PACKAGED_APP)
  const filler = join(mount!, 'redlog-capacity-fill')
  let fd: number | undefined
  try {
    const project = await page.evaluate(() => window.redlog.project.create('real-enospc', { network: { offline: true } }))
    await page.evaluate(() => window.redlog.project.close())
    const relocated = join(mount!, project.id)
    fs.cpSync(project.path, relocated, { recursive: true })
    const indexPath = join(tmpHome, '.redlog', 'projects.json')
    const index = JSON.parse(fs.readFileSync(indexPath, 'utf8'))
    index.recent.find((entry: any) => entry.id === project.id).path = relocated
    fs.writeFileSync(indexPath, JSON.stringify(index))
    const opened = await page.evaluate(id => window.redlog.project.open(id), project.id)
    expect(opened.path).toBe(relocated)
    expect((await page.evaluate(() => window.redlog.project.active()))?.id).toBe(project.id)
    expect(fs.existsSync(join(relocated, 'timeline.db'))).toBe(true)
    const apiPort = fs.readFileSync(join(tmpHome, '.redlog', 'api-port'), 'utf8').trim()
    const token = fs.readFileSync(join(tmpHome, '.redlog', 'api-token'), 'utf8').trim()
    const post = (id: string, body: string) => fetch(`http://127.0.0.1:${apiPort}/api/events`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ agent_type: 'scanner', data: { subtype: 'http_response', flow_id: id, response_body: { data: body, encoding: 'text', size: Buffer.byteLength(body) } } }) })
    const original = 'existing immutable body'.repeat(512)
    expect((await post('before-full', original)).status).toBe(201)
    const originalFile = join(relocated, 'http-bodies', createHash('sha256').update(original).digest('hex')+'.body')
    expect(fs.readFileSync(originalFile, 'utf8')).toBe(original)
    fd = fs.openSync(filler, 'wx')
    let written = 0, full = false
    while (written <= 80 * 1024 * 1024) {
      try { const n = fs.writeSync(fd, Buffer.alloc(65536, 1)); written += n; if (!n) { full = true; break } }
      catch (error) { expect((error as NodeJS.ErrnoException).code).toBe('ENOSPC'); full = true; break }
    }
    fs.closeSync(fd); fd = undefined
    expect(full).toBe(true)
    const body = 'new body after full '.repeat(8192)
    const failed = await post('failed-write', body)
    expect(failed.status).toBe(500)
    expect((await failed.json()).error).toMatch(/ENOSPC|space|disk.*full/i)
    const file = join(relocated, 'http-bodies', createHash('sha256').update(body).digest('hex')+'.body')
    expect(fs.existsSync(file), 'failed writes must not publish a partial content-addressed body').toBe(false)
    expect(fs.readdirSync(join(relocated, 'http-bodies')).filter(name => name.endsWith('.tmp'))).toEqual([])
    fs.unlinkSync(filler)
    expect((await post('failed-write', body)).status).toBe(201)
    expect(fs.readFileSync(file, 'utf8')).toBe(body)
    expect(fs.readFileSync(originalFile, 'utf8')).toBe(original)
  } finally {
    if (fd !== undefined) fs.closeSync(fd)
    if (fs.existsSync(filler)) fs.unlinkSync(filler)
    await app.close()
  }
})
