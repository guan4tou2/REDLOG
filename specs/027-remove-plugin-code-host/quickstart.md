# Quickstart: Remove the Plugin Code Host

1. Drop a plugin whose manifest contributes `exporters` into
   `~/.redlog/plugins/` and reload; confirm it shows an error naming the key.
2. Build a package and confirm `plugin-runner.js` is absent from Resources.
3. Read the plugin guide's privileged section and confirm it says tailers run in
   the main process, bundled only.
