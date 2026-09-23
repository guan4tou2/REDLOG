# Research: Remove the Plugin Code Host

- **Decision**: remove the host and everything that exists only for it; keep
  the trust gate.
- **Checked before deciding**: whether the trust and capability-grant flow is
  part of the unused tier. `PRIVILEGED_KEYS` includes `tailers`, which
  `applyContributions` loads from bundled plugins after a trust check. No
  bundled plugin contributes one today, but the path is live and the gate is
  its only protection, so it stays. The audit that proposed this change had it
  wrong.
- **Why refuse rather than ignore the retired keys**: the validator tolerates
  unknown keys for forward compatibility. `exporters` and `monitors` are not
  future keys; they were documented as privileged capabilities, so a plugin
  shipping one expects it to run. Ignoring it would look like success.
- **Why the trust fixtures moved to `tailers`**: after the change a manifest
  with `exporters` is refused outright. A path-escape test using `exporters`
  would still pass — for the wrong reason, the refusal — and stop testing path
  safety. `tailers` keeps each test on its original subject.
- **Documentation**: the README and plugin guide described isolation as a
  security property. Plugin code that does run is loaded into the main process;
  saying otherwise misleads the people deciding what to install.
