# Implementation Plan: Capture Packs

## Canonical module interface

`core/capture-packs.ts`:
- `CAPTURE_PACKS` — `hostMonitors` (process monitor, connection monitor, file
  watcher, clipboard), `aiAgents` (agent transcript tailer), `windowsOutput`
  (PowerShell transcript), each with its bundled plugin id.
- `isPackOn(config, id, plugins)` — the project turned it on and its bundled
  plugin is active. Every start/stop decision and health row reads this.

## Constitution Check

- **Surface Truthfulness**: one place lists what is recorded by default and
  what each pack adds; health rows for a removed pack disappear.
- **Explicit Failure**: a pack whose plugin is missing or disabled does not
  run and says so in Settings, rather than silently not recording.
- **Architectural Restraint**: no plugin code host; code stays in core, packs
  are declarations. No compatibility shim for the removed keys (Spec 006).
- **VIII Test-First**: pack gating, key removal and health paths start as
  failing tests.

## Design

1. Config: `packs: { hostMonitors, aiAgents, windowsOutput }` default false;
   remove the six member `enabled` keys from types and defaults.
2. Bundled manifests `plugins/pack-host-monitors`, `pack-ai-agents`,
   `pack-windows-output` (kind `pack`, no contributions); required by
   `verify-packaged-resources`.
3. main: services start/stop from `isPackOn`, on project open, config save and
   plugin enable/disable.
4. capture-health: member rows use `packs.<id>` as their switch path and are
   omitted when the pack's plugin is not active; config-audit records pack
   changes.
5. Settings ▸ Capture: an "Essential capture" summary, then one switch per
   pack with its members' tuning beneath; Agents page uses the AI pack switch.

## Domain invariants

Recording, masking and the chain are unchanged; only which optional sources
start changes.
