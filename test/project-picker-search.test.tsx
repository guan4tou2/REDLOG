// @vitest-environment jsdom
//
// Spec 068 S1, as revised for Stitch 01 (D1′, D3′): the search box is always
// shown; Enter opens the selected match (the first unless moved), never mid-IME.

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import ProjectPicker from '../src/renderer/src/components/ProjectPicker'
import { ToastContainer } from '../src/renderer/src/components/Toast'
import { I18nProvider } from '../src/renderer/src/i18n'
import { matchesQuery } from '../src/renderer/src/lib/textQuery'

vi.mock('../src/renderer/src/components/ConfirmDialog', () => ({ confirmChainImpact: async () => true }))

afterEach(() => { cleanup(); vi.restoreAllMocks(); window.localStorage.clear() })

const NAMES = ['Alpha Recon', 'Beta Web', 'Gamma Infra', 'Delta Cloud', 'Epsilon AD', 'Zeta Phish']
const project = (id: string, name: string) => ({ id, name, createdAt: 1, lastOpened: 2, path: `/tmp/${id}`, dbSize: 1024 })
const many = (n: number) => NAMES.slice(0, n).map((name, i) => project(`p${i}`, name))

function mount(projects: ReturnType<typeof project>[]) {
  const open = vi.fn(async (id: string) => project(id, id))
  ;(window as unknown as { redlog: unknown }).redlog = {
    project: { list: async () => projects, create: async (n: string) => project('new', n), open, delete: async () => true, rename: async () => ({ ok: true }) },
    config: { importProfile: async () => ({ status: 'cancelled' }), get: async () => ({}), save: async () => true },
    ip: { getStatus: async () => ({ internalIP: null }) }
  }
  render(<I18nProvider><ProjectPicker onProjectOpen={vi.fn()} /><ToastContainer /></I18nProvider>)
  return { open }
}
const box = () => screen.getByRole('searchbox', { name: 'Search projects' }) as HTMLInputElement
const type = (v: string) => fireEvent.change(box(), { target: { value: v } })
const enter = (init: Record<string, unknown> = {}) => fireEvent.keyDown(box(), { key: 'Enter', ...init })

describe('shared matcher (FR-002)', () => {
  it('is the whitespace-split AND match, case-insensitive', () => {
    expect(matchesQuery('Alpha Recon', 'alpha recon')).toBe(true)
    expect(matchesQuery('Alpha Recon', 'recon nope')).toBe(false)
    expect(matchesQuery('Alpha', '   ')).toBe(true)
  })
})

describe('search box visibility (FR-001, D1′)', () => {
  it('is shown whatever the number of projects', async () => {
    mount(many(1)); await screen.findByRole('button', { name: 'Alpha Recon' })
    expect(box()).toBeTruthy()
    cleanup()
    mount(many(6)); await screen.findByRole('button', { name: 'Alpha Recon' })
    expect(box()).toBeTruthy()
  })
  it('stays mounted and focused when a query leaves 1 or 0 results', async () => {
    mount(many(6)); await screen.findByRole('button', { name: 'Alpha Recon' })
    box().focus()
    type('beta'); expect(screen.getAllByRole('button', { name: /^(Alpha|Beta|Gamma|Delta|Epsilon|Zeta)/ })).toHaveLength(1)
    expect(document.activeElement).toBe(box())
    type('nothing'); expect(document.activeElement).toBe(box())
    expect(screen.getByTestId('project-search-count').textContent).toBe('0 / 6')
  })
})

describe('matching and states (FR-002, FR-003)', () => {
  it('matches the name only, not the path', async () => {
    mount(many(6)); await screen.findByRole('button', { name: 'Alpha Recon' })
    type('/tmp/p1')
    expect(screen.getByText('No project matches “/tmp/p1”')).toBeTruthy()
  })
  it('keeps the count honest and offers a clear that restores the full list', async () => {
    mount(many(6)); await screen.findByRole('button', { name: 'Alpha Recon' })
    expect(screen.getByTestId('project-search-count').textContent).toBe('6')
    type('a e')
    expect(screen.getByTestId('project-search-count').textContent).toMatch(/^\d \/ 6$/)
    type('zzz')
    fireEvent.click(screen.getByTestId('project-search-clear'))
    expect(box().value).toBe('')
    expect(screen.getByTestId('project-search-count').textContent).toBe('6')
  })
  it('keeps the box and the query when a deletion empties the matches', async () => {
    mount(many(6)); await screen.findByRole('button', { name: 'Alpha Recon' })
    type('beta')
    fireEvent.click(screen.getAllByRole('button', { name: 'Delete project' })[0])
    await waitFor(() => expect(screen.getByTestId('project-search-count').textContent).toBe('0 / 5'))
    expect(box().value).toBe('beta')
  })
})

describe('Enter in the search box (FR-004, D3′)', () => {
  it('opens the selected match — the first one, highlighted', async () => {
    const { open } = mount(many(6)); await screen.findByRole('button', { name: 'Alpha Recon' })
    type('ta')
    const first = screen.getByRole('button', { name: 'Beta Web' }).closest('[role="option"]')
    expect(first?.getAttribute('aria-selected')).toBe('true')
    enter()
    await waitFor(() => expect(open).toHaveBeenCalledWith('p1'))
  })
  it('does nothing when nothing matches, and keeps query and focus', async () => {
    const { open } = mount(many(6)); await screen.findByRole('button', { name: 'Alpha Recon' })
    box().focus()
    type('zzz'); enter(); expect(box().value).toBe('zzz')
    expect(open).not.toHaveBeenCalled()
    expect(document.activeElement).toBe(box())
  })
  it('does not open while an input method is composing', async () => {
    const { open } = mount(many(6)); await screen.findByRole('button', { name: 'Alpha Recon' })
    type('beta')
    fireEvent.keyDown(box(), { key: 'Enter', isComposing: true })
    fireEvent.keyDown(box(), { key: 'Enter', keyCode: 229 })
    expect(open).not.toHaveBeenCalled()
  })
  it('arrow keys in the box do not move through the list', async () => {
    mount(many(6)); await screen.findByRole('button', { name: 'Alpha Recon' })
    box().focus(); fireEvent.keyDown(box(), { key: 'ArrowDown' })
    expect(document.activeElement).toBe(box())
  })
})
