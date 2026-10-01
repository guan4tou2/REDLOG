// The join that was wired end to end and could never fire.
//
// A shell `preexec` hook runs before the fork, so it cannot know the pid of
// the command it is about to announce — it sends `$$`, the shell's. The
// socket, meanwhile, is opened by the child (`dirb`, `sqlmap`), and that is
// the pid the socket table reports. So `pidCmd` was keyed on the shell and
// `portPid` on its child, and the two maps could never meet: every HTTP flow
// resolved to nothing, silently, while the whole path looked connected.
// `process-monitor.ts` records the same discovery from the other side —
// `findCauseSession()` was deleted because it always returned undefined.
//
// Only the OS knows the link. These cover the walk that uses it, and the
// limits that keep it from inventing one.

import { describe, it, expect, beforeEach } from 'vitest'
import {
  noteCommandPid, noteProcessParent, notePortPid,
  resolveByPid, resolveByLocalPort, socketCausesFor,
  _resetSocketAttribution, MAX_ANCESTRY_DEPTH
} from '../src/core/socket-attribution'

const SHELL = 500
const TOOL = 900

beforeEach(_resetSocketAttribution)

describe('a tool forked by a hooked shell', () => {
  it('resolves the socket owner to the command the shell announced', () => {
    noteCommandPid(SHELL, 'cmd-dirb')
    noteProcessParent(TOOL, SHELL)
    expect(resolveByPid(TOOL)).toBe('cmd-dirb')
  })

  it('resolves through a wrapper — sudo, proxychains, a script', () => {
    noteCommandPid(SHELL, 'cmd-dirb')
    noteProcessParent(700, SHELL)   // sudo
    noteProcessParent(TOOL, 700)    // dirb
    expect(resolveByPid(TOOL)).toBe('cmd-dirb')
  })

  it('still answers for the shell itself', () => {
    noteCommandPid(SHELL, 'cmd-dirb')
    expect(resolveByPid(SHELL)).toBe('cmd-dirb')
  })

  it('carries through the port lookup, which is the path mitmproxy takes', () => {
    noteCommandPid(SHELL, 'cmd-dirb')
    noteProcessParent(TOOL, SHELL)
    notePortPid(54321, TOOL)
    expect(resolveByLocalPort(54321)).toBe('cmd-dirb')
    expect(socketCausesFor('scanner', { source_addr: '127.0.0.1:54321' })).toEqual(['cmd-dirb'])
  })

  it('prefers the nearest command — a wrapper that was itself announced wins', () => {
    // `redlog-run dirb …` run from a hooked shell: both have a command_start,
    // and the traffic belongs to the inner one.
    noteCommandPid(SHELL, 'cmd-outer')
    noteCommandPid(700, 'cmd-inner')
    noteProcessParent(700, SHELL)
    noteProcessParent(TOOL, 700)
    expect(resolveByPid(TOOL)).toBe('cmd-inner')
  })
})

describe('what it refuses to claim', () => {
  it('returns nothing when no ancestor ran a command', () => {
    // A browser, a daemon, anything RedLog did not launch. Citing the nearest
    // command would be a false statement about who did what, in a record
    // handed to a client.
    noteProcessParent(TOOL, SHELL)
    expect(resolveByPid(TOOL)).toBeNull()
    expect(socketCausesFor('scanner', { pid: TOOL })).toEqual([])
  })

  it('returns nothing when the ancestry is unknown', () => {
    // No process watcher running: the old behaviour, and still honest.
    noteCommandPid(SHELL, 'cmd-dirb')
    expect(resolveByPid(TOOL)).toBeNull()
  })

  it('stops walking rather than reaching an unrelated ancient process', () => {
    noteCommandPid(1, 'cmd-init')
    let child = 1
    for (let i = 0; i < MAX_ANCESTRY_DEPTH + 3; i++) {
      noteProcessParent(child + 1, child)
      child += 1
    }
    expect(resolveByPid(child)).toBeNull()
  })

  it('survives a cycle in a process table read mid-reparent', () => {
    // An attribution walk must never be the thing that hangs capture.
    noteProcessParent(10, 11)
    noteProcessParent(11, 10)
    expect(resolveByPid(10)).toBeNull()
  })

  it('ignores a process claiming to be its own parent', () => {
    noteCommandPid(SHELL, 'cmd-dirb')
    noteProcessParent(TOOL, TOOL)
    expect(resolveByPid(TOOL)).toBeNull()
  })

  it('ignores pid 0 and negatives from a malformed ps line', () => {
    noteCommandPid(SHELL, 'cmd-dirb')
    noteProcessParent(TOOL, 0)
    noteProcessParent(0, SHELL)
    expect(resolveByPid(TOOL)).toBeNull()
    expect(resolveByPid(0)).toBeNull()
    expect(resolveByPid(-1)).toBeNull()
  })

  it('attributes nothing for a non-traffic event type', () => {
    noteCommandPid(SHELL, 'cmd-dirb')
    expect(socketCausesFor('shell', { pid: SHELL })).toEqual([])
  })
})
