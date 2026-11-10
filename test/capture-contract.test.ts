import { expect, it } from 'vitest'
import { captureFacts } from '../src/core/capture-contract'
import { httpCaptureState } from '../src/renderer/src/lib/httpCaptureState'

it('does not turn saved data, an enabled source or a live process into a connection or verification claim', () => {
  const source = { state: 'ready' as const, installed: true, enabled: true, lastEventAt: 1 }
  const stopped = captureFacts(source, { state: 'stopped' })
  expect(stopped).toMatchObject({ read: 'ok', configuration: 'configured', service: 'stopped', connection: 'unknown', data: 'observed', lastStoredAt: 1 })
  expect(httpCaptureState(source, { state: 'stopped' })).toBe('recorded')
  expect(captureFacts(source, { state: 'running' })).toMatchObject({ service: 'running', connection: 'unknown' })
  expect(captureFacts(source, { state: 'running', connected: false }).connection).toBe('disconnected')
})

it('preserves history after a failed read while every current-state claim becomes unknown', () => {
  const source = { state: 'ready' as const, lastEventAt: 1 }
  expect(captureFacts(source, { state: 'running', connected: true }, 'unknown')).toMatchObject({
    read: 'unknown', configuration: 'unknown', service: 'unknown', connection: 'unknown', capability: 'unknown', data: 'history', lastStoredAt: 1
  })
  expect(httpCaptureState(source, { state: 'running' }, 'unknown')).toBe('unknown')
  expect(captureFacts(undefined, undefined, 'unknown').data).toBe('unknown')
})
