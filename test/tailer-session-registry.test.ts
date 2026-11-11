import { describe, it, expect, afterEach } from 'vitest'
import { registerSessionId, isSessionRegistered, getRegisteredSessions, stopHost } from '../src/main/services/tailer-host'

// #686: a registered session narrows AI capture to the registered ids only.
// That narrowing belongs to the project it was made in. Project close and
// switch both run stopProject → stopAgentTailer → configureHost → stopHost
// (src/main/index.ts), so stopHost is where the registry has to empty.
describe('AI session registry', () => {
  afterEach(() => stopHost())

  it('passes every session while nothing is registered', () => {
    expect(isSessionRegistered('any')).toBe(true)
  })

  it('excludes unregistered sessions once one is registered', () => {
    registerSessionId('X')
    expect(isSessionRegistered('X')).toBe(true)
    expect(isSessionRegistered('Y')).toBe(false)
  })

  it('lets an unregistered session pass again after the host stops (project close/switch)', () => {
    registerSessionId('X')
    expect(isSessionRegistered('Y')).toBe(false)
    stopHost()
    expect(getRegisteredSessions()).toEqual([])
    expect(isSessionRegistered('Y')).toBe(true)
  })
})
