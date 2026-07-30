#!/usr/bin/env bash
# RedLog × VPS hook deployment.
#
# Deploys the shell hook to a remote VPS and wires up a reverse SSH tunnel
# so commands run on the VPS get logged into the local RedLog chain. The
# hook fires per-command (bash/zsh preexec+precmd), same code path as the
# local hook — it just POSTs to 127.0.0.1:6660 from the VPS side, which
# routes back to the operator's machine through -R.
#
# Usage:
#   ./hooks/vps-deploy.sh install user@vps.example.com [--port 22]
#   ./hooks/vps-deploy.sh tunnel  user@vps.example.com [--port 22]
#   ./hooks/vps-deploy.sh uninstall user@vps.example.com [--port 22]
#
# `install` — one-time copy of the hook + write .zshrc / .bashrc source line
# `tunnel`  — foreground ssh with `-R 6660:127.0.0.1:6660`, keeps events flowing
# `uninstall` — remove the hook + source line
#
# Environment:
#   REDLOG_REMOTE_PORT=6660   local RedLog API port (default: read from ~/.redlog/api-port)
#   REDLOG_REMOTE_TOKEN=...   API token (default: read from ~/.redlog/api-token)

set -euo pipefail

SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
REDLOG_DIR="${REDLOG_DIR:-$HOME/.redlog}"

usage() {
  echo "Usage: $(basename "$0") <install|tunnel|uninstall> user@host [--port 22]"
  echo ""
  echo "Deploys the RedLog shell hook to a VPS and runs a reverse SSH tunnel"
  echo "so remote commands log into the local RedLog chain."
  exit 1
}

[[ $# -lt 2 ]] && usage

ACTION="$1"
TARGET="$2"
SSH_PORT=22
shift 2
while [[ $# -gt 0 ]]; do
  case "$1" in
    --port) SSH_PORT="$2"; shift 2 ;;
    *) echo "Unknown flag: $1"; exit 1 ;;
  esac
done

read_local() {
  local file="$REDLOG_DIR/$1"
  [[ -f "$file" ]] || { echo "Missing $file — is RedLog running?" >&2; exit 1; }
  cat "$file"
}

LOCAL_PORT="${REDLOG_REMOTE_PORT:-$(read_local api-port)}"
LOCAL_TOKEN="${REDLOG_REMOTE_TOKEN:-$(read_local api-token)}"

case "$ACTION" in
  install)
    echo "→ Copying hook to $TARGET..."
    scp -P "$SSH_PORT" "$SCRIPT_DIR/shell-preexec-hook.sh" "$TARGET:~/.redlog-hook.sh"
    # Push the token file too (mode 600) so the remote hook can authenticate.
    # We DON'T push the port file — the port on the remote is always the
    # tunnel's own port (6660), regardless of what the local machine listens on.
    ssh -p "$SSH_PORT" "$TARGET" "mkdir -p ~/.redlog && chmod 700 ~/.redlog"
    echo "$LOCAL_TOKEN" | ssh -p "$SSH_PORT" "$TARGET" "cat > ~/.redlog/api-token && chmod 600 ~/.redlog/api-token"
    echo "6660" | ssh -p "$SSH_PORT" "$TARGET" "cat > ~/.redlog/api-port && chmod 600 ~/.redlog/api-port"

    # Add source line to the remote shell rc if not already there.
    SOURCE_LINE='[ -f ~/.redlog-hook.sh ] && source ~/.redlog-hook.sh'
    ssh -p "$SSH_PORT" "$TARGET" "grep -qF 'redlog-hook.sh' ~/.bashrc 2>/dev/null || echo '$SOURCE_LINE' >> ~/.bashrc"
    ssh -p "$SSH_PORT" "$TARGET" "grep -qF 'redlog-hook.sh' ~/.zshrc 2>/dev/null || echo '$SOURCE_LINE' >> ~/.zshrc"

    echo ""
    echo "✔ Hook installed on $TARGET"
    echo ""
    echo "Now run:  $(basename "$0") tunnel $TARGET"
    echo "That opens an interactive ssh session with the reverse tunnel; every"
    echo "command you run on the VPS will hit RedLog while this session lives."
    ;;

  tunnel)
    echo "→ Opening interactive session with reverse tunnel (localhost:6660 ← VPS)..."
    echo "  Every command you run on $TARGET during this session hits RedLog."
    echo "  Exit (Ctrl-D) to close both the ssh session and the tunnel."
    echo ""
    # -R binds the remote 127.0.0.1:6660 back to our local 127.0.0.1:$LOCAL_PORT.
    # ServerAliveInterval keeps flaky links from silently dropping the tunnel.
    exec ssh -p "$SSH_PORT" \
      -R "6660:127.0.0.1:${LOCAL_PORT}" \
      -o ServerAliveInterval=30 \
      -o ServerAliveCountMax=3 \
      "$TARGET"
    ;;

  uninstall)
    echo "→ Removing hook from $TARGET..."
    ssh -p "$SSH_PORT" "$TARGET" "rm -f ~/.redlog-hook.sh ~/.redlog/api-token ~/.redlog/api-port"
    ssh -p "$SSH_PORT" "$TARGET" "sed -i.bak '/redlog-hook.sh/d' ~/.bashrc ~/.zshrc 2>/dev/null || true"
    echo "✔ Removed"
    ;;

  *) usage ;;
esac
