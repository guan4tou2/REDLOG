import { describe, it, expect } from 'vitest'
import { createRequire } from 'module'

// scan-parsers bundled pack (SPEC-AI-ERA-PLUGINS Gap 1). The parser ships as a
// dependency-free CommonJS module inside the plugin (runs in the operator's
// shell), so we require it directly and pin its output shape here.
const require_ = createRequire(import.meta.url)
const { parseNmapGreppable, parseNucleiJsonl, parse } = require_('../plugins/scan-parsers/parse.js')

describe('parseNmapGreppable', () => {
  const sample = [
    '# Nmap 7.94 scan',
    'Host: 10.0.0.5 (web.example.com)\tPorts: 22/open/tcp//ssh//OpenSSH 8.9//, 80/open/tcp//http//nginx 1.24//, 443/closed/tcp//https///\tStatus: Up',
    'Host: 10.0.0.6 ()\tPorts: 3306/open/tcp//mysql//MariaDB//\tStatus: Up',
    'garbage line'
  ].join('\n')

  it('extracts hosts and their OPEN ports only', () => {
    const hosts = parseNmapGreppable(sample)
    expect(hosts).toHaveLength(2)
    expect(hosts[0].host).toBe('10.0.0.5')
    expect(hosts[0].hostname).toBe('web.example.com')
    // 443 is closed → dropped; 22 + 80 kept
    expect(hosts[0].ports.map((p: { port: number }) => p.port)).toEqual([22, 80])
    expect(hosts[0].ports[0]).toMatchObject({ port: 22, proto: 'tcp', service: 'ssh', version: 'OpenSSH 8.9' })
  })

  it('tolerates blank hostname and malformed lines', () => {
    const hosts = parseNmapGreppable(sample)
    expect(hosts[1].hostname).toBe('')
    expect(hosts[1].ports[0].service).toBe('mysql')
  })

  it('returns [] for empty / non-string input', () => {
    expect(parseNmapGreppable('')).toEqual([])
    expect(parseNmapGreppable(undefined as unknown as string)).toEqual([])
  })
})

describe('parseNucleiJsonl', () => {
  const sample = [
    '{"template-id":"CVE-2021-1234","info":{"name":"Example RCE","severity":"critical"},"host":"https://x.example.com","matched-at":"https://x.example.com/api","type":"http"}',
    'not json',
    '',
    '{"template-id":"tech-detect","info":{"name":"nginx","severity":"info"},"host":"https://x.example.com","type":"http"}'
  ].join('\n')

  it('parses one finding per valid JSON line, skipping junk', () => {
    const f = parseNucleiJsonl(sample)
    expect(f).toHaveLength(2)
    expect(f[0]).toMatchObject({ templateId: 'CVE-2021-1234', name: 'Example RCE', severity: 'critical', host: 'https://x.example.com' })
    expect(f[1].severity).toBe('info')
  })

  it('defaults severity to unknown when absent', () => {
    const f = parseNucleiJsonl('{"template-id":"t","host":"h"}')
    expect(f[0].severity).toBe('unknown')
  })
})

describe('parse → RedLog event payloads', () => {
  it('nmap → one scanner scan_result per host, target_id = host', () => {
    const events = parse('nmap', 'Host: 1.2.3.4 (h)\tPorts: 80/open/tcp//http///\tStatus: Up')
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ agent_type: 'scanner', target_id: '1.2.3.4' })
    expect(events[0].data).toMatchObject({ subtype: 'scan_result', tool: 'nmap', open_port_count: 1, detectedTarget: '1.2.3.4' })
  })

  it('nuclei → one scanner scan_result per finding, severity recorded verbatim', () => {
    const events = parse('nuclei', '{"template-id":"t","info":{"name":"n","severity":"high"},"host":"h"}')
    expect(events[0]).toMatchObject({ agent_type: 'scanner', target_id: 'h' })
    expect(events[0].data).toMatchObject({ subtype: 'scan_result', tool: 'nuclei', template_id: 't', severity: 'high' })
  })

  it('unknown tool → []', () => {
    expect(parse('whatever', 'x')).toEqual([])
  })
})
