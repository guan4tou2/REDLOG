// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react'
import fs from 'fs'
import os from 'os'
import path from 'path'
import ScopePage from '../src/renderer/src/components/settings/ScopePage'
import { I18nProvider } from '../src/renderer/src/i18n'
import { readScopeFile, loadScopeFile } from '../src/core/config'
import en from '../src/renderer/src/i18n/en.json'

// The enforced scope is the config lists PLUS the scope file. The tester read
// only the lists, and an unreadable file looked the same as an empty one.

const t = (key: string, vars?: Record<string, string | number>): string =>
  ((en as Record<string, string>)[key] ?? key).replace(/\{\{(\w+)\}\}/g, (_, k) => String(vars?.[k] ?? ''))

describe('readScopeFile', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'redlog-scope-'))
  const write = (name: string, body: string): string => { const p = path.join(dir, name); fs.writeFileSync(p, body); return p }

  it('says why nothing came back', () => {
    expect(readScopeFile(path.join(dir, 'missing.txt'))).toEqual({ ok: false, reason: 'unreadable' })
    expect(readScopeFile(write('bad.json', '{not json'))).toEqual({ ok: false, reason: 'invalid' })
  })
  it('reads text, JSON arrays and Burp-style scope, and an empty file is ok with no entries', () => {
    expect(readScopeFile(write('a.txt', '# c\nfoo.test\n\n*.bar.test\n'))).toEqual({ ok: true, entries: ['foo.test', '*.bar.test'] })
    expect(readScopeFile(write('a.json', '["x.test", 3]'))).toEqual({ ok: true, entries: ['x.test'] })
    expect(readScopeFile(write('b.json', JSON.stringify({ target: { scope: [{ host: '^\\Qapp.test\\E$' }] } })))).toMatchObject({ ok: true })
    expect(readScopeFile(write('empty.txt', '# nothing\n'))).toEqual({ ok: true, entries: [] })
  })
  it('keeps loadScopeFile returning [] on any failure, as enforcement expects', () => {
    expect(loadScopeFile(path.join(dir, 'missing.txt'))).toEqual([])
    expect(loadScopeFile(write('c.txt', 'z.test'))).toEqual(['z.test'])
  })
  afterEach(() => undefined)
})

describe('Settings ▸ Scope tester with a scope file', () => {
  afterEach(() => { cleanup(); localStorage.clear() })
  const config = { scope: { targets: [] as string[], excludeTargets: [] as string[], personalDomains: [], warnOnViolation: true, scopeFile: '/x/scope.txt' } }
  const draw = (fileInForce: unknown): void => {
    localStorage.setItem('redlog-locale', 'en')
    ;(window as unknown as { redlog: unknown }).redlog = { scope: { fileInForce } }
    render(<I18nProvider><ScopePage config={config as never} setConfig={() => {}} t={t} /></I18nProvider>)
  }
  const test = (value: string): void => {
    fireEvent.change(screen.getByRole('textbox', { name: /URL, host or IP/ }), { target: { value } })
  }

  it('counts a host listed only in the file as in scope, and not as "no scope"', async () => {
    draw(vi.fn().mockResolvedValue({ path: '/x/scope.txt', ok: true, entries: ['filed.test'] }))
    expect((await screen.findByTestId('scope-file-state')).textContent).toContain('1 entries')
    test('filed.test')
    const verdict = screen.getByTestId('scope-test-verdict').textContent ?? ''
    expect(verdict).not.toContain('Out of scope')
    expect(verdict).not.toContain('No scope')
  })

  it('warns that an unreadable scope file is NOT in force, instead of reading as empty', async () => {
    draw(vi.fn().mockResolvedValue({ path: '/x/scope.txt', ok: false, reason: 'unreadable' }))
    const note = await screen.findByTestId('scope-file-state')
    expect(note.getAttribute('role')).toBe('alert')
    expect(note.textContent).toContain('could not be read')
    expect(note.textContent).toContain('/x/scope.txt')
  })

  it('says a file that was read but has no entries adds nothing', async () => {
    draw(vi.fn().mockResolvedValue({ path: '/x/scope.txt', ok: true, entries: [] }))
    expect((await screen.findByTestId('scope-file-state')).textContent).toContain('no entries')
  })

  it('says it could not check when the lookup itself fails', async () => {
    draw(vi.fn().mockRejectedValue(new Error('ipc')))
    expect((await screen.findByTestId('scope-file-state')).textContent).toContain('may not match what is enforced')
  })

  it('shows nothing about a file when none is configured', async () => {
    const f = vi.fn().mockResolvedValue(null)
    draw(f)
    await waitFor(() => expect(f).toHaveBeenCalled())
    expect(screen.queryByTestId('scope-file-state')).toBeNull()
  })
})
