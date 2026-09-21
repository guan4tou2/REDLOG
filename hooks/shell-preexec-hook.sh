#!/usr/bin/env bash
# Compatibility entry point for existing built-in terminals, WSL instructions,
# and profiles that source the historical combined hook. New installs use the
# shell-specific adapters directly.

if [[ -n "${ZSH_VERSION:-}" ]]; then
  _redlog_legacy_dir="${${(%):-%N}:A:h}"
  source "$_redlog_legacy_dir/shell-zsh-hook.zsh"
elif [[ -n "${BASH_VERSION:-}" ]]; then
  _redlog_legacy_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  source "$_redlog_legacy_dir/shell-bash-hook.sh"
else
  printf 'redlog: supported POSIX shells are bash and zsh\n' >&2
  return 1 2>/dev/null || exit 1
fi
unset _redlog_legacy_dir
