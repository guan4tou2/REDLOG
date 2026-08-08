import { describe, it, expect, afterEach } from 'vitest'
import {
  extractTarget, registerTargetExtractors, unregisterTargetExtractors,
  extractTargetWithProvenance, listExternalTargetExtractors
} from '../src/core/target-extractor'

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

  describe('empty / degenerate / huge input', () => {
    it('empty and whitespace-only commands return null', () => {
      expect(extractTarget('')).toBeNull()
      expect(extractTarget('   ')).toBeNull()
      expect(extractTarget('\t\n')).toBeNull()
    })

    it('finishes quickly on a large command string', () => {
      const noise = 'a'.repeat(50_000)
      const start = Date.now()
      // Unknown command with no URL — must not run DOMAIN_RE across the 50K blob.
      expect(extractTarget(`echo ${noise}`)).toBeNull()
      expect(Date.now() - start).toBeLessThan(200)
    })

    it('accepts commands whose target has an unusual port suffix', () => {
      expect(extractTarget('ssh admin@target.example.com')).toBe('target.example.com')
      // scp with :path — capture stops before the colon.
      expect(extractTarget('scp file.txt operator@10.1.2.3:/tmp/x')).toBe('10.1.2.3')
    })
  })

  describe('plugin-contributed extractors', () => {
    afterEach(() => {
      unregisterTargetExtractors('unit-x')
      unregisterTargetExtractors('unit-bad')
    })

    it('registered plugin patterns win over the built-in list', () => {
      // Built-in `nmap` extraction would pick the IP; the plugin extractor gets
      // to shadow it because externalPatterns are tried first.
      const n = registerTargetExtractors('unit-x', [
        { cmd: '^nmap\\s', extract: 'plugin-target-([a-z0-9]+)' }
      ])
      expect(n).toBe(1)
      expect(extractTarget('nmap plugin-target-alpha01 10.0.0.9')).toBe('alpha01')
    })

    it('bad regex is silently skipped, the count reflects only what compiled', () => {
      const n = registerTargetExtractors('unit-bad', [
        { cmd: '[unterminated', extract: '.*' },
        { cmd: '^unit-good\\s', extract: '(\\S+)$' }
      ])
      expect(n).toBe(1)
      expect(extractTarget('unit-good end-token')).toBe('end-token')
    })

    it('unregistering an unknown plugin id is a no-op (idempotent)', () => {
      expect(() => unregisterTargetExtractors('never-registered')).not.toThrow()
    })

    it('re-registering with the same id appends without corrupting later lookups', () => {
      registerTargetExtractors('unit-x', [{ cmd: '^rescan\\s', extract: '--to\\s+(\\S+)' }])
      registerTargetExtractors('unit-x', [{ cmd: '^rescan\\s', extract: '--to\\s+(\\S+)' }])
      // Two identical entries; both fire but return the same thing.
      expect(extractTarget('rescan --to host.local')).toBe('host.local')
      unregisterTargetExtractors('unit-x')
      // After unregister, plugin no longer contributes — fallback fires.
      expect(extractTarget('rescan --to host.local')).toBeNull()
    })
  })

  describe('v0.9.1 attribution: extractTargetWithProvenance', () => {
    afterEach(() => {
      unregisterTargetExtractors('audit-ext')
      unregisterTargetExtractors('twin-x')
      unregisterTargetExtractors('twin-y')
    })

    it('plugin match carries pluginId + extractorName (default `cmd#N`)', () => {
      registerTargetExtractors('audit-ext', [
        { cmd: '^myscan\\s', extract: '--host\\s+(\\S+)' },
        { cmd: '^myscan2\\s', extract: '--host\\s+(\\S+)', name: 'myscan2-target', description: 'v2 rule' }
      ])
      const first = extractTargetWithProvenance('myscan --host 10.0.0.9')
      expect(first.host).toBe('10.0.0.9')
      expect(first.pluginId).toBe('audit-ext')
      expect(first.extractorName).toBe('^myscan\\s#0')

      const second = extractTargetWithProvenance('myscan2 --host 10.0.0.10')
      expect(second.host).toBe('10.0.0.10')
      expect(second.extractorName).toBe('myscan2-target')
    })

    it('built-in match returns NO pluginId/extractorName (chain-shape stable)', () => {
      const r = extractTargetWithProvenance('ssh user@10.0.0.1')
      expect(r.host).toBe('10.0.0.1')
      expect(r.pluginId).toBeUndefined()
      expect(r.extractorName).toBeUndefined()
    })

    it('two plugins with the same cmd matcher are distinguishable', () => {
      registerTargetExtractors('twin-x', [
        { cmd: '^dualscan\\s', extract: 'xhost=(\\S+)', name: 'x-rule' }
      ])
      registerTargetExtractors('twin-y', [
        { cmd: '^dualscan\\s', extract: 'yhost=(\\S+)', name: 'y-rule' }
      ])
      // Plugin registration order = match order. twin-x registered first, so
      // when both patterns could match, x wins. But a command that only has
      // yhost= should still attribute to twin-y since its extract regex fires.
      const rx = extractTargetWithProvenance('dualscan xhost=a.example.com')
      expect(rx.pluginId).toBe('twin-x')
      expect(rx.extractorName).toBe('x-rule')
      // For y-only pattern, twin-x's cmd matches but its extract regex won't
      // — so it falls through to twin-y.
      const ry = extractTargetWithProvenance('dualscan yhost=b.example.com')
      expect(ry.pluginId).toBe('twin-y')
      expect(ry.extractorName).toBe('y-rule')
    })

    it('listExternalTargetExtractors snapshot exposes name + description', () => {
      registerTargetExtractors('audit-ext', [
        { cmd: '^foo\\s', extract: '--t\\s+(\\S+)', name: 'foo-rule', description: 'internal fooer' }
      ])
      const list = listExternalTargetExtractors().filter((p) => p.pluginId === 'audit-ext')
      expect(list.length).toBe(1)
      expect(list[0].extractorName).toBe('foo-rule')
      expect(list[0].description).toBe('internal fooer')
      expect(list[0].cmd).toBe('^foo\\s')
      expect(list[0].extract).toBe('--t\\s+(\\S+)')
    })

    it('extractTarget backward-compat shim still returns just the host string', () => {
      registerTargetExtractors('audit-ext', [
        { cmd: '^probe\\s', extract: '(\\S+)$' }
      ])
      expect(extractTarget('probe target.example')).toBe('target.example')
      expect(extractTarget('ssh user@10.0.0.1')).toBe('10.0.0.1')
      expect(extractTarget('nothing here')).toBeNull()
    })
  })
})
