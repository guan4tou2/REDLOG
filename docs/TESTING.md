# Testing RedLog

Use the smallest test layer that proves the behavior. The current suites are
`test/` (Vitest) and `e2e/` (Playwright/Electron); installed-package journeys
reuse `e2e/` against an actual executable. Historical results are not new runs.

## Commands

Run the repository gates in this order before pushing:

```sh
git fetch origin main
npm run typecheck
npm run verify:specs
npm run verify:architecture
npm run verify:i18n
npm test
npm run build
```

`npm test` rebuilds SQLite for Node, then runs Vitest. `npm run e2e` rebuilds it
for Electron. Do not run these concurrently. Use `npm test` to request a Node
rebuild again. If the binding still fails, check the rebuild log, node-gyp
selection and headers before changing product code or skipping database tests.

| Purpose | Command | What it proves |
| --- | --- | --- |
| One behavior | `npx vitest run test/<file>.test.ts` | The selected domain, storage or rendered behavior; native modules must already use the Node ABI. |
| Local iteration | `npm run test:watch` | Vitest watch mode; same ABI requirement. |
| Source app journey | `npm run build` then `npm run e2e -- e2e/<file>.spec.ts` | Real Electron/IPC interaction with isolated test homes. |
| Whole source journey suite | `npm run e2e` | All source journeys; explicit platform/installed-only skips remain skips. |
| Package contents/signature | `npm run verify:package-resources` after packaging | Shipped adapters, verifier, manifests and macOS resource seal. |
| Installed app | Set `REDLOG_PACKAGED_APP` and run the relevant `e2e/packaged-*.spec.ts` | The actual installed executable and shipped resources. |
| Strict installation result | `node scripts/verify-smoke-report.mjs <report.json>` | Every selected test passed, with no skip, flaky result or `not-exercised` annotation. |
| Release asset contract | `RELEASE_TAG=v<version> node scripts/verify-release-assets.mjs <directory>` | All versioned installers and Windows updater metadata match the actual files. |

本機安裝版的預設驗收只跑 recording/delivery/restart 一條流程：

```sh
# 只列出範圍，不啟動 App，也不要求已安裝候選。
npm run e2e:smoke -- --list

# 正式執行需明確指定候選與 commit。正常 2 次啟動：初次 + 重啟讀回。
REDLOG_PACKAGED_APP='/absolute/path/to/RedLog' \
REDLOG_EXPECTED_BUILD=d2917021 npm run e2e:smoke
```

入口會先檢查 executable、commit 及 mitmdump，再啟動單一 packaged-smoke；不自動 retry、不加其他 suite。JSON report 每次存入獨立暫存資料夾，離開前沿用 `verify-smoke-report.mjs` 拒絕 skipped／flaky／not-exercised。About 在同一 App 開始時檢查，不為版本查核另啟動一個 App。直接執行原有 Playwright 命令仍可用於 CI 或刻意指定的驗收。

## Local iteration and process reuse

Run the affected fast tests while editing. Run the ordered full gates once on
one coherent implementation candidate, before submission; a later docs-only or
test-only cleanup does not require repeatedly running every shell benchmark.
A new failure or product change is a reason to rerun its affected checks.

Use one Electron process for a normal user journey, with a fresh project and
reset preferences/viewport for independent settings cases. Keep separate
processes for replaced IPC handlers, machine-wide plugin mutations, updater
restart tests and actual startup/installation differences. Reusing those blindly
would trade desktop interruptions for contaminated results.

本機依變更選一條，不把下表全部串跑：

| 變更 | 選取 | 正常 App 啟動次數 |
| --- | --- | --- |
| 候選安裝包／資源／recording 交付基線 | `npm run e2e:smoke` | 2，包含刻意重啟 |
| 外部 Shell 接入或匯出 UI／失敗恢復 | `e2e/export-preview.spec.ts` | 1，8 cases 共用 |
| Activity／搜尋／saved-content Reader | `e2e/http-body-search.spec.ts` | 1 |
| 首次設定操作流程 | `e2e/first-run.spec.ts --grep 'the first run'` | 1，11 cases 共用 |
| AI provider parser／privacy | 選對應 provider 或 privacy case | 每個被選的隔離案例 1 次 |
| 改設定元件與 source workflow | 先 Vitest；必要時才選 capture-settings-interaction | 完整檔案 3 次，包含 2 個隔離故障案例 |

上表單檔選取形式為 `REDLOG_PACKAGED_APP=... npx playwright test <selection>`；有 package 就優先使用它，沒有才使用 source。不為同一未變行為在 source／package 各跑一次。Shell、原生權限及重啟的適用性仍需如實記錄。

重建包先查 resources、簽章、hash 與來源狀態，再跑受影響的 installed smoke；只改 Build metadata 不重跑 AI 安裝／授權和全部 FirstRun。整套 `npm run e2e` 保留給 CI 或有明確理由的全量回歸，不是本機小修改的預設。

Renderer tests own draft state, stale replies, policy controls and messages;
storage tests own atomic receipt writes and project isolation. E2E retains only
cross-layer recording/delivery, failure recovery and actual layout/focus behavior.
Do not add another test whose only assertion is that an already-exercised
control exists. Native manual checks are for remaining OS-specific interactions,
not another replay of every passed CDP journey. Non-HUD shared-helper
launches keep the HUD hidden in the test process without changing its product
or project default. HUD-specific tests request `showHud: true`; a hidden HUD
fixture does not verify default HUD visibility.

## Coverage owners

| Requirement | Primary tests |
| --- | --- |
| Plain Zsh command/output/exit and terminal behavior | `zsh-auto-capture.pty`, `zsh-engagement-100.pty`, `zsh-transparency.pty`, `relay-pty-boundary` |
| Plain Bash command/output/exit and terminal behavior (bash 3.2 on macOS) | `bash-auto-capture.pty`, `bash-transparency.pty`, `bash-redlog-command.pty` (stop/start/mode/class) |
| Explicit `redlog-session` PTY: output kept, exit status, slave held until reaped | `external-session` |
| Debug log switch (machine-wide flag file, helper + app trace, no output text) | `debug-log`, `about-debug-log`, `external-session` |
| Hook transport, identity, spool and outages | `shell-*`, `spool-replay`, `per-project-token`, `powershell-*` |
| Capture setup, preparation/cancel and recovery | `capture-preparation`, `first-run`, `terminal-enrollment`, `dependency-cancel` |
| HTTP readiness, actual requests and proof | `managed-proxy-readiness`, `http-verification`, `managed-http-capture`, `packaged-smoke` |
| Query/filter/export and evidence integrity | `query-*`, `export-plan*`, `filtered-export`, `redlog-verify`, `packaged-smoke` |
| Project/pane isolation and saved recordings | `terminal-session-rotation`, `packaged-session-smoke`, `packaged-command-integrity` |
| UI tokens/contrast | `design-tokens` owns numerical contrast; `design-rules`/`design-palette` own source conventions. |
| Plugin manifests/contributions/trust | `plugins`, `starter-pack`, `builtin-tools-pack` |

File stems refer to `test/*.test.ts(x)` unless a journey is under `e2e/`.
Producer tests must compare real command output, exits and artifacts. Seeded
UI events prove rendering and interaction, not producer coverage.

## CI and platforms

- CI runs the five gates and build on Linux, Windows and macOS; Electron source
  journeys run on Linux. A green Linux result does not prove macOS PTY behavior.
- Linux package smoke installs/removes the x64 DEB and checks real capture,
  HTTP(S), export/restart and cancellation. Windows smoke installs/removes NSIS
  and checks native PowerShell plus capture/export. Both require strict JSON.
- Installed-only, native WSL, performance and public dependency-download tests
  have explicit prerequisites/opt-ins. Do not delete them merely because a
  source-only run skips them, or count them as passed.
- Manual download, desktop launch, trust prompts and first-install friction use
  [the release walkthrough](RELEASE-SMOKE-TEST.md). Exact prior package results
  and remaining limitations are in [the package matrix](PACKAGED-SMOKE.md).

## Races a test cannot reproduce

Some loss only happens under load: #333 lost a short command's output in about
1% of runs with the CPU saturated, and never in an idle suite. Do not add a
stress loop that passes when idle — it proves nothing and reads as coverage.
Measure the rate with the real helper under load, find the mechanism, then pin
the *property that removes it* (`external-session`: the parent keeps the PTY
slave until the child is reaped) and confirm the test fails against the old
code before trusting it.

When a capture report arrives without a cause, ask for the debug log first:
Settings → About → Debug log, reproduce, attach `~/.redlog/debug.log`. It holds
event names and sizes only, never command output.

## Keep the suite focused

Prefer observable behavior over assertions about source spelling. Keep unique
regressions for lost evidence, wrong attribution, privacy and terminal control.
Remove a duplicate only after identifying its retained coverage owner. An
obsolete requirement belongs in history, not a permanently skipped runnable
test. UI snapshots and a window opening do not prove successful recording.

The 2026-10-24 cleanup removed seven duplicate source-expression assertions
from `timeline-geometry-units`: zoom behavior remains in `timeline-geometry`,
gap detection/inversion in `timeline-time-map`, and viewport anchoring in the
presentation E2E. The three remaining source integration guards are now named
`timeline-track-wiring`; they are not visual acceptance. The obsolete dropdown
clipping check in `export-preview` now measures the current dialog's viewport
bounds and whether its action can actually receive a pointer click.

For manual layout acceptance, cover wide and small desktop windows, both
locales where wrapping differs, and empty/partial/error states. Inspect settings
navigation and content separately, long paths/URLs, scrolling, keyboard focus
and fixed action bars. Save exact app revision and screenshots with the dated
acceptance record; do not treat old screenshots as a new pass.

The former Part 1–6 option/audit matrix (including G-* references in historical
tests/specs) is [archived](archive/TEST-MATRIX-2026-10-16.md). It is not the
current procedure or an assertion that those historical gaps remain open.


## 發送內測候選

公開 release 與本機候選不能只靠 package.json 的版本號區分。App 的「關於」顯示版本與 build commit；`+local` 明示建置含未提交檔案，沒有 Git 資訊時顯示 `unknown`。正式內測交付使用乾淨、已提交的來源，附 OS／架構與 SHA-256；不要把本機檔案上傳覆蓋已發布的同版 asset。

Mac 內測安裝檔可使用獨立名稱，且不觸發發版：

```sh
npm run build
REDLOG_BUILD_ID=$(git rev-parse --short=8 HEAD) npx electron-builder --mac dmg --arm64 --publish never '-c.artifactName=RedLog-${version}-internal-${env.REDLOG_BUILD_ID}-${arch}.${ext}'
```

這不改動正式版本、更新 feed 或現有 release 檔名。發給第一次使用者的是指定安裝檔與使用者指南，不是原始碼開發流程。

安裝包的 Activity／大型輸出驗收可直接沿用同一工作流程，並核對 About 的 commit（不硬寫 UI 版本號）：

```sh
REDLOG_PACKAGED_APP='/absolute/path/to/RedLog.app/Contents/MacOS/RedLog' \
REDLOG_EXPECTED_BUILD=d2917021 \
npx playwright test e2e/http-body-search.spec.ts --reporter=line
```

直接執行 Activity spec 時，`REDLOG_EXPECTED_BUILD` 選用；`e2e:smoke` 則必填。指定時必須在 About 實際看到精確 Build，`+local` 不當作乾淨候選通過。electron-vite 讀 ESM 設定時建立的 `electron.vite.config.<timestamp>.mjs` 是編譯產物；應由根目錄 `.gitignore` 排除，不能因此略過真正的 tracked／untracked 來源修改檢查。
