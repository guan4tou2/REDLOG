import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { withManagedProxyEnv } from '../src/main/terminal-manager'

describe('built-in terminal managed proxy environment', () => {
  it('sets upper and lower case HTTP(S) variables while capture is live', () => {
    const env = withManagedProxyEnv({ PATH: '/bin' }, 'http://127.0.0.1:8080', true)
    expect(env).toMatchObject({
      PATH: '/bin',
      HTTP_PROXY: 'http://127.0.0.1:8080',
      HTTPS_PROXY: 'http://127.0.0.1:8080',
      http_proxy: 'http://127.0.0.1:8080',
      https_proxy: 'http://127.0.0.1:8080'
    })
  })

  it('does not inject the live proxy without explicit routing consent', () => {
    expect(withManagedProxyEnv({ PATH: '/bin' }, 'http://127.0.0.1:8080')).toEqual({ PATH: '/bin' })
  })

  it('does not invent a proxy when managed capture is stopped', () => {
    const env = withManagedProxyEnv({
      PATH: '/bin', HTTP_PROXY: 'http://stale', HTTPS_PROXY: 'http://stale',
      http_proxy: 'http://stale', https_proxy: 'http://stale'
    }, null)
    expect(env.PATH).toBe('/bin')
    expect(env.HTTP_PROXY).toBe('http://stale')
    expect(env.HTTPS_PROXY).toBe('http://stale')
    expect(env.http_proxy).toBe('http://stale')
    expect(env.https_proxy).toBe('http://stale')
  })

  it('keeps REDLOG hook transport outside the managed proxy', () => {
    // The Codex wrapper is a plugin's hook now (pack-ai-agents), not a
    // built-in one, but it posts to the same API and the rule is the same.
    const scripts = [
      join('hooks', 'shell-common.sh'),
      join('hooks', 'redlog-send.sh'),
      join('plugins', 'pack-ai-agents', 'hooks', 'codex-wrapper.sh')
    ]
    for (const file of scripts) {
      const source = readFileSync(join(process.cwd(), file), 'utf8')
      const internalCurlLines = source.split('\n').filter((line) => line.includes('curl ') && line.includes('/api/'))
      expect(internalCurlLines.length, file).toBeGreaterThan(0)
      expect(internalCurlLines.every((line) => line.includes("--noproxy '*'")), file).toBe(true)
    }
  })
})
