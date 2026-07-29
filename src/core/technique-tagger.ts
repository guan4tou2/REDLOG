// MITRE ATT&CK auto-tagging for common red-team commands.
//
// The pivot detector already emits a first-class `pivot` event with a MITRE
// technique. This module extends the same pattern to two more axes:
//
//   1. Stampable tagging (tagTechnique) — recognizes recon, cred-access,
//      execution, and defense-evasion patterns and returns {mitreTtp, tool} so
//      the shell event itself carries an ATT&CK technique. Callers stamp the
//      returned fields into event.data (Ghostwriter/VECTR ingestion can then
//      map RedLog rows straight to ATT&CK procedures — a gap flagged in the
//      2026 audit against Ghostwriter/VECTR/Bishop Fox conventions).
//
//   2. First-class cleanup events (detectCleanup) — anti-forensics actions are
//      too important to bury inside a shell event; NIST SP 800-86 and "30 Days
//      of Red Team" require them tracked distinctly so the operator has proof
//      they did (or didn't) tamper with target logs.
//
// Both detectors are pure functions over a command string — no side effects.

export interface Technique {
  tool: string
  /** MITRE ATT&CK technique ID (T####[.###]) */
  mitreTtp: string
  /** short human-readable category label */
  category: 'recon' | 'cred_access' | 'execution' | 'defense_evasion' | 'discovery' | 'exfil'
}

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
export function tagTechnique(command: string): Technique | null {
  const cmd = command.trim()
  const first = head(cmd)

  // --- Recon / Discovery ---
  if (first === 'nmap' || first === 'masscan' || first === 'rustscan') return { tool: first, mitreTtp: 'T1046', category: 'recon' }
  if (first === 'gobuster' || first === 'dirb' || first === 'dirbuster' || first === 'feroxbuster' || first === 'ffuf' || first === 'wfuzz') return { tool: first, mitreTtp: 'T1595.003', category: 'recon' }
  if (first === 'nikto' || first === 'wpscan' || first === 'nuclei') return { tool: first, mitreTtp: 'T1595.002', category: 'recon' }
  if (first === 'enum4linux' || first === 'smbclient' || first === 'smbmap' || first === 'rpcclient') return { tool: first, mitreTtp: 'T1135', category: 'discovery' }
  if (first === 'dig' || first === 'nslookup' || first === 'host' || first === 'dnsrecon' || first === 'dnsenum' || first === 'amass' || first === 'subfinder') return { tool: first, mitreTtp: 'T1590.002', category: 'recon' }
  if (first === 'theharvester' || first === 'recon-ng') return { tool: first, mitreTtp: 'T1589', category: 'recon' }

  // --- Credential Access ---
  if (first === 'hydra' || first === 'medusa' || first === 'ncrack' || first === 'patator') return { tool: first, mitreTtp: 'T1110.001', category: 'cred_access' }
  if (first === 'hashcat' || first === 'john') return { tool: first, mitreTtp: 'T1110.002', category: 'cred_access' }
  if (/mimikatz/i.test(first) || /mimikatz/i.test(cmd)) return { tool: 'mimikatz', mitreTtp: 'T1003.001', category: 'cred_access' }
  if (first === 'secretsdump.py' || /secretsdump\.py/.test(cmd)) return { tool: 'secretsdump', mitreTtp: 'T1003.003', category: 'cred_access' }
  if (first === 'crackmapexec' || first === 'cme' || first === 'netexec' || first === 'nxc') return { tool: first, mitreTtp: 'T1110', category: 'cred_access' }
  if (first === 'kerbrute' || /GetUserSPNs\.py/.test(cmd) || /GetNPUsers\.py/.test(cmd)) return { tool: first || 'impacket', mitreTtp: 'T1558', category: 'cred_access' }
  if (first === 'responder' || first === 'ntlmrelayx.py' || /ntlmrelayx/.test(cmd)) return { tool: first, mitreTtp: 'T1557.001', category: 'cred_access' }

  // --- Execution ---
  if (first === 'psexec.py' || /psexec\.py/.test(cmd) || first === 'wmiexec.py' || /wmiexec\.py/.test(cmd) || first === 'smbexec.py' || /smbexec\.py/.test(cmd)) return { tool: 'impacket', mitreTtp: 'T1021.002', category: 'execution' }
  if (first === 'powershell' || first === 'pwsh') return { tool: first, mitreTtp: 'T1059.001', category: 'execution' }
  if (first === 'msfconsole' || first === 'msfvenom') return { tool: first, mitreTtp: 'T1588.002', category: 'execution' }

  // --- Defense Evasion / Payload staging ---
  if (/base64\s+-d|base64\s+--decode/.test(cmd) && /(bash|sh|python|perl|node)/.test(cmd)) return { tool: 'base64-decode-exec', mitreTtp: 'T1027', category: 'defense_evasion' }

  // --- File transfer (data-staging / ingress-tool-transfer) ---
  // Detected here (not just in a separate file-transfer event) so recon-only
  // wgets still get ATT&CK tagging. The dedicated file-transfer sibling event
  // is emitted from detectFileTransfer.
  if ((first === 'curl' || first === 'wget' || first === 'aria2c') && /-o\b|-O\b|--output|--remote-name/.test(cmd)) return { tool: first, mitreTtp: 'T1105', category: 'exfil' }
  if (first === 'scp' || first === 'rsync' || first === 'sftp') return { tool: first, mitreTtp: 'T1105', category: 'exfil' }

  return null
}

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
