#!/usr/bin/env zsh
# Compatibility entry point retained for profiles installed before the
# shell-specific adapters. A current one-click install places the adapter and
# common runtime in ~/.redlog, which this file prefers when present.

_redlog_legacy_zsh_dir="${${(%):-%N}:A:h}"
if [[ -f "$_redlog_legacy_zsh_dir/shell-zsh-hook.zsh" ]]; then
  source "$_redlog_legacy_zsh_dir/shell-zsh-hook.zsh"
elif [[ -f "$_redlog_legacy_zsh_dir/../hooks/shell-zsh-hook.zsh" ]]; then
  source "$_redlog_legacy_zsh_dir/../hooks/shell-zsh-hook.zsh"
else
  print -u2 'redlog: shell-zsh-hook.zsh is missing; reinstall the Zsh hook from RedLog Settings'
  return 1 2>/dev/null || exit 1
fi
unset _redlog_legacy_zsh_dir
