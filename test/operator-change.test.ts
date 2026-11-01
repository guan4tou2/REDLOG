import { describe, it, expect, vi } from 'vitest'
import { ProjectRuntime } from '../src/core/project-runtime'
import { applyOperatorChange } from '../src/main/operator-change'

// Settings can change the operator while the project stays open, and it takes
// effect for every source at once. The sources inside the app hold the open's
// context and see it from there; these are the two that live outside it: the
// identity file the shell hooks and HTTP addon stamp captures from, and the
// API's primary operator, who a request with the project token is.

const PROJECT = { id: 'p-a', name: 'Alpha', createdAt: 1, lastOpened: 2, path: '/projects/a' }
const OP_A = { id: 'op-a', name: 'Alice' }

function setup() {
  const runtime = new ProjectRuntime()
  const open = runtime.begin(PROJECT, { engagementId: 'eng-a', operatorId: OP_A.id })
  runtime.activate(open)
  const sinks = { writeSpoolIdentity: vi.fn(), setPrimaryOperator: vi.fn() }
  return { runtime, open, sinks }
}

describe('applyOperatorChange', () => {
  it('moves the open, the identity file and the API to the new operator', () => {
    const { runtime, open, sinks } = setup()
    applyOperatorChange(runtime, open, OP_A, { id: 'op-b', name: 'Bob' }, sinks)
    expect(open.operatorId).toBe('op-b')
    expect(open.engagementId).toBe('eng-a')
    expect(sinks.writeSpoolIdentity).toHaveBeenCalledWith(open)
    expect(sinks.setPrimaryOperator).toHaveBeenCalledWith('op-b', 'Bob')
  })

  it('renames the API operator without rewriting the identity file', () => {
    const { runtime, open, sinks } = setup()
    applyOperatorChange(runtime, open, OP_A, { id: 'op-a', name: 'Alice B.' }, sinks)
    expect(sinks.writeSpoolIdentity).not.toHaveBeenCalled()
    expect(sinks.setPrimaryOperator).toHaveBeenCalledWith('op-a', 'Alice B.')
  })

  it('touches nothing on a save that leaves the operator alone', () => {
    // Settings autosaves on every edit; most of them are not about the operator.
    const { runtime, open, sinks } = setup()
    applyOperatorChange(runtime, open, OP_A, { ...OP_A }, sinks)
    expect(sinks.writeSpoolIdentity).not.toHaveBeenCalled()
    expect(sinks.setPrimaryOperator).not.toHaveBeenCalled()
  })

  it('does not relabel an open that has ended', () => {
    const { runtime, open, sinks } = setup()
    runtime.close()
    applyOperatorChange(runtime, open, OP_A, { id: 'op-b', name: 'Bob' }, sinks)
    expect(open.operatorId).toBe('op-a')
    expect(sinks.writeSpoolIdentity).not.toHaveBeenCalled()
    expect(sinks.setPrimaryOperator).not.toHaveBeenCalled()
  })
})
