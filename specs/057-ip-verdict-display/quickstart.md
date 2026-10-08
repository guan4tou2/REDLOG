# Quickstart: validating the IP verdict display

This guide proves the feature end to end. The expected states and copy are in
[contracts/surfaces.md](contracts/surfaces.md). The wire shape is in
[contracts/ip-status.md](contracts/ip-status.md).

## Prerequisites

- Run `npm install`.
- On Windows, the e2e needs the Electron ABI build of better-sqlite3. `pree2e`
  runs `electron-rebuild` for it, and `pretest` rebuilds it for Node before
  `npm test`.
- Run `npm run build` before the e2e, which runs against the built app.

## 1. Targeted tests

```bash
npx vitest run test/alert/ip-display.test.ts test/alert/ip-status.test.ts test/ip-verdict-surfaces.test.tsx test/overlay-pass-through.test.ts test/design-tokens.test.ts test/i18n-terminology.test.ts test/i18n-keys.test.ts
```

What each test proves:

- **`ip-display`**: the derivation table in data-model.md, including the nine
  A.1 cells, a failed read after each current state, air-gap mode, checking,
  and settling.
- **`ip-status`**: `AlertRuntime.ipStatus()`, with `fetch` stubbed. A-3 is
  `presumed_safe`, and A-5 and A-9 are `off_profile`. A failed read after an
  exposure is `no_reading` with `alarm` and `lastReading`. Settling clears
  when the old address returns, even though the badge keeps
  `settling: true`.
- **`ip-verdict-surfaces`**: each state's label, tone, mark, hint and address
  marking on the HUD, the card and the status bar:
  - the Exposed IP list hint appears only for `exposed`;
  - the set-the-lists hint appears only for `unconfigured`;
  - the frame flashes only for `exposed`.
- **`overlay-pass-through`**: `handleIpAlarmChange(true)` turns pass-through off
  and makes the HUD fully opaque.

## 2. The desktop journey

```bash
npm run build
npx playwright test e2e/ip-verdict-display.spec.ts e2e/hud-overlay.spec.ts e2e/cli-smoke.spec.ts
```

`ip-verdict-display.spec.ts` serves a local HTTP provider (`{"ip": "…"}`) and
saves `network.ipMode: 'http'`, pointing `providers` at that provider, with
`confirmations: 1` and `checkInterval: 1`. It then walks these steps:

| Step | Lists and answer | HUD | Status bar and card |
|---|---|---|---|
| 1 | Exposed list holds the answered address | EXPOSED, red frame, flashing, opened and held | EXPOSED, and the Exposed IP list hint |
| 2 | Provider answers 500 | NO READING, amber frame, still held, "Last reading: EXPOSED" | the same line, and no set-the-lists hint |
| 3 | Safe list set, address outside it | OFF-PROFILE, orange frame, not flashing, held | OFF-PROFILE, and never the Exposed IP list hint |
| 4 | Exposed list only, address not on it | PRESUMED SAFE, hollow mark | the verify hint |
| 5 | `network.offline: true` | LOOKUP OFF | the air-gap hint |

The HUD's opacity is read from main (`BrowserWindow.getOpacity()`). It is 1 at
steps 1–3.

`hud-overlay.spec.ts` checks that the HUD still sizes to the longer labels.
`cli-smoke.spec.ts` checks that `status` still runs.

## 3. The status API

With the app running and a project open:

```bash
curl -s -H "Authorization: Bearer $(cat ~/.redlog/api-token)" "http://127.0.0.1:$(cat ~/.redlog/api-port)/api/status"
```

The `ip` object has `ipSafety`, one of the seven values, and `alarm`. Its
`lastReading` and `reason` are set only when `ipSafety` is `no_reading`.
`redlog-cli status` prints the same state. When the alarm is held, it also
prints the last reading.

## 4. Manual walk-through

TESTING.md §5.1 and §5.2 are rewritten to these checks.

1. **Blacklist only**, your real egress on it, VPN off: EXPOSED, red, flashing.
   Reconnect the VPN: PRESUMED SAFE, green and hollow, never SAFE.
2. **Whitelist your VPN exit, blacklist your home IP**, then join a phone
   hotspot (A-9): OFF-PROFILE, orange, not flashing. The HUD opens, pass-through
   comes off, and the hint names the Safe IP list.
3. **Pull the network after step 2.** At the next read the surfaces show NO
   READING, "Last reading: OFF-PROFILE" and its age. The HUD stays held.
   Reconnect: the read decides again.
4. **Settings ▸ Network ▸ air-gap on**: LOOKUP OFF, with the hint to turn
   lookups back on.
5. **Change the egress address with `confirmations: 3`**: NEW IP… appears on
   every surface until the address is confirmed. The candidate address never
   appears.

## 5. Gates

```bash
npm run typecheck
npm test
npm run verify:specs
npm run verify:architecture
```

The verification record (`verification.md`, from
`.specify/templates/overrides/verification-template.md`) lists:

- why each RED test failed first;
- these results;
- the outcome of every workflow gate: Clarify, Checklist, Analyze and Converge.
