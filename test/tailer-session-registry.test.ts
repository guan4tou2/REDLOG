import { describe, it, expect, afterEach } from 'vitest'
import { registerSessionId, isSessionRegistered, getRegisteredSessions, stopHost, configureHost, clearSessionRegistry } from '../src/main/services/tailer-host'
import { stopAgentTailer } from '../src/main/services/agent-tailer'

// #686: a registered session narrows AI capture to the registered ids only.
// That narrowing belongs to the engagement it was made in. `configureHost`
// stops the host on every settings save and plugin change, so the selection
// must survive `stopHost`; it ends only when the project closes or switches
// (stopProject → stopAgentTailer). The state is memory-only.
const identity = (engagementId: string) => ({ projectId: `p-${engagementId}`, engagementId, operatorId: 'op' })
// enabled:false keeps the host from opening a project database or watchers;
// the registry only reads `identity`.
const open = (engagementId: string) => configureHost({ enabled: false, enabledAgents: [], identity: identity(engagementId) })

describe('AI session registry', () => {
  afterEach(() => { clearSessionRegistry('eng-a'); clearSessionRegistry('eng-b'); stopHost() })

  it('passes every session while nothing is registered', () => {
    open('eng-a')
    expect(isSessionRegistered('any')).toBe(true)
  })

  it('excludes unregistered sessions once one is registered', () => {
    open('eng-a')
    registerSessionId('X')
    expect(isSessionRegistered('X')).toBe(true)
    expect(isSessionRegistered('Y')).toBe(false)
  })

  it('keeps the selection through a reconfiguration within the project (settings save, plugin change)', () => {
    open('eng-a')
    registerSessionId('X')
    configureHost({ emitThinking: true })
    stopHost()
    configureHost({ enabled: false, enabledAgents: [] })
    expect(getRegisteredSessions()).toEqual(['X'])
    expect(isSessionRegistered('Y')).toBe(false)
  })

  it("does not show project A's selection to project B", () => {
    open('eng-a')
    registerSessionId('X')
    open('eng-b')
    expect(getRegisteredSessions()).toEqual([])
    expect(isSessionRegistered('Y')).toBe(true)
  })

  it('starts empty when project A is closed and reopened', () => {
    open('eng-a')
    registerSessionId('X')
    stopAgentTailer()
    open('eng-a')
    expect(getRegisteredSessions()).toEqual([])
    expect(isSessionRegistered('Y')).toBe(true)
  })

  it('ignores a registration made with no project identity', () => {
    configureHost({ enabled: false, enabledAgents: [], identity: undefined })
    registerSessionId('X')
    open('eng-a')
    expect(getRegisteredSessions()).toEqual([])
  })
})
