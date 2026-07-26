#!/bin/bash
# Install RedLog shell hook
set -e

DEST="$HOME/.redlog/shell-hook.zsh"
SRC="$(cd "$(dirname "$0")" && pwd)/redlog-hook.zsh"

mkdir -p "$HOME/.redlog"
cp "$SRC" "$DEST"
chmod 644 "$DEST"

echo "Installed to: $DEST"
echo ""
echo "Add this line to your ~/.zshrc:"
echo '  source ~/.redlog/shell-hook.zsh'
echo ""
echo "Then: source ~/.zshrc"
