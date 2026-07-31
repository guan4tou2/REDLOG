import { describe, it, expect } from 'vitest'
import { extractTarget } from '../src/core/target-extractor'

describe('extractTarget', () => {
  it('extracts host from ssh command', () => {
    expect(extractTarget('ssh user@10.0.0.1')).toBe('10.0.0.1')
    expect(extractTarget('ssh admin@target.example.com')).toBe('target.example.com')
  })

  it('extracts host from nmap command', () => {
    expect(extractTarget('nmap -sV 192.168.1.1')).toBe('192.168.1.1')
    expect(extractTarget('nmap -A target.com')).toBe('target.com')
  })

  it('extracts host from curl with URL', () => {
    expect(extractTarget('curl https://api.example.com/path')).toBe('api.example.com')
    expect(extractTarget('curl http://10.0.0.1:8080/api')).toBe('10.0.0.1')
  })

  it('extracts host from sqlmap', () => {
    expect(extractTarget('sqlmap -u "http://vuln.site/page?id=1"')).toBe('vuln.site')
  })

  it('extracts host from ffuf', () => {
    expect(extractTarget('ffuf -u https://target.com/FUZZ -w wordlist.txt')).toBe('target.com')
  })

  it('extracts host from gobuster', () => {
    expect(extractTarget('gobuster dir -u http://10.0.0.5 -w list.txt')).toBe('10.0.0.5')
  })

  it('extracts host from nikto', () => {
    expect(extractTarget('nikto -h target.example.com')).toBe('target.example.com')
  })

  it('extracts host from hydra', () => {
    expect(extractTarget('hydra -l admin -P pass.txt 10.0.0.1 ssh')).toBe('10.0.0.1')
  })

  it('extracts host from ping', () => {
    expect(extractTarget('ping 8.8.8.8')).toBe('8.8.8.8')
    expect(extractTarget('ping google.com')).toBe('google.com')
  })

  it('extracts host from scp', () => {
    expect(extractTarget('scp file.txt user@10.0.0.1:/tmp/')).toBe('10.0.0.1')
  })

  it('extracts host from nuclei', () => {
    expect(extractTarget('nuclei -u https://target.com -t cves/')).toBe('target.com')
  })

  it('extracts host from impacket', () => {
    expect(extractTarget('impacket-psexec admin@10.0.0.1')).toBe('10.0.0.1')
  })

  it('extracts RHOSTS from metasploit set command', () => {
    expect(extractTarget('set RHOSTS 10.0.0.0/24')).toBe('10.0.0.0/24')
  })

  it('returns null for commands without targets', () => {
    expect(extractTarget('ls -la')).toBeNull()
    expect(extractTarget('cat /etc/passwd')).toBeNull()
    expect(extractTarget('whoami')).toBeNull()
  })

  it('extracts from unknown command with URL', () => {
    expect(extractTarget('xh https://api.target.com/v1')).toBe('api.target.com')
  })

  // v0.6.64 regression tests — fallback must NOT run DOMAIN_RE across arbitrary
  // shell strings, otherwise dotted identifiers like `json.dumps` land in the
  // targets panel as if they were hosts.
  describe('unknown-command fallback (://-scheme required)', () => {
    it('does not treat python module-paths as targets', () => {
      expect(extractTarget('python -c "import json.dumps"')).toBeNull()
      expect(extractTarget('python3 -m http.server')).toBeNull()
    })

    it('does not treat sourced hook paths as targets', () => {
      expect(extractTarget('source ~/.redlog/shell-preexec-hook.sh')).toBeNull()
      expect(extractTarget('. /opt/hooks/wrapper.sh')).toBeNull()
    })

    it('does not treat filenames-with-extensions as targets', () => {
      expect(extractTarget('cat notes.txt')).toBeNull()
      expect(extractTarget('open report.pdf')).toBeNull()
    })

    it('still extracts host when an unknown command carries an http(s) URL', () => {
      expect(extractTarget('xh https://api.target.com/v1')).toBe('api.target.com')
      expect(extractTarget('unknown-tool http://192.168.1.1:8080/foo')).toBe('192.168.1.1')
    })
  })
})
