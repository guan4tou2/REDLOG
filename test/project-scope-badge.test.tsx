// @vitest-environment jsdom
//
// Spec 068 US2 (FR-013..FR-018): the scope badge in the project picker.
// The rules under test, in order of how badly breaking them would mislead:
//  - a scope that could not be read says "unknown", never "not set";
//  - while the answer has not arrived the badge is BLANK, never "not set";
//  - an answer belongs to a project id, not to a row position;
//  - the list is usable before, and without, the answer.

import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import ProjectPicker from '../src/renderer/src/components/ProjectPicker'
import { ToastContainer } from '../src/renderer/src/components/Toast'
import { I18nProvider } from '../src/renderer/src/i18n'

afterEach(() => { cleanup(); vi.restoreAllMocks(); window.localStorage.clear() })

const project = (id: string, name: string) => ({ id, name, createdAt: 1, lastOpened: 2, path: `/tmp/${id}`, dbSize: 1024 })
type Summary = { state: 'set'; count: number } | { state: 'unset' } | { state: 'unknown' }
type Summaries = Record<string, Summary>

function deferred<T>() {
  let resolve!: (v: T) => void
  let reject!: (e: unknown) => void
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

function mount(opts: { projects: ReturnType<typeof project>[]; scopeSummaries: () => Promise<Summaries>; list?: () => Promise<unknown> }) {
  const open = vi.fn(async (id: string) => project(id, id))
  ;(window as unknown as { redlog: unknown }).redlog = {
    project: {
      list: opts.list ?? (async () => opts.projects),
      scopeSummaries: opts.scopeSummaries,
      create: async (name: string) => project('new', name),
      open,
      delete: async () => true,
      rename: async (_id: string, name: string) => ({ ok: true, name })
    },
    config: { importProfile: async () => ({ status: 'cancelled' }), get: async () => ({}), save: async () => true },
    ip: { getStatus: async () => ({ internalIP: null }) }
  }
  render(<I18nProvider><ProjectPicker onProjectOpen={vi.fn()} /><ToastContainer /></I18nProvider>)
  return { open }
}

const rowOf = async (name: string) => (await screen.findByRole('button', { name })).closest('div') as HTMLElement
const badgeIn = (row: HTMLElement) => row.querySelector('[data-testid="project-scope-badge"]') as HTMLElement | null

describe('project scope badge', () => {
  it('shows the list and keeps it usable while the scope answer is pending; the badge stays blank', async () => {
    const pending = deferred<Summaries>()
    const { open } = mount({ projects: [project('a', 'Alpha')], scopeSummaries: () => pending.promise })
    const row = await rowOf('Alpha')
    expect(badgeIn(row)).toBeNull()
    expect(screen.queryByText(/not set|未設定/i)).toBeNull()
    fireEvent.doubleClick(screen.getByRole('button', { name: 'Alpha' }))
    await waitFor(() => expect(open).toHaveBeenCalledWith('a'))
  })

  it('words the three states: a neutral count, a hint for unset, a neutral unknown', async () => {
    mount({
      projects: [project('a', 'Alpha'), project('b', 'Beta'), project('c', 'Gamma'), project('d', 'Delta')],
      scopeSummaries: async () => ({
        a: { state: 'set', count: 3 }, b: { state: 'unset' }, c: { state: 'unknown' }, d: { state: 'set', count: 1 }
      })
    })
    await rowOf('Alpha')
    await waitFor(() => expect(badgeIn(screen.getByRole('button', { name: 'Alpha' }).closest('div') as HTMLElement)?.textContent).toBe('3 targets'))
    await waitFor(() => expect(within(screen.getByRole('button', { name: 'Beta' }).closest('div') as HTMLElement).getByTestId('project-scope-badge').textContent).toBe('Scope not set'))
    expect(within(screen.getByRole('button', { name: 'Gamma' }).closest('div') as HTMLElement).getByTestId('project-scope-badge').textContent).toBe('Scope unknown')
    expect(within(screen.getByRole('button', { name: 'Delta' }).closest('div') as HTMLElement).getByTestId('project-scope-badge').textContent).toBe('1 target')
  })

  it('"not set" is a hint, not an alarm: no alert role, no red', async () => {
    mount({ projects: [project('a', 'Alpha')], scopeSummaries: async () => ({ a: { state: 'unset' } }) })
    const badge = await waitFor(() => { const b = badgeIn(screen.getByRole('button', { name: 'Alpha' }).closest('div') as HTMLElement); expect(b).not.toBeNull(); return b as HTMLElement })
    expect(badge.getAttribute('role')).not.toBe('alert')
    // No red token (redlog-* is the app's own namespace, not the colour).
    expect(badge.className).not.toMatch(/(^|\s)(text|bg|border)-red-|danger/)
    expect(badge.textContent).not.toMatch(/warning|警告/i)
  })

  it('a failed query is "unknown" on every row, not "not set" and not blank; the list still opens', async () => {
    const { open } = mount({
      projects: [project('a', 'Alpha'), project('b', 'Beta')],
      scopeSummaries: async () => { throw new Error('ipc down') }
    })
    await waitFor(() => expect(badgeIn(screen.getByRole('button', { name: 'Alpha' }).closest('div') as HTMLElement)?.textContent).toBe('Scope unknown'))
    expect(badgeIn(screen.getByRole('button', { name: 'Beta' }).closest('div') as HTMLElement)?.textContent).toBe('Scope unknown')
    expect(screen.queryByText('Scope not set')).toBeNull()
    fireEvent.doubleClick(screen.getByRole('button', { name: 'Beta' }))
    await waitFor(() => expect(open).toHaveBeenCalledWith('b'))
  })

  it('one project missing from the answer is unknown for that row only', async () => {
    mount({ projects: [project('a', 'Alpha'), project('b', 'Beta')], scopeSummaries: async () => ({ a: { state: 'set', count: 2 } }) })
    await waitFor(() => expect(badgeIn(screen.getByRole('button', { name: 'Alpha' }).closest('div') as HTMLElement)?.textContent).toBe('2 targets'))
    expect(badgeIn(screen.getByRole('button', { name: 'Beta' }).closest('div') as HTMLElement)?.textContent).toBe('Scope unknown')
  })

  it('a malformed entry is unknown, not a crash and not "not set"', async () => {
    mount({ projects: [project('a', 'Alpha')], scopeSummaries: async () => ({ a: { state: 'weird' } } as unknown as Summaries) })
    await waitFor(() => expect(badgeIn(screen.getByRole('button', { name: 'Alpha' }).closest('div') as HTMLElement)?.textContent).toBe('Scope unknown'))
  })
})

describe('badge follows the project id, not the row', () => {
  const six = ['Alpha', 'Beta', 'Gamma', 'Delta', 'Epsilon', 'Zeta'].map((n, i) => project(`p${i}`, n))
  const answer: Summaries = {
    p0: { state: 'set', count: 1 }, p1: { state: 'set', count: 2 }, p2: { state: 'set', count: 3 },
    p3: { state: 'set', count: 4 }, p4: { state: 'set', count: 5 }, p5: { state: 'unset' }
  }

  it('filtering moves rows but each badge stays with its project', async () => {
    mount({ projects: six, scopeSummaries: async () => answer })
    await waitFor(() => expect(badgeIn(screen.getByRole('button', { name: 'Zeta' }).closest('div') as HTMLElement)?.textContent).toBe('Scope not set'))
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'gamma' } })
    expect(screen.queryByRole('button', { name: 'Alpha' })).toBeNull()
    expect(badgeIn(screen.getByRole('button', { name: 'Gamma' }).closest('div') as HTMLElement)?.textContent).toBe('3 targets')
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'zeta' } })
    expect(badgeIn(screen.getByRole('button', { name: 'Zeta' }).closest('div') as HTMLElement)?.textContent).toBe('Scope not set')
  })

  it('renaming a project keeps its badge', async () => {
    mount({ projects: six, scopeSummaries: async () => answer })
    await waitFor(() => expect(badgeIn(screen.getByRole('button', { name: 'Beta' }).closest('div') as HTMLElement)?.textContent).toBe('2 targets'))
    const betaRow = screen.getByRole('button', { name: 'Beta' }).closest('div') as HTMLElement
    fireEvent.click(within(betaRow).getByRole('button', { name: 'Rename' }))
    const field = screen.getByDisplayValue('Beta')
    fireEvent.change(field, { target: { value: 'Beta-2' } })
    fireEvent.keyDown(field, { key: 'Enter' })
    const renamed = await screen.findByRole('button', { name: 'Beta-2' })
    expect(badgeIn(renamed.closest('div') as HTMLElement)?.textContent).toBe('2 targets')
    expect(badgeIn(screen.getByRole('button', { name: 'Alpha' }).closest('div') as HTMLElement)?.textContent).toBe('1 target')
  })

  it('an answer for a project that no longer exists is ignored', async () => {
    mount({
      projects: [project('a', 'Alpha')],
      scopeSummaries: async () => ({ a: { state: 'set', count: 2 }, ghost: { state: 'set', count: 99 } })
    })
    await waitFor(() => expect(badgeIn(screen.getByRole('button', { name: 'Alpha' }).closest('div') as HTMLElement)?.textContent).toBe('2 targets'))
    expect(screen.queryByText('99 targets')).toBeNull()
  })

  it('a late answer from an earlier query is dropped after the list is read again', async () => {
    const first = deferred<Summaries>()
    const second = deferred<Summaries>()
    let calls = 0
    let listCalls = 0
    const list = vi.fn(async () => {
      listCalls++
      if (listCalls === 1) throw new Error('boom')
      return [project('a', 'Alpha')]
    })
    mount({ projects: [], list, scopeSummaries: () => (++calls === 1 ? first.promise : second.promise) })
    fireEvent.click(await screen.findByRole('button', { name: /retry/i }))
    await screen.findByRole('button', { name: 'Alpha' })
    await act(async () => { second.resolve({ a: { state: 'set', count: 7 } }) })
    await waitFor(() => expect(badgeIn(screen.getByRole('button', { name: 'Alpha' }).closest('div') as HTMLElement)?.textContent).toBe('7 targets'))
    // The first query answers last, with a different story. It must not land.
    await act(async () => { first.resolve({ a: { state: 'unset' } }) })
    expect(badgeIn(screen.getByRole('button', { name: 'Alpha' }).closest('div') as HTMLElement)?.textContent).toBe('7 targets')
  })
})
