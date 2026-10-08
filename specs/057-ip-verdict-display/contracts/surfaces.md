# Contract: how each surface shows the IP state

The HUD, the dashboard IP card and the status bar read one presentation table,
`src/renderer/src/lib/ip-presentation.ts`. It is keyed by `IPDisplayState`, so a
missing state fails the typecheck. The table replaces the three private maps
in:

- `OverlayApp.tsx`: `STATE`, `LABEL` and `STATUS_TXT`;
- `IPStatusCard.tsx`: `STATUS_CONFIG`;
- `StatusBar.tsx`: `safetyDot` and `safetyLabel`.

Each surface keeps its own styling. The table decides only the tone, the mark,
the pulse and the text keys. Tones and marks follow research R7.

## The table

| State | Tone | Mark | Pulse | Short label (status bar, HUD bar) | Status line (HUD pane, card) | Hint |
|---|---|---|---|---|---|---|
| `exposed` | red | solid | yes | EXPOSED · 暴露 | Exposed IP — Not Protected · 暴露 IP — 未受保護 | `ip.exposedHint` (unchanged) |
| `off_profile` | orange | solid | no | OFF-PROFILE · 非預期出口 | Off-profile — not one of your Safe IPs · 非預期出口 — 不在安全 IP 清單 | not one of your Safe IPs: check the VPN or tunnel, or add the exit if you expect it |
| `safe` | green | solid | no | SAFE · 安全 | Safe IP — Protected · 安全 IP — 受保護 | — |
| `presumed_safe` | green | hollow | no | PRESUMED SAFE · 推定安全 | Presumed safe — not verified · 推定安全 — 未經驗證 | not on your Exposed IP list: list your expected exits as Safe IPs to verify it |
| `unconfigured` | amber | solid | no | NO LISTS · 未設清單 | Not classified — no lists set · 未判定 — 尚未設定清單 | the existing set-the-lists hint, shown only here |
| `no_reading`, `lookup_failed` | amber | hollow | no | NO READING · 無讀數 | No current reading — the lookup failed · 目前沒有讀數 — 查詢失敗 | check the network, the VPN or the providers |
| `no_reading`, `air_gap` | amber | hollow | no | LOOKUP OFF · 查詢已關閉 | No current reading — lookups are off (air-gap) · 目前沒有讀數 — 已關閉查詢（離線模式） | lookups are off by your choice; turn them back on in Settings ▸ {{page}} |
| `checking` | amber | hollow | no | CHECKING · 檢查中 | Checking… · 檢查中… | — |

The copy is a proposal, and the tasks settle it. Four constraints hold:

- Every short label and every status line is unique within its language, so
  each state can be named with the colour removed (FR-013, SC-005).
- zh-TW uses the fixed glossary (`test/i18n-terminology.test.ts`).
- A hint that names a settings page uses `{{page}}`.
- A short label fits the width that `EXPOSED` plus an address takes today. The
  held-alarm line may add to that width while it shows. `hud-overlay.spec.ts`
  guards the HUD's width.

## Modifiers

- **A new address is being confirmed** (`settling`, FR-017):
  - The short indicator is NEW IP… · 新 IP 確認中. The long one is "A new
    address is being confirmed" · 偵測到新位址，確認中.
  - It sits beside the state and never replaces its label, tone or mark.
  - It never shows the candidate address, or how that address compares with the
    lists.
  - It appears on the status bar, the HUD bar, the HUD pane and the card. A
    failed read hides it (`settling` is false with `no_reading`).
- **An alarm held through a failed read or air-gap mode** (`no_reading` with
  `alarm`, FR-016):
  - The line reads "Last reading: EXPOSED · 3m ago" · 上次讀數：暴露 · 3 分鐘前.
    It uses the short label of `lastReading.state` and `formatFreshness` on
    `lastReading.at`.
  - The status bar, the HUD pane and the card show it (FR-001). It is not red,
    and it does not flash.
- **The last known address** (`no_reading`, FR-011):
  - The HUD pane and the card mark the address "last known · 3m ago" ·
    最後已知 · 3 分鐘前.
  - The HUD bar dims it and appends its age.
  - The status bar hides the address while there is no current reading.
- **The provider's error text**: the card and the HUD pane print it dim, not
  red (FR-003).

## HUD behaviour

| State | Frame | Flash | Opened and held | Pass-through off, fully opaque (main) |
|---|---|---|---|---|
| `exposed` | red | when `overlay.flashOnExposed` is on | yes | yes |
| `off_profile` | orange | never | yes | yes |
| `no_reading` with `alarm` | amber | never | yes | yes |
| every other state | cyan | never | no | no |

"Opened and held" follows FR-002:

- The pane opens whenever the HUD receives `alarm: true` while it was not
  showing an alarm, and that includes the first status after the HUD mounts.
- A change from one alarm state to another does not reopen it.
- The 8-second auto-collapse is skipped while `alarm` lasts.
- The operator can still collapse the pane by hand with `hud-expand`.

Main turns pass-through off and makes the HUD fully opaque through
`handleIpAlarmChange(status.alarm)`. When the alarm ends, the HUD goes back to
its resting opacity. Pass-through stays off until the operator turns it back
on, as today.

## Test hooks

- Each surface's state element carries `data-testid="ip-state"`,
  `data-state={ipSafety}`, `data-tone` and `data-mark`.
- The HUD frame carries `data-testid="hud-frame"` and `data-flash`.
- The settling indicator carries `data-testid="ip-settling"`.
- The held-alarm line carries `data-testid="ip-last-reading"`.

Unit tests and the e2e assert on these hooks rather than parsing styles.
