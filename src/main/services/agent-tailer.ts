// The agent tailer: registers the three bundled transcript adapters with the
// tailer host and exposes the configure/stop pair main/index.ts drives from
// `config.agentTailer`. The host owns the plumbing (tailer-host.ts); each
// adapter owns its agent's format (adapters/).

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
