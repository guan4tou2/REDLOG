# WSL diagnostics fixture

`wsl-diagnostics-output.txt` is the **real** output of
`hooks/wsl-redlog-test.sh`, not a hand-written approximation of it.

#433 was caused by exactly that gap: the unit test fed the parser a
`[PASS] name: message` format the script never emits, so the test passed while
every real `✗` line was shown as a green `+` in Settings.

## How it was captured

The script calls `cmd.exe`, `wslpath`, `wslinfo`, `ip` and `curl`, which do not
exist on a non-WSL machine. It was run with stub binaries first on `PATH` and a
temporary Windows-profile directory, so the control flow reached the failure
branch:

```sh
TMP=$(mktemp -d)
mkdir -p "$TMP/bin" "$TMP/winhome/.redlog"
printf 'tok-123' > "$TMP/winhome/.redlog/api-token"
printf '6661' > "$TMP/winhome/.redlog/api-port"
# cmd.exe prints a Windows profile path, wslpath maps it, wslinfo reports nat,
# ip reports a default route, curl answers health/count and fails the POST.
WSL_DISTRO_NAME=Ubuntu PATH="$TMP/bin:$PATH" bash hooks/wsl-redlog-test.sh
```

The captured bytes were then copied here with only the temporary paths
replaced by `/home/tester`. The ANSI escapes, the `✓/✗/!` marks, the
indentation and the remediation lines are the script's own.

## Regenerating

Re-run the command above (or run the script inside a real WSL distro) and
replace the file. Do not reformat it: the parser is being tested against
exactly the bytes the script emits, escape sequences included.
