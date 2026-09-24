// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { QueryReadout } from '../src/renderer/src/components/QueryReadout'
import { parseQuery } from '../src/core/query/contract'
import { I18nProvider } from '../src/renderer/src/i18n'

// Parsing rule 6 of the query contract: every surface shows how it read the
// query. Search and the Transcript each drew their own copy of that strip,
// worded differently, and spec 033 adds the Timeline as a third surface.
describe('QueryReadout: one read-out of how a query was read', () => {
  afterEach(() => cleanup())

  it('marks conditions and text, with one wording', () => {
    render(<I18nProvider><QueryReadout outcome={parseQuery('session:S1 timeout')} testId="x-query" unparsableTitle="n/a" /></I18nProvider>)
    const strip = screen.getByTestId('x-query-parse')
    const tokens = Array.from(strip.querySelectorAll('[data-token]'))
    expect(tokens.map((el) => [el.textContent, el.getAttribute('data-token')])).toEqual([
      ['session:S1', 'condition'], ['timeout', 'text']
    ])
    expect(tokens[0].getAttribute('title')).toBe('Condition: matched against the stored field')
    expect(tokens[1].getAttribute('title')).toBe('Text: matched as full text')
  })

  it('says why an input is unparsable, under the surface\'s own heading', () => {
    render(<I18nProvider><QueryReadout outcome={parseQuery('session:')} testId="x-query" unparsableTitle="Not applied" /></I18nProvider>)
    const box = screen.getByTestId('x-query-unparsable')
    expect(box.getAttribute('role')).toBe('status')
    expect(box.textContent).toContain('Not applied')
    expect(box.textContent).toContain('half-typed condition')
    expect(screen.queryByTestId('x-query-parse')).toBeNull()
  })

  it('draws nothing without a query', () => {
    const { container } = render(<I18nProvider><QueryReadout outcome={null} testId="x-query" unparsableTitle="n/a" /></I18nProvider>)
    expect(container.textContent).toBe('')
  })
})
