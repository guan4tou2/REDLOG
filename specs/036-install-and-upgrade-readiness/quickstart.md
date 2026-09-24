# Quickstart: Install and Upgrade Readiness

1. On a machine without python3, launch RedLog: the readiness card names
   python3 and shows `sudo apt install python3` (Kali) — "開始使用" still works.
2. Add `source ~/.redlog/shell-preexec-hook.sh` to `~/.zshrc`, relaunch: the
   banner offers to update the hook; after it, `~/.zshrc.redlog-bak-*` exists.
3. Install mitmproxy with `uv tool install mitmproxy`, launch RedLog from the
   Dock: HTTP capture starts.
