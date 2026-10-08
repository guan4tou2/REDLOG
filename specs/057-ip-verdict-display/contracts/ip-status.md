# Contract: IP status

One shape crosses every boundary. It is defined once, as `IPStatus` in
`src/core/alert/ip-display.ts`, and it is:

- the result of `ip:getStatus` (renderer and HUD, invoke);
- the payload of `ip:status` (pushed from main to the main window and the HUD
  on every producer tick);
- the `ip` field of `GET /api/status` (agents and `redlog-cli status`).

This is a breaking change to the `ipSafety` values, with no compatibility alias
(Spec 006 precedent; recorded in the CHANGELOG).

## Shape

```ts
type IPDisplayState =
  | 'exposed'        // on the Exposed IP list (fact)
  | 'off_profile'    // a Safe IP list is set and the address is outside it (fact)
  | 'safe'           // on the Safe IP list (fact)
  | 'presumed_safe'  // only an Exposed IP list is set and the address is not on it (inference)
  | 'unconfigured'   // an address was read but no list is set
  | 'no_reading'     // the last lookup failed, or air-gap mode is on
  | 'checking'       // no lookup has completed yet

interface IPStatus {
  externalIP: string | null     // last stable address; with no_reading, the last known one
  internalIP: string | null
  ipSafety: IPDisplayState
  alarm: boolean                // stop and ask before network-touching actions
  lastReading: {                // only with no_reading, once a read has succeeded
    state: 'exposed' | 'off_profile' | 'safe' | 'presumed_safe' | 'unconfigured'
    at: number                  // ms since epoch: the last successful read
  } | null
  reason: 'lookup_failed' | 'air_gap' | null   // only with no_reading
  settling: boolean             // a different address is being confirmed
  lastCheck: number             // ms since epoch: the last read, success or failure
  error: string | null          // provider error text from the last failed read
  link?: { type: 'wifi' | 'wired' | 'unknown'; name: string }
}
```

The invariants are listed in [data-model.md](../data-model.md#invariants-on-ipstatus).
In short:

- `alarm` is true for `exposed` and `off_profile`, and for a `no_reading` whose
  `lastReading.state` is one of those two.
- `reason` and `lastReading` accompany `no_reading` only.
- `settling` accompanies a current reading only.

## Migration from the old values

| Old `ipSafety` | New `ipSafety` |
|---|---|
| `safe` | `safe`, or `presumed_safe` when only an Exposed IP list is set |
| `exposed` | `exposed`, or `off_profile` when a Safe IP list is set and the address is outside it |
| `unknown` | `unconfigured`, `no_reading` or `checking` |

A consumer that tested `ipSafety === 'exposed'` to decide whether to stop
tests `alarm` instead. That keeps it stopping wherever it stopped before:
`exposed` and `off_profile`, the two values the old `exposed` covered. It also
stops for a failed read after either of them (FR-019).

## Examples

An exposure:

```json
{ "externalIP": "198.51.100.23", "internalIP": "192.168.1.20",
  "ipSafety": "exposed", "alarm": true, "lastReading": null, "reason": null,
  "settling": false, "lastCheck": 1790000000000, "error": null }
```

A failed read after an off-profile reading. The alarm is held:

```json
{ "externalIP": "203.0.113.9", "internalIP": "192.168.1.20",
  "ipSafety": "no_reading", "alarm": true,
  "lastReading": { "state": "off_profile", "at": 1789999880000 },
  "reason": "lookup_failed", "settling": false,
  "lastCheck": 1790000000000, "error": "All IP providers failed" }
```

Air-gap mode, with no successful read in this run:

```json
{ "externalIP": null, "internalIP": "192.168.1.20",
  "ipSafety": "no_reading", "alarm": false, "lastReading": null,
  "reason": "air_gap", "settling": false,
  "lastCheck": 1790000000000, "error": "offline (air-gap)" }
```

A verified exit while a new address is being confirmed. The verdict is still
the stable address's:

```json
{ "externalIP": "10.8.0.14", "internalIP": "192.168.1.20",
  "ipSafety": "safe", "alarm": false, "lastReading": null, "reason": null,
  "settling": true, "lastCheck": 1790000000000, "error": null }
```

## Consumers

| Consumer | Reads | Change |
|---|---|---|
| `src/main/index.ts` `broadcastIPStatus` | `alarm` | calls `handleIpAlarmChange(status.alarm)` |
| `src/main/ipc/overlay.ts` | — | `handleIpExposedChange` becomes `handleIpAlarmChange` |
| `OverlayApp.tsx` (HUD) | all | force-open and auto-collapse guard on `alarm`; see [surfaces.md](surfaces.md) |
| `IPStatusCard.tsx`, `StatusBar.tsx` | all | see [surfaces.md](surfaces.md) |
| `src/core/api-server.ts` `/api/status` | whole object | none; `AlertRuntimeSlice.ipStatus()` is typed `IPStatus` |
| `cli/redlog-cli.js status` | `ipSafety`, `alarm`, `lastReading` | prints the state, the held alarm and the last reading |
| `docs/skills/redlog-pentest.md` | `alarm` | "stop and ask while `ip.alarm` is true" |
| `docs/api-reference.md`, `docs/agent-integration.md` | — | define `IPStatus` and the stop rule |
| `test/renderer-smoke.test.tsx` | a fixture | adds the new fields |
