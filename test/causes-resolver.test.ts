import { describe, it, expect, beforeEach } from 'vitest'
import { noteStartEvent, resolveIncomingCauses, _resetCausesResolver } from '../src/core/causes-resolver'

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
