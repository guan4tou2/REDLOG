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

  it('says when the rules could not be loaded instead of showing an empty list', async () => {
    rules = () => Promise.reject(new Error('ipc down'))
    render(<LootRulesGroup config={base} setConfig={() => {}} t={t} />)
    await waitFor(() => expect(screen.getByTestId('loot-rules-failed')).toBeTruthy())
  })
})
