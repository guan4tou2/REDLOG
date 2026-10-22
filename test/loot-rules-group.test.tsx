// @vitest-environment jsdom
import { describe, it, expect, afterEach, beforeEach } from 'vitest'
import { render, cleanup, screen, fireEvent, waitFor } from '@testing-library/react'
import LootRulesGroup from '../src/renderer/src/components/settings/LootRulesGroup'
import type { ConfigState } from '../src/renderer/src/components/settings/SettingsShared'

// Spec 032 — the Settings switches for loot rules.
const RULES = [
  { id: 'aws_key', type: 'aws_key', confidence: 'high', pluginId: null, description: 'AWS access key id' },
  { id: 'jwt', type: 'jwt', confidence: 'medium', pluginId: null },
  { id: 'acme-pack:acme-v2', type: 'acme_session', confidence: 'high', pluginId: 'acme-pack' }
]
const t = (k: string): string => k
const base = { loot: { disabledRules: ['jwt'] } } as unknown as ConfigState

describe('LootRulesGroup', () => {
  let rules: () => Promise<unknown>
  beforeEach(() => {
    rules = () => Promise.resolve(RULES)
    ;(window as unknown as { redlog: unknown }).redlog = { loot: { rules: () => rules() } }
  })
  afterEach(() => cleanup())

  it('shows one switch per rule, reflecting disabledRules', async () => {
    render(<LootRulesGroup config={base} setConfig={() => {}} t={t} />)
    await waitFor(() => expect(screen.getByTestId('loot-rule-aws_key')).toBeTruthy())
    expect((screen.getByTestId('loot-rule-aws_key') as HTMLInputElement).checked).toBe(true)
    expect((screen.getByTestId('loot-rule-jwt') as HTMLInputElement).checked).toBe(false)
    expect((screen.getByTestId('loot-rule-acme-pack:acme-v2') as HTMLInputElement).checked).toBe(true)
    expect(screen.getByText('settings.lootHint')).toBeTruthy()
  })

  it('switching a rule off or on edits disabledRules only', async () => {
    const seen: ConfigState[] = []
    render(<LootRulesGroup config={base} setConfig={(c) => seen.push(c)} t={t} />)
    await waitFor(() => expect(screen.getByTestId('loot-rule-acme-pack:acme-v2')).toBeTruthy())
    fireEvent.click(screen.getByTestId('loot-rule-acme-pack:acme-v2'))
    expect(seen.at(-1)!.loot!.disabledRules!.sort()).toEqual(['acme-pack:acme-v2', 'jwt'])
    fireEvent.click(screen.getByTestId('loot-rule-jwt'))
    expect(seen.at(-1)!.loot!.disabledRules).toEqual([])
  })

  it('marks a rule that was stopped for overrunning its time limit (Spec 033)', async () => {
    rules = () => Promise.resolve([...RULES.slice(0, 2), { ...RULES[2], stopped: 'time_limit' }])
    render(<LootRulesGroup config={base} setConfig={() => {}} t={t} />)
    await waitFor(() => expect(screen.getByTestId('loot-rule-stopped-acme-pack:acme-v2')).toBeTruthy())
    expect(screen.queryByTestId('loot-rule-stopped-aws_key')).toBeNull()
  })

  it('says when the rules could not be loaded instead of showing an empty list', async () => {
    rules = () => Promise.reject(new Error('ipc down'))
    render(<LootRulesGroup config={base} setConfig={() => {}} t={t} />)
    await waitFor(() => expect(screen.getByTestId('loot-rules-failed')).toBeTruthy())
  })

  // UIUX audit: a rule's id is an internal name (`ntlm_hash`), and what it
  // matches lived only in a `title`. A keyboard cannot reach a tooltip and a
  // screen reader does not read one, so the only text explaining the row was
  // unavailable to exactly the people who needed it.
  it('renders what a rule matches as text, not only as a tooltip', async () => {
    render(<LootRulesGroup config={base} setConfig={() => {}} t={t} />)
    await waitFor(() => expect(screen.getByTestId('loot-rule-desc-aws_key')).toBeTruthy())
    expect(screen.getByTestId('loot-rule-desc-aws_key').textContent).toBe('AWS access key id')
    // A rule the plugin did not describe shows no empty line.
    expect(screen.queryByTestId('loot-rule-desc-acme-pack:acme-v2')).toBeNull()
  })

  it('gives each rule switch an accessible name that includes what it matches', async () => {
    render(<LootRulesGroup config={base} setConfig={() => {}} t={t} />)
    const input = (await screen.findByTestId('loot-rule-aws_key')) as HTMLInputElement
    expect(input.getAttribute('aria-label')).toBe('aws_key — AWS access key id')
    // Without a description the type is still a usable name.
    expect((screen.getByTestId('loot-rule-acme-pack:acme-v2') as HTMLInputElement).getAttribute('aria-label')).toBe('acme_session')
  })
})
