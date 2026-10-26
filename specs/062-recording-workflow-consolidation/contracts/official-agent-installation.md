# Official AI plugin installation backend

Scope: US5 installation backend, not activation. Shared types exported by src/core/plugins/official-agents.ts.

- plugins:officialAgents(): exactly Claude Code and Codex catalog entries; state not-installed / installed / conflict / error. A read error cannot become not-installed. Listing does not create folders.
- plugins:installOfficialAgent(agentKind): accepts only claude-code / codex; copies only the selected app-supplied manifest and checksum-validated parser package locally; does not install the AI tool, access the network or change project configuration. Repeated valid install is a no-op.
- plugins:uninstallOfficialAgent(agentKind): removes only the exact managed manifest and parser plus their otherwise-empty directory; modified files, unknown extra files or symlinks are refused. Missing install is a no-op. No recursive deletion.
- Failed mutations return {ok:false,error}; partial removal also carries changed=true and pluginId so the host refreshes actual state. Successful ones return {ok:true,changed,pluginId}. IPC refreshes loaded plugin metadata and capture decisions only when changed, and records an install-state audit through existing plugin audit behavior.
- Renderer never supplies a filesystem source or destination. Generic third-party plugin/trust operations remain unchanged.

Clarify: no additional question required for the installation-only increment; supplied user decisions fix the two tools, default uninstalled and explicit install. Checklist: no automatic installation, no tool installation, no transcript data reads, safe ownership, no silent error, no evidence deletion. Analyze: canonical manifest validator/loader and existing plugin IPC retained; activation is explicitly deferred rather than duplicated.

2026-10-26 scope: OpenCode is not distributed or installable. Unrecognized project provider settings cannot authorize capture without a current catalog entry. Existing evidence is not deleted.
