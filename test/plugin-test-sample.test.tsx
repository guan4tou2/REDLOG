// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import { testSample, TEST_SAMPLE_MAX_CHARS } from '../src/core/plugins/test-sample'
import { registerLootPatterns, unregisterLootPatterns, listLootRules, _shutdownLootWorker } from '../src/core/loot-detector'
import { registerCommandTags, unregisterCommandTags } from '../src/core/command-tagger'
import { PluginSampleTester } from '../src/renderer/src/components/settings/PluginSampleTester'
import en from '../src/renderer/src/i18n/en.json'

// #348: try a rule on pasted text before a session depends on it. The dry run
// must show which rule matched, mask what it found, and write nothing.

vi.mock('../src/core/db/events', () => ({ insertEvent: vi.fn(() => { throw new Error('a dry run must not write evidence') }) }))

describe('testSample (dry run)', () => {
  afterEach(async () => {
    unregisterLootPatterns('acme'); unregisterCommandTags('acme'); await _shutdownLootWorker()
  })

  it('names the plugin rule that matched and masks its value', () => {
    registerLootPatterns('acme', [{ type: 'acme_session', pattern: 'ACME-[A-Z0-9]{16}', name: 'acme-v2' }])
    const r = testSample('curl -H "X: ACME-ABCD1234EFGH5678" https://example.com/x')
    expect(r.loot).toEqual([{ type: 'acme_session', confidence: 'medium', reported: true, pluginId: 'acme', patternName: 'acme-v2' }])
    expect(r.masked).not.toContain('ACME-ABCD1234EFGH5678')
    expect(r.masked).toContain('•')
    expect(r.maskedSpans).toBeGreaterThan(0)
  })

  it('shows what live capture would do: a match shorter than a redaction token is found but not masked', () => {
    registerLootPatterns('acme', [{ type: 'acme_session', pattern: 'ACME-[A-Z0-9]{8}' }])
    const r = testSample('ACME-ABCD1234')
    expect(r.loot).toHaveLength(1)
    expect(r.maskedSpans).toBe(0)
    expect(r.masked).toBe('ACME-ABCD1234')
  })

  it('shows a rule this project has switched off as matching but not recorded', () => {
    const r = testSample('token eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghijklmnopqrstuv', { disabledRules: ['jwt'] })
    const jwt = r.loot.find((h) => h.type === 'jwt')
    expect(jwt?.reported).toBe(false)
    expect(testSample('token eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghijklmnopqrstuv').loot.find((h) => h.type === 'jwt')?.reported).toBe(true)
  })

  it('does not leave a live rule stopped because a pasted sample was slow, and says so', () => {
    registerLootPatterns('acme', [{ type: 'evil', pattern: '(a+)+$', name: 'backtrack' }])
    const r = testSample('a'.repeat(32) + '!')
    expect(r.overran).toEqual(['acme:backtrack'])
    expect(listLootRules().find((x) => x.id === 'acme:backtrack')?.stopped).toBeUndefined()
  })

  it('reports the tags a plugin would stamp', () => {
    registerCommandTags('acme', [{ name: 'scan', match: '^nmap\\b', stamp: { phase: 'recon' } }])
    expect(testSample('nmap -sV 10.0.0.5').tags).toEqual({ phase: 'recon' })
    expect(testSample('ls -la').tags).toEqual({})
  })

  it('says nothing matched rather than inventing a result', () => {
    const r = testSample('hello world')
    expect(r.loot).toEqual([])
    expect(r.masked).toBe('hello world')
    expect(r.maskedSpans).toBe(0)
  })

  it('does not write evidence (insertEvent throws if reached)', () => {
    registerLootPatterns('acme', [{ type: 'acme_session', pattern: 'ACME-[A-Z0-9]{8}' }])
    expect(() => testSample('ACME-ABCD1234')).not.toThrow()
  })

  it('caps the sample and says so', () => {
    const r = testSample('a '.repeat(TEST_SAMPLE_MAX_CHARS))
    expect(r.truncated).toBe(true)
    expect(r.masked.length).toBeLessThanOrEqual(TEST_SAMPLE_MAX_CHARS)
  })
})

describe('PluginSampleTester', () => {
  afterEach(() => cleanup())
  const t = (k: string, v?: Record<string, string | number>): string =>
    ((en as Record<string, string>)[k] ?? k).replace(/\{\{(\w+)\}\}/g, (_, n) => String(v?.[n] ?? ''))
  const install = (fn: unknown): void => { (window as unknown as { redlog: unknown }).redlog = { plugins: { testSample: fn } } }

  it('shows rule, target and tags from the dry run and never the raw secret', async () => {
    install(vi.fn().mockResolvedValue({
      masked: 'curl ••••••••••', maskedSpans: 1, truncated: false,
      loot: [{ type: 'acme_session', confidence: 'medium', reported: true, pluginId: 'acme', patternName: 'acme-v2' }],
      overran: [],
      target: { host: 'example.com', pluginId: 'acme', extractorName: 'x' }, tags: { phase: 'recon' }
    }))
    render(<PluginSampleTester t={t} />)
    fireEvent.change(screen.getByTestId('plugin-sample-input'), { target: { value: 'curl ACME-ABCD1234' } })
    fireEvent.click(screen.getByTestId('plugin-sample-run'))
    const box = await screen.findByTestId('plugin-sample-result')
    expect(box.textContent).toContain('acme:acme-v2')
    expect(box.textContent).toContain('example.com (acme:x)')
    expect(box.textContent).toContain('phase=recon')
    expect(box.textContent).not.toContain('ACME-ABCD1234')
  })

  it('says none when nothing matched, and says when the test could not run', async () => {
    install(vi.fn().mockResolvedValueOnce({ masked: 'x', maskedSpans: 0, truncated: false, overran: [], loot: [], target: { host: null }, tags: {} })
      .mockRejectedValueOnce(new Error('ipc')))
    render(<PluginSampleTester t={t} />)
    fireEvent.change(screen.getByTestId('plugin-sample-input'), { target: { value: 'x' } })
    fireEvent.click(screen.getByTestId('plugin-sample-run'))
    expect((await screen.findByTestId('plugin-sample-result')).textContent).toContain('none')
    fireEvent.click(screen.getByTestId('plugin-sample-run'))
    expect(await screen.findByRole('alert')).toBeTruthy()
    expect(screen.queryByTestId('plugin-sample-result')).toBeNull()
  })

  it('flags a switched-off rule and a rule that was cut off', async () => {
    install(vi.fn().mockResolvedValue({
      masked: 'x', maskedSpans: 0, truncated: false, overran: ['acme:backtrack'],
      loot: [{ type: 'jwt', confidence: 'medium', reported: false }], target: { host: null }, tags: {}
    }))
    render(<PluginSampleTester t={t} />)
    fireEvent.change(screen.getByTestId('plugin-sample-input'), { target: { value: 'x' } })
    fireEvent.click(screen.getByTestId('plugin-sample-run'))
    const box = await screen.findByTestId('plugin-sample-result')
    expect(box.textContent).toContain('switched off in this project')
    expect(box.textContent).toContain('acme:backtrack')
  })

  it('does not run on empty input', () => {
    install(vi.fn())
    render(<PluginSampleTester t={t} />)
    expect((screen.getByTestId('plugin-sample-run') as HTMLButtonElement).disabled).toBe(true)
  })
})
