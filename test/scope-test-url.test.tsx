// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import { testScopeSubject } from '../src/renderer/src/lib/scopeTest'
import ScopePage from '../src/renderer/src/components/settings/ScopePage'
import { I18nProvider } from '../src/renderer/src/i18n'
import en from '../src/renderer/src/i18n/en.json'

const policy = (targets: string[], excludeTargets: string[] = []) => ({ targets, excludeTargets })

describe('testing a URL against the scope lists', () => {
  it('says nothing for empty input, and "unknown" for text that names no host', () => {
    expect(testScopeSubject('   ', policy(['a.com']))).toEqual({ kind: 'empty' })
    expect(testScopeSubject('not a host!', policy(['a.com']))).toEqual({ kind: 'unknown' })
    expect(testScopeSubject('https://', policy(['a.com']))).toEqual({ kind: 'unknown' })
  })

  it('keeps "no scope set" apart from "in scope"', () => {
    expect(testScopeSubject('app.example.com', policy([]))).toEqual({ kind: 'unset' })
    // Exclusions alone are still "no allowlist" for a host they do not name.
    expect(testScopeSubject('app.example.com', policy([], ['login.example.com']))).toEqual({ kind: 'unset' })
  })

  it('reports the rule that matched, from a URL with a path, port and credentials', () => {
    expect(testScopeSubject('https://user@app.example.com:8443/x?y=1', policy(['*.example.com'])))
      .toEqual({ kind: 'in-scope', matchedBy: '*.example.com', viaWildcard: true })
    expect(testScopeSubject('10.0.0.7', policy(['10.0.0.0/24'])))
      .toEqual({ kind: 'in-scope', matchedBy: '10.0.0.0/24', viaWildcard: false })
  })

  it('lets an exclusion win, and says so when an inclusion also matched', () => {
    expect(testScopeSubject('login.example.com', policy(['*.example.com'], ['login.example.com'])))
      .toEqual({ kind: 'excluded', matchedBy: 'login.example.com', alsoIncluded: true })
    expect(testScopeSubject('x.other.com', policy(['*.example.com'], ['x.other.com'])))
      .toEqual({ kind: 'excluded', matchedBy: 'x.other.com', alsoIncluded: false })
  })

  it('names the subdomain gap a plain domain leaves, instead of silently widening it', () => {
    const r = testScopeSubject('app.example.com', policy(['example.com']))
    expect(r).toMatchObject({ kind: 'out-of-scope', subdomainOf: 'example.com' })
    // The wildcard form is what covers it.
    expect(testScopeSubject('app.example.com', policy(['*.example.com']))).toMatchObject({ kind: 'in-scope' })
    // The bare name is matched by the plain rule.
    expect(testScopeSubject('example.com', policy(['example.com']))).toMatchObject({ kind: 'in-scope' })
  })

  it('does not call an unrelated host a subdomain gap', () => {
    expect(testScopeSubject('evil.com', policy(['example.com']))).toEqual({ kind: 'out-of-scope', adjacentDomain: false, subdomainOf: null })
  })
})

describe('Settings ▸ Scope: the test field', () => {
  const t = (key: string, vars?: Record<string, string | number>): string =>
    ((en as Record<string, string>)[key] ?? key).replace(/\{\{(\w+)\}\}/g, (_, k) => String(vars?.[k] ?? ''))
  const config = { scope: { targets: ['example.com'], excludeTargets: ['login.example.com'], personalDomains: [], warnOnViolation: true, scopeFile: '' } }

  const draw = (): void => {
    localStorage.setItem('redlog-locale', 'en')
    render(<I18nProvider><ScopePage config={config as never} setConfig={() => {}} t={t} /></I18nProvider>)
  }

  it('keeps the same input while typing, and shows the verdict with its rule', () => {
    draw()
    const input = screen.getByRole('textbox', { name: /URL, host or IP/ }) as HTMLInputElement
    input.focus()
    fireEvent.change(input, { target: { value: 'https://app.example.com/' } })
    // Same element and still focused: it was not remounted by the render.
    expect(screen.getByRole('textbox', { name: /URL, host or IP/ })).toBe(input)
    expect(document.activeElement).toBe(input)
    const verdict = screen.getByTestId('scope-test-verdict')
    expect(verdict.textContent).toContain('Out of scope')
    expect(verdict.textContent).toContain('Add *.example.com')

    fireEvent.change(input, { target: { value: 'login.example.com' } })
    expect(screen.getByTestId('scope-test-verdict').textContent).toContain('Excluded — matches login.example.com')
    cleanup()
  })

  it('shows no verdict before anything is typed', () => {
    draw()
    expect(screen.queryByTestId('scope-test-verdict')).toBeNull()
    cleanup()
  })
})
