#!/usr/bin/env bash
# RedLog × Claude Code Hook — v0.7.3+
#
# HISTORICAL: this script used to POST a `claude_code_bash` event to
# RedLog per PostToolUse-with-matcher-Bash fire (~100ms latency,
# 500-char output preview, Bash tool only). That path was the sole
# source of AI-agent audit through v0.7.1.
#
# CURRENT: v0.7.2 introduced `src/main/services/agent-transcript-tailer.ts`,
# which watches Claude Code's own transcript JSONL at
# `~/.claude/projects/**/<session>.jsonl` and emits per-turn events
# (`agent.user_message`, `agent.assistant_message`, `agent.tool_call`,
# `agent.tool_result`) plus a hash-chained sidecar snapshot stream.
# The tailer captures EVERY tool (Read/Write/Edit/Grep/Task/MCP/etc.,
# not just Bash), the FULL tool_input, up to 100KB of tool_result, the
# user prompt text, and the assistant response text. It also handles
# `/compact` and `/clear` correctly. In short: it's the strict superset.
#
# Keeping both producers active would double-emit every Bash call —
# one `claude_code_bash` from here plus `agent.tool_call{Bash}` +
# `agent.tool_result{Bash}` from the tailer. Timeline would show three
# rows per action. The v0.7.2 code-review adversarial pass called this
# out as High-priority; this is the fix.
#
# So v0.7.3 retires this script to a NO-OP stub. It's kept in place
# (rather than uninstalled from `~/.claude/settings.json`) so existing
# operator configs keep working without a manual edit. New installs
# will stop wiring PostToolUse to this script entirely — see
# hooks-manager.ts for the install flow.
#
# If you're reading this because your Timeline stopped showing bash
# commands: check Settings ▸ Capture ▸ Agent transcript tailer is
# enabled. The tailer picks up bash calls with the same ~100ms
# latency (chokidar fires on the transcript file write immediately),
# so the UX should feel identical minus the "3 rows per call" bug.

exit 0
