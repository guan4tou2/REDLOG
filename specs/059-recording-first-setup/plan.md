# Plan

1. Keep the three existing adapters and installer. Offer a detected recommendation
   and manual selection inside RecordTerminalFlow; isolate request lifetime.
2. Use a bounded existence query over both event tiers for historical command
   proof. Expose through the existing events IPC/preload boundary; keep recent
   activity capped at 20. No settings/localStorage verification boolean.
3. Make HTTPS the sole principal web check and invalidate its nonce on context
   changes. Keep CA caveats, actual HTTP support and error recovery.
4. Put external setup first with an explicit built-in fallback. Decouple optional
   web preparation and make the proof layout responsive using existing tokens.
5. Use existing Vitest and Electron journeys, build/typecheck/gates, then record
   exact evidence and platform limits. No new framework or paid model.

OpenCode writes a bounded patch in an isolated tracked-source copy using only
`opencode/deepseek-v4.1-flash-free`; the integrating agent inspects the patch,
verifies behavior and records gaps. No untracked operator evidence is provided.
