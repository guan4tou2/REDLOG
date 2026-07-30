// First-class detectors for actions that produce their own STRUCTURED companion
// event (not just field tagging):
//   • detectCleanup — anti-forensics; NIST SP 800-86 requires distinct tracking
//   • detectFileTransfer — ingress/exfil, so file_transfer lane isn't dependent
//     on an agent explicitly emitting one
//
// MITRE technique tagging that used to live here moved to the plugin registry
// (see src/core/command-tagger.ts + `commandTags` in docs/plugin-development.md).
// Tagging is opinionated and stale-prone; a backend SIEM (ELK/Splunk) can
// often do it better with more context. RedLog ships no commandTags out of the
// box — install a plugin, or leave the raw shell events for the backend to tag.
//
// Both detectors are pure functions over a command string — no side effects.

export interface CleanupInfo {
  tool: string
  subtype: 'log_clear' | 'history_clear' | 'file_shred' | 'timestomp' | 'attr_hide'
  mitreTtp: string
  /** the target path or artefact, if named in the command */
  target?: string
}

// Recognize the command's first token (basename, so `./nmap` still matches).
function head(cmd: string): string {
  return cmd.trim().split(/\s+/)[0]?.split(/[\\/]/).pop() ?? ''
}

/** Stamp a MITRE technique on the shell event when the tool is recognized. */
/** Anti-forensics / cleanup — always emit a dedicated cleanup event, not just a tag. */
export function detectCleanup(command: string): CleanupInfo | null {
  const cmd = command.trim()
  const first = head(cmd)

  // Shell history clearing — history -c, unset HISTFILE, redirect > .*_history
  if (/^history\s+-c\b/.test(cmd) || /unset\s+HISTFILE\b/.test(cmd) || /HISTFILE=\/dev\/null/.test(cmd)) {
    return { tool: 'shell', subtype: 'history_clear', mitreTtp: 'T1070.003' }
  }
  if (/>\s*~?\/\.(bash|zsh|sh|fish|ksh)_history/.test(cmd)) {
    return { tool: 'shell', subtype: 'history_clear', mitreTtp: 'T1070.003' }
  }

  // Log clearing — direct log truncation, journalctl --rotate --vacuum-time,
  // wevtutil cl on windows, or a broad rm on /var/log
  if (/wevtutil\s+cl\b/i.test(cmd)) {
    const log = cmd.match(/wevtutil\s+cl\s+"?([^"\s]+)/i)?.[1]
    return { tool: 'wevtutil', subtype: 'log_clear', mitreTtp: 'T1070.001', target: log }
  }
  if (/journalctl\s+--(rotate|vacuum-)/i.test(cmd)) {
    return { tool: 'journalctl', subtype: 'log_clear', mitreTtp: 'T1070.002' }
  }
  if (/\brm\s+.*\/var\/log\b/.test(cmd) || />\s*\/var\/log\/[^\s]+/.test(cmd)) {
    return { tool: 'rm', subtype: 'log_clear', mitreTtp: 'T1070.002', target: cmd.match(/\/var\/log\/[^\s]+/)?.[0] }
  }

  // Secure delete — shred, srm, sdelete, wipe
  if (first === 'shred' || first === 'srm' || first === 'sdelete' || first === 'wipe') {
    const target = cmd.split(/\s+/).slice(1).find((a) => !a.startsWith('-'))
    return { tool: first, subtype: 'file_shred', mitreTtp: 'T1070.004', target }
  }

  // Timestomp — touch -t, touch -d @, SetMace, timestomp
  if (first === 'touch' && /-[trdaMm]\s/.test(cmd)) {
    const target = cmd.split(/\s+/).slice(-1)[0]
    return { tool: 'touch', subtype: 'timestomp', mitreTtp: 'T1070.006', target }
  }
  if (/setmace|timestomp/i.test(first)) {
    return { tool: first, subtype: 'timestomp', mitreTtp: 'T1070.006' }
  }

  // File-attribute hiding — chattr +i on Linux, attrib +h on Windows
  if (first === 'chattr' && /\+[iaAs]/.test(cmd)) {
    return { tool: 'chattr', subtype: 'attr_hide', mitreTtp: 'T1564.001', target: cmd.split(/\s+/).slice(-1)[0] }
  }
  if (/^attrib\s+.*\+h/i.test(cmd)) {
    return { tool: 'attrib', subtype: 'attr_hide', mitreTtp: 'T1564.001', target: cmd.split(/\s+/).slice(-1)[0] }
  }

  return null
}

export interface FileTransferInfo {
  tool: string
  /** upload = we're sending TO the target; download = pulling FROM the target/target-adjacent */
  direction: 'download' | 'upload'
  url?: string
  localPath?: string
  remotePath?: string
  mitreTtp: string
}

/** Detect ingress-tool-transfer / exfil commands and structure them so a
 *  companion file_transfer event can be emitted. */
export function detectFileTransfer(command: string): FileTransferInfo | null {
  const cmd = command.trim()
  const first = head(cmd)

  // curl / wget with -o / -O — downloading
  if ((first === 'curl' || first === 'wget' || first === 'aria2c') && /-o\b|-O\b|--output|--remote-name/.test(cmd)) {
    const url = cmd.match(/https?:\/\/[^\s'"]+/)?.[0]
    const out = cmd.match(/-o\s+([^\s]+)|--output\s+([^\s]+)/)?.[1] ?? cmd.match(/-o\s+([^\s]+)|--output\s+([^\s]+)/)?.[2]
    return { tool: first, direction: 'download', url, localPath: out, mitreTtp: 'T1105' }
  }
  // curl / wget doing an upload with -T / --upload-file / -F / -d @
  if ((first === 'curl' || first === 'wget') && /\s(-T|--upload-file|-F|-d\s+@)/.test(cmd)) {
    const url = cmd.match(/https?:\/\/[^\s'"]+/)?.[0]
    const local = cmd.match(/(?:-T|--upload-file|-F\s+[^=]+=@|-d\s+@)\s*([^\s'"]+)/)?.[1]
    return { tool: first, direction: 'upload', url, localPath: local, mitreTtp: 'T1041' }
  }
  // scp — direction depends on argument order (last arg is destination)
  if (first === 'scp') {
    const args = cmd.split(/\s+/).slice(1).filter((a) => !a.startsWith('-'))
    if (args.length >= 2) {
      const src = args[0], dst = args[args.length - 1]
      const dstIsRemote = /:/.test(dst) && !dst.startsWith(':')
      const srcIsRemote = /:/.test(src) && !src.startsWith(':')
      if (dstIsRemote && !srcIsRemote) return { tool: 'scp', direction: 'upload', localPath: src, remotePath: dst, mitreTtp: 'T1105' }
      if (srcIsRemote && !dstIsRemote) return { tool: 'scp', direction: 'download', remotePath: src, localPath: dst, mitreTtp: 'T1105' }
    }
  }
  // rsync — same argument-order rule
  if (first === 'rsync') {
    const args = cmd.split(/\s+/).slice(1).filter((a) => !a.startsWith('-'))
    if (args.length >= 2) {
      const src = args[0], dst = args[args.length - 1]
      const dstIsRemote = /:/.test(dst) && !dst.startsWith(':')
      const srcIsRemote = /:/.test(src) && !src.startsWith(':')
      if (dstIsRemote && !srcIsRemote) return { tool: 'rsync', direction: 'upload', localPath: src, remotePath: dst, mitreTtp: 'T1105' }
      if (srcIsRemote && !dstIsRemote) return { tool: 'rsync', direction: 'download', remotePath: src, localPath: dst, mitreTtp: 'T1105' }
    }
  }
  // python -m http.server — staging server (ingress-tool-transfer setup)
  if (/python[23]?\s+-m\s+http\.server/.test(cmd)) {
    return { tool: 'python-http.server', direction: 'upload', mitreTtp: 'T1105' }
  }
  return null
}
