import { describe, it, expect } from 'vitest'
import { classifyCommand } from '../src/core/terminal-class'

// Spec 052 T014, research.md D3. The classifier decides what happens to a
// command before it runs, and the deciding constraint is not implementation
// cost — a PTY-captured command cannot be suspended locally, so the list IS
// the product decision. A default that records `nc` destroys the shell upgrade
// the operator is in the middle of (FR-025); a default that records `vim`
// fills the evidence with redraws and records no content at all (FR-026).
//
// It is a pure function over argv on purpose: nothing it reads comes from the
// command's output, and nothing it decides depends on the machine it runs on.

describe('command classification', () => {
  const classify = (line: string) => classifyCommand(line.split(' '))

  it('relays an ordinary command', () => {
    expect(classify('nmap -sV 10.0.0.1')).toBe('relayed')
    expect(classify('ls -la')).toBe('relayed')
    expect(classify('ffuf -u http://10.0.0.1/FUZZ -w words.txt')).toBe('relayed')
  })

  it('leaves `nc` alone, because the operator is going to suspend it', () => {
    // The upgrade is Ctrl-Z, `stty raw -echo`, `fg`. A relay in the middle of
    // that is a lost shell on a box someone spent two days reaching.
    expect(classify('nc -lvnp 4444')).toBe('native')
    expect(classify('ncat -lvnp 4444')).toBe('native')
  })

  it('leaves editors and pagers alone, because a redraw is not evidence', () => {
    for (const line of ['vim notes.txt', 'vi /etc/hosts', 'nvim x', 'nano x', 'less big.log', 'more big.log']) {
      expect(classify(line), line).toBe('native')
    }
  })

  it('gives a PTY to the things that bring their own', () => {
    expect(classify('ssh root@10.0.0.1')).toBe('pty')
    expect(classify('socat - TCP:10.0.0.1:4444')).toBe('pty')
    expect(classify('pwncat-cs 10.0.0.1 4444')).toBe('pty')
  })

  it('reads through sudo, env, proxychains and an absolute path (FR-027)', () => {
    // The wrapper is not the command. Classifying on the first word puts
    // `sudo nc` in the relayed class and breaks the upgrade just as surely.
    expect(classify('sudo nc -lvnp 4444')).toBe('native')
    expect(classify('sudo -u root nc -lvnp 4444')).toBe('native')
    expect(classify('env FOO=bar nc -lvnp 4444')).toBe('native')
    expect(classify('proxychains4 -q ssh root@10.0.0.1')).toBe('pty')
    expect(classify('/usr/bin/nc -lvnp 4444')).toBe('native')
    expect(classify('sudo /usr/bin/vim /etc/shadow')).toBe('native')
    // …and a wrapper around something ordinary is still ordinary.
    expect(classify('sudo nmap -sS 10.0.0.1')).toBe('relayed')
  })

  it('tells a REPL from a REPL given something to run', () => {
    // Bare, it is an interactive session and recording it records the
    // prompt's redrawing. Given a script or an expression, it is a command
    // with output like any other (FR-027).
    expect(classify('python3')).toBe('native')
    expect(classify('python3 -i')).toBe('native')
    expect(classify('node')).toBe('native')
    expect(classify('irb')).toBe('native')

    expect(classify('python3 exploit.py')).toBe('relayed')
    expect(classify('python3 -c print(1)')).toBe('relayed')
    expect(classify('python3 -m http.server')).toBe('relayed')
    expect(classify('node -e 1+1')).toBe('relayed')
    expect(classify('perl -e print')).toBe('relayed')
  })

  it('does not guess from nothing', () => {
    // An empty argv is not a command. Returning `relayed` here would route
    // the shell's own empty prompt through the relay on every bare Enter.
    expect(classifyCommand([])).toBe('native')
    expect(classifyCommand(['sudo'])).toBe('native')
  })
})
