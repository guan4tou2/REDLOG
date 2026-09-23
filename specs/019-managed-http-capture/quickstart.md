# Quickstart: Managed HTTP Capture

1. Install mitmdump with `uv tool install mitmproxy`, then open a project.
2. Confirm capture is stopped. Click **Start HTTP capture** to start it.
3. **Launch capture browser** also explicitly starts the configured local proxy
   before opening a browser. Custom remote proxies remain external.
4. In Browser settings, enable **Route new terminal panes through HTTP capture**
   only if desired. Verify new panes receive proxy variables while it is running.
5. Existing panes keep their environment: open a new pane after changing routing.
6. Stopping capture does not start it again when changing the configured port.
7. Close the project and confirm the owned process exits.

TLS trust is not installed automatically. Tools that ignore proxy variables and
non-HTTP protocols are outside this capture path.
