import { describe, it, expect, beforeEach } from 'vitest'
import { noteStartEvent, relatedCommandCandidates, resolveIncomingCauses, _resetCausesResolver } from '../src/core/causes-resolver'

describe('causes-resolver', () => {
  beforeEach(() => {
    _resetCausesResolver()
  })

  describe('HTTP flow linking', () => {
    it('links http_response to http_request_start via flow_id', () => {
      noteStartEvent('scanner', { subtype: 'http_request_start', flow_id: 'f1' }, 'evt-req-1')
      const causes = resolveIncomingCauses('scanner', { subtype: 'http_response', flow_id: 'f1' })
      expect(causes).toEqual(['evt-req-1'])
    })

    it('returns empty array for unknown flow_id', () => {
      const causes = resolveIncomingCauses('scanner', { subtype: 'http_response', flow_id: 'unknown' })
      expect(causes).toEqual([])
    })

    it('clears flow_id on http_response but not on http_error', () => {
      noteStartEvent('scanner', { subtype: 'http_request_start', flow_id: 'f2' }, 'evt-req-2')
      const errorCauses = resolveIncomingCauses('scanner', { subtype: 'http_error', flow_id: 'f2' })
      expect(errorCauses).toEqual(['evt-req-2'])
      const responseCauses = resolveIncomingCauses('scanner', { subtype: 'http_response', flow_id: 'f2' })
      expect(responseCauses).toEqual(['evt-req-2'])
      const secondResponse = resolveIncomingCauses('scanner', { subtype: 'http_response', flow_id: 'f2' })
      expect(secondResponse).toEqual([])
    })

    it('links http_request_dropped to the start event', () => {
      noteStartEvent('scanner', { subtype: 'http_request_start', flow_id: 'f3' }, 'evt-req-3')
      const causes = resolveIncomingCauses('scanner', { subtype: 'http_request_dropped', flow_id: 'f3' })
      expect(causes).toEqual(['evt-req-3'])
    })
  })

  describe('shell command linking', () => {
    it('links command_end to command_start via terminal_id+pid+command', () => {
      const data = { subtype: 'command_start', terminal_id: 't1', pid: 1234, command: 'nmap -sV 10.0.0.1' }
      noteStartEvent('shell', data, 'evt-cmd-1')
      const endData = { subtype: 'command_end', terminal_id: 't1', pid: 1234, command: 'nmap -sV 10.0.0.1' }
      const causes = resolveIncomingCauses('shell', endData)
      expect(causes).toEqual(['evt-cmd-1'])
    })

    it('returns empty for unmatched command_end', () => {
      const causes = resolveIncomingCauses('shell', { subtype: 'command_end', command: 'ls' })
      expect(causes).toEqual([])
    })

    it('clears the entry after resolution', () => {
      const data = { subtype: 'command_start', command: 'whoami' }
      noteStartEvent('shell', data, 'evt-cmd-2')
      resolveIncomingCauses('shell', { subtype: 'command_end', command: 'whoami' })
      const second = resolveIncomingCauses('shell', { subtype: 'command_end', command: 'whoami' })
      expect(second).toEqual([])
    })

    it('returns empty for non-end subtypes', () => {
      const causes = resolveIncomingCauses('shell', { subtype: 'session_start' })
      expect(causes).toEqual([])
    })
  })

  describe('watched file correlation', () => {
    it('reports cwd overlap as an uncertain candidate, never a cause', () => {
      noteStartEvent('shell', {
        subtype: 'command_start', terminalId: 't1', pid: 41,
        command: 'nmap -oA loot/scan 10.0.0.8', cwd: '/work'
      }, 'evt-command')

      const file = {
        subtype: 'file_created', source: 'file-watcher', path: '/work/loot/scan.xml'
      }
      expect(resolveIncomingCauses('file_transfer', file)).toEqual([])
      expect(relatedCommandCandidates(file)).toEqual([{
        event_id: 'evt-command', method: 'cwd-overlap', state: 'active'
      }])
    })

    it('does not link paths outside the command cwd or deletion events', () => {
      noteStartEvent('shell', {
        subtype: 'command_start', terminalId: 't1', pid: 42, command: 'tool', cwd: '/work'
      }, 'evt-command')
      expect(relatedCommandCandidates({
        subtype: 'file_created', source: 'file-watcher', path: '/other/result.txt'
      })).toEqual([])
      expect(relatedCommandCandidates({
        subtype: 'file_deleted', source: 'file-watcher', path: '/work/result.txt'
      })).toEqual([])
    })

    it('keeps every matching command visible instead of guessing one cause', () => {
      noteStartEvent('shell', {
        subtype: 'command_start', terminalId: 'outer', pid: 1, command: 'outer', cwd: '/work'
      }, 'evt-outer')
      noteStartEvent('shell', {
        subtype: 'command_start', terminalId: 'inner', pid: 2, command: 'inner', cwd: '/work/loot'
      }, 'evt-inner')
      expect(relatedCommandCandidates({
        subtype: 'file_modified', source: 'file-watcher', path: '/work/loot/result.txt'
      }).map((candidate) => candidate.event_id)).toEqual(['evt-inner', 'evt-outer'])

      noteStartEvent('shell', {
        subtype: 'command_start', terminalId: 'inner-2', pid: 3, command: 'also-inner', cwd: '/work/loot'
      }, 'evt-inner-2')
      expect(relatedCommandCandidates({
        subtype: 'file_modified', source: 'file-watcher', path: '/work/loot/ambiguous.txt'
      }).map((candidate) => candidate.event_id)).toEqual(['evt-inner', 'evt-inner-2', 'evt-outer'])
    })

    it('retains a bounded post-command candidate for delayed watcher delivery', () => {
      const command = { terminalId: 't1', pid: 43, command: 'gobuster -o loot/out.txt', cwd: '/work' }
      noteStartEvent('shell', { subtype: 'command_start', ...command }, 'evt-command')
      expect(resolveIncomingCauses('shell', { subtype: 'command_end', ...command })).toEqual(['evt-command'])
      expect(relatedCommandCandidates({
        subtype: 'file_created', source: 'file-watcher', path: '/work/loot/out.txt'
      })).toEqual([{
        event_id: 'evt-command', method: 'cwd-near-command-end', state: 'recent'
      }])
      expect(relatedCommandCandidates({
        subtype: 'file_created', source: 'file-watcher', path: '/work/loot/out.txt'
      }, Date.now() + 2_001)).toEqual([])
    })
  })

  describe('unrelated agent types', () => {
    it('returns empty for dns events', () => {
      expect(resolveIncomingCauses('dns', { subtype: 'dns_query' })).toEqual([])
    })

    it('returns empty for marker events', () => {
      expect(resolveIncomingCauses('marker', { title: 'finding' })).toEqual([])
    })
  })

  describe('BoundedMap eviction', () => {
    it('evicts oldest entries when capacity is exceeded', () => {
      for (let i = 0; i < 10_001; i++) {
        noteStartEvent('scanner', { subtype: 'http_request_start', flow_id: `f${i}` }, `evt-${i}`)
      }
      const oldest = resolveIncomingCauses('scanner', { subtype: 'http_response', flow_id: 'f0' })
      expect(oldest).toEqual([])
      const newest = resolveIncomingCauses('scanner', { subtype: 'http_response', flow_id: 'f10000' })
      expect(newest).toEqual(['evt-10000'])
    })
  })
})
