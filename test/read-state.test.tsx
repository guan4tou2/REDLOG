// @vitest-environment jsdom
//
// The shared three-phase read state behind the project list, the cast index
// status and the agent-type facets (#298).

import { act, renderHook, waitFor } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import {
  initialRead, readStarted, readSucceeded, readFailed, readValueUpdated, useReadState
} from '../src/renderer/src/lib/readState'
import { indexStatusOf } from '../src/renderer/src/lib/castIndexStatus'

describe('read state transitions', () => {
  it('starts loading with no value', () => {
    expect(initialRead<number[]>()).toEqual({ phase: 'loading', value: null })
  })

  it('a failed refresh keeps what was known', () => {
    const known = readSucceeded([1, 2])
    expect(readFailed(readStarted(known), 'boom')).toEqual({ phase: 'failed', value: [1, 2], error: 'boom' })
  })

  it('a refresh in flight keeps the value and is loading again', () => {
    expect(readStarted(readSucceeded([1]))).toEqual({ phase: 'loading', value: [1] })
  })

  it('an edit to the value does not change the phase', () => {
    const failed = readFailed(readSucceeded([1]), 'boom')
    expect(readValueUpdated(failed, [1, 2])).toEqual({ phase: 'failed', value: [1, 2], error: 'boom' })
  })
})

describe('useReadState', () => {
  it('failure then retry then success', async () => {
    let n = 0
    const { result } = renderHook(() => useReadState(async () => {
      if (n++ === 0) throw new Error('first')
      return ['x']
    }))
    await waitFor(() => expect(result.current.state.phase).toBe('failed'))
    expect(result.current.state.value).toBeNull()
    act(() => result.current.retry())
    await waitFor(() => expect(result.current.state).toEqual({ phase: 'loaded', value: ['x'] }))
  })

  it('a failed refresh after a good read keeps the good value', async () => {
    let n = 0
    const { result } = renderHook(() => useReadState(async () => {
      if (n++ === 0) return ['x']
      throw new Error('later')
    }))
    await waitFor(() => expect(result.current.state.phase).toBe('loaded'))
    act(() => result.current.retry())
    await waitFor(() => expect(result.current.state.phase).toBe('failed'))
    expect(result.current.state.value).toEqual(['x'])
  })

  it('a synchronous throw from the loader is a failure, not a crash', async () => {
    const { result } = renderHook(() => useReadState<string[]>(() => { throw new Error('sync') }))
    await waitFor(() => expect(result.current.state.phase).toBe('failed'))
  })

  it('does not call the loader while disabled', () => {
    let called = 0
    const { result } = renderHook(() => useReadState(async () => { called++; return 1 }, false))
    expect(called).toBe(0)
    expect(result.current.state.phase).toBe('loading')
  })
})

describe('indexStatusOf', () => {
  it('maps each read state to exactly one index status', () => {
    expect(indexStatusOf(initialRead()).kind).toBe('unknown')
    expect(indexStatusOf(readSucceeded({ pending: 0 })).kind).toBe('ready')
    expect(indexStatusOf(readSucceeded({ pending: 4 }))).toEqual({ kind: 'pending', pending: 4 })
    expect(indexStatusOf(readFailed(initialRead(), 'x')).kind).toBe('failed')
  })

  it('a stale ready value does not survive a failed re-read', () => {
    expect(indexStatusOf(readFailed(readSucceeded({ pending: 0 }), 'x')).kind).toBe('failed')
  })

  it('does not declare unsupported or unavailable recordings fully indexed', () => {
    expect(indexStatusOf(readSucceeded({pending:0,unsupported:1})).kind).toBe('partial')
    expect(indexStatusOf(readSucceeded({pending:0,unavailable:1})).kind).toBe('partial')
  })

  it('a malformed answer is a failure, never ready', () => {
    for (const bad of [null, undefined, {}, { pending: '0' }, { pending: NaN }, { pending: -1 }]) {
      expect(indexStatusOf(readSucceeded(bad as never)).kind).toBe('failed')
    }
  })
})
