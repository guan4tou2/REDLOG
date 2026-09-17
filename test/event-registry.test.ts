import { describe, it, expect, beforeEach } from 'vitest'
import { registerEventTypes, unregisterEventTypes, getEventTypes } from '../src/core/event-registry'

describe('event-registry', () => {
  beforeEach(() => {
    // Clear all registered types between tests by unregistering known plugins.
    for (const def of getEventTypes()) {
      unregisterEventTypes(def.pluginId)
    }
  })

  it('starts empty', () => {
    expect(getEventTypes()).toEqual([])
  })

  it('registers event types for a plugin', () => {
    registerEventTypes('my-plugin', [
      { agentType: 'burp', label: 'Burp Suite' },
      { agentType: 'zap', label: 'OWASP ZAP', lane: 'scanner', color: '#f00', icon: 'zap' }
    ])

    const types = getEventTypes()
    expect(types).toHaveLength(2)
    expect(types.find(t => t.agentType === 'burp')).toMatchObject({
      agentType: 'burp',
      label: 'Burp Suite',
      pluginId: 'my-plugin'
    })
    expect(types.find(t => t.agentType === 'zap')).toMatchObject({
      agentType: 'zap',
      label: 'OWASP ZAP',
      lane: 'scanner',
      color: '#f00',
      icon: 'zap',
      pluginId: 'my-plugin'
    })
  })

  it('skips definitions with missing agentType or label', () => {
    registerEventTypes('skip-plugin', [
      { agentType: '', label: 'Missing type' },
      { agentType: 'valid', label: '' },
      { agentType: 'good', label: 'Good One' }
    ])

    const types = getEventTypes()
    expect(types).toHaveLength(1)
    expect(types[0].agentType).toBe('good')
  })

  it('unregisters all event types for a specific plugin', () => {
    registerEventTypes('plugin-a', [
      { agentType: 'scan', label: 'Scanner' }
    ])
    registerEventTypes('plugin-b', [
      { agentType: 'recon', label: 'Recon' }
    ])

    expect(getEventTypes()).toHaveLength(2)

    unregisterEventTypes('plugin-a')

    const remaining = getEventTypes()
    expect(remaining).toHaveLength(1)
    expect(remaining[0].pluginId).toBe('plugin-b')
  })

  it('unregistering a non-existent plugin is a no-op', () => {
    registerEventTypes('exists', [{ agentType: 'x', label: 'X' }])
    unregisterEventTypes('does-not-exist')
    expect(getEventTypes()).toHaveLength(1)
  })

  it('keys by pluginId:agentType so two plugins can use the same agentType', () => {
    registerEventTypes('plugin-a', [{ agentType: 'http', label: 'HTTP A' }])
    registerEventTypes('plugin-b', [{ agentType: 'http', label: 'HTTP B' }])

    const types = getEventTypes()
    expect(types).toHaveLength(2)
    const labels = types.map(t => t.label).sort()
    expect(labels).toEqual(['HTTP A', 'HTTP B'])
  })

  it('overwrites when the same plugin registers the same agentType again', () => {
    registerEventTypes('plugin-a', [{ agentType: 'http', label: 'V1' }])
    registerEventTypes('plugin-a', [{ agentType: 'http', label: 'V2' }])

    const types = getEventTypes()
    expect(types).toHaveLength(1)
    expect(types[0].label).toBe('V2')
  })

  it('preserves optional fields when absent', () => {
    registerEventTypes('bare', [{ agentType: 'min', label: 'Minimal' }])

    const def = getEventTypes()[0]
    expect(def.lane).toBeUndefined()
    expect(def.color).toBeUndefined()
    expect(def.icon).toBeUndefined()
  })
})
