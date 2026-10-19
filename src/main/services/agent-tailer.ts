// The agent tailer: registers the three bundled transcript adapters with the
// tailer host and exposes the configure/stop pair main/index.ts drives from
// `config.agentTailer`. The host owns the plumbing (tailer-host.ts); each
// adapter owns its agent's format (adapters/).

import fs from 'fs'
import os from 'os'
import path from 'path'
import { configureHost, stopHost, registerAdapter, type TailerHostConfig } from './tailer-host'
import { claudeCodeAdapter, overrideClaudeProjectsDir } from './adapters/claude-code'
import { codexAdapter, overrideCodexTranscriptRoot } from './adapters/codex'
import { opencodeAdapter, overrideOpencodeStorageRoot } from './adapters/opencode'

export interface AgentTailerConfig extends TailerHostConfig {
  /** Root of Claude Code's per-session transcripts. Overridable for tests
   *  and for cross-platform paths. */
  claudeProjectsDir?: string
  /** Root of Codex CLI's session rollouts (default `~/.codex/sessions`).
   *  Test-only override — no user-facing config. */
  codexSessionsDir?: string
  /** Root of OpenCode storage dir (default
   *  `~/.local/share/opencode/storage`). Test-only override. */
  opencodeStorageDir?: string
}

let adaptersRegistered = false

export function configureAgentTailer(next: Partial<AgentTailerConfig>): void {
  const { claudeProjectsDir, codexSessionsDir, opencodeStorageDir, ...hostCfg } = next
  if (claudeProjectsDir) overrideClaudeProjectsDir(claudeProjectsDir)
  if (codexSessionsDir) overrideCodexTranscriptRoot(codexSessionsDir)
  if (opencodeStorageDir) overrideOpencodeStorageRoot(opencodeStorageDir)
  if (!adaptersRegistered) {
    registerAdapter(claudeCodeAdapter)
    registerAdapter(codexAdapter)
    registerAdapter(opencodeAdapter)
    adaptersRegistered = true
  }
  configureHost(hostCfg)
}

export function stopAgentTailer(): void {
  stopHost()
}

export interface AgentSourceInfo {
  id: string
  label: string
  /** The directory the adapter watches, with `~` expanded for display. */
  root: string
  /** Whether that directory exists on this machine. This says the tool has
   *  written sessions there, not that anything is being read. */
  detected: boolean
}

const AGENT_LABELS: Record<string, string> = { 'claude-code': 'Claude Code', codex: 'Codex CLI', opencode: 'OpenCode' }

/** What the tailer can read and whether each source is on this machine. Nothing
 *  is opened or read: it only checks that the watched directory exists. */
export function describeAgentSources(): AgentSourceInfo[] {
  return [claudeCodeAdapter, codexAdapter, opencodeAdapter].map((a) => {
    const glob = a.transcriptGlob.startsWith('~/') ? path.join(os.homedir(), a.transcriptGlob.slice(2)) : a.transcriptGlob
    const star = glob.search(/[*?[{]/)
    const root = (star === -1 ? glob : glob.slice(0, star)).replace(/[\\/]+$/, '')
    return { id: a.agentKind, label: AGENT_LABELS[a.agentKind] ?? a.agentKind, root, detected: fs.existsSync(root) }
  })
}
