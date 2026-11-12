# 06 — 驗證（Verification）：為什麼「CI 綠」一再不等於「能用」

審查對象：`main` @ a087c16c（2026-11-12）。唯讀；CI 數字取自 `gh run view`（main run 43160639864 與近 4 天 10 次失敗 run 的 log），本機只跑了一個 vitest 檔與兩次 `tsc`（暫存 tsconfig，不在 repo 內）。

## 摘要（10 行）

1. 主因不是測試太少（662 檔、6853 案例），而是**測試套件對「自己沒驗到什麼」沒有記帳**：略過、只在某個 runner 映像剛好成立、只在 scratch 目錄存在的驗證，都被報成綠色。
2. F1 略過是靜默且不分原因的：39 個檔（約 355 案例）用 catch-all 把「原生模組 ABI 不符」與「src 匯入時就壞掉」一起變成 skip；Windows 每次略過 730 案例；`csp-production` 對建置產物的 3 個檢查在三個平台的 CI 上**從未執行過**（Vitest 排在 Build 之前）。
3. F2 測試不擁有時間：149 個元件測試檔用真實等待且沒有 fake timers；Windows 上的「每次不同檔」失敗是同一秒內 5–8 個檔一起 15 s 逾時、`spawnSync ETIMEDOUT`——機器層級停頓撞上隱含時間預算。歷來的處理（15 s、37 處單點 `timeout:`）都是放大預算。
4. F3 測試沒有被證明「會紅」：`test/` 與 `e2e/` 完全不在 typecheck 範圍（今天 279 個型別錯誤）；有「拿掉兩層仍通過」的 Escape 測試、依推理不可能失敗的 unmount 測試、前提錯誤的原始碼掃描（聲稱 runner 沒有 pwsh，實際三平台都有）。
5. F4 只有真實執行能證明的事（release 版行為、負載、走查）住在 repo 外或只在 PR 路徑觸發：三支 QA 走查共 3419 行在 scratch；效能套件與 soak 從未排程；release 變體從未在 CI 啟動；macOS 無任何安裝包 smoke；release gate 只要求 `ci.yml`。
6. F5 跨平台覆蓋是「runner 映像剛好有什麼」：shell 版本未宣告，bash 5 幽靈事件只在 ubuntu 被新測試看到；Windows 對 bash adapter 只有 5 個 Git Bash 案例，其餘 POSIX shell 路徑全略過；`.gitattributes` 沒涵蓋 `.mjs/.ts`。
7. F6 五道 gate 都是「靜態一致性」檢查，看不到行為；沒有 lint（但 `src/` 有 26 個指向不存在 ESLint 規則的 disable 註解）；比對 ref 的 gate 在 main 上空轉。
8. 修正方向：一個「能力需求」介面讓 skip 在 CI 變成失敗；測試 harness 擁有時間；test/e2e 進 typecheck + red-before-green job + 核心模組 mutation testing；QA 走查入庫成 nightly/label 套件並設預算；shell 版本矩陣用容器宣告。
9. 每一階段都讓 CI 維持綠且「更誠實」：先記帳（只報告），再把記帳結果變成 gate，最後才擴大執行面。
10. 不再建議提高任何 timeout；不建議加 retries（目前 Vitest 與 Playwright 都沒有 retry，這點是對的）。

---

## 盤點

### test/ 分類（662 檔，約 5379 個 `it/test` 呼叫點；CI 實際展開為 6853 案例）

| 類別（啟發式 grep，可重疊） | 檔數 |
|---|---|
| 純單元（不 render、不 spawn、不讀 src、不開 DB） | 262 |
| 元件／jsdom（`@testing-library/react`） | 194 |
| 開 SQLite（`initDB`/better-sqlite3） | 125 |
| spawn 真實行程（shell、python、pwsh） | 46 |
| PTY（`*.pty.test.ts`、node-pty） | 24 |
| 讀 repo 檔案文字（src/hooks/scripts/workflows） | 142 檔讀檔；其中約 30 檔、70+ 處 `expect(SRC…)` 直接釘實作文字 |
| golden／等價／參照 | 約 6 個真正的 oracle 檔（見「已確認健全」） |
| property（fast-check） | 0 |
| 使用 fake timers | 38；用 `waitFor/findBy` 的 160 檔中，**149 個元件檔沒有 fake timers** |

### e2e/（52 spec）
全部由 `launchWithTempHome()` 啟動（`e2e/helpers.ts:64`，隔離 HOME/USERPROFILE/CODEX_HOME）；設了 `REDLOG_PACKAGED_APP` 就改跑安裝後的 exe，否則跑 `out/main`（未打包，`REDLOG_E2E` 開）。`packaged-*` 7 個 spec 只在 install-smoke workflow 跑；`capture-soak`、`stream-soak`、`terminal-soak` 需 `REDLOG_SOAK_MINUTES`，**沒有任何 workflow 設定它**。CI e2e：ubuntu、xvfb、3 shard、`workers:1`、無 retry；最新 main：80+64+75 通過、7+8+1 略過。

### Workflows
| workflow | 觸發 | 跑什麼 |
|---|---|---|
| `ci.yml` unit | PR、push main | ubuntu/windows/macos：typecheck → verify:specs → verify:architecture → verify:i18n → **Vitest → Build**（順序是關鍵，見 F1） |
| `ci.yml` e2e | 同上 | ubuntu only，unpackaged |
| `linux-install-smoke.yml` | **僅 PR 且路徑命中**、手動 | smoke 變體 DEB：安裝、6 個 spec、`verify-smoke-report` 嚴格不允許 not-exercised |
| `windows-install-smoke.yml` | 同上 | smoke 變體 NSIS：安裝、首次啟動、packaged-smoke、PS 5.1/7 matrix、解除安裝 |
| `release.yml` | tag | gate 只查 `ci.yml` 在該 sha 綠（`scripts/verify-release-ci.mjs:26`）；三平台 `npm test` + 打包 **release 變體** + `verify:package-resources`（含 fuse 讀回）；**不啟動 release 變體** |
| 排程（cron） | 無 | — |

### 行為類別 × 平台 × 層級（✓=CI 每次跑；P=只在路徑命中的 PR；L=僅本機或手動；S=CI 略過；—=未寫）

| 行為 | macOS（CI 映像 bash／zsh；本機 bash 3.2） | Linux（bash 5、zsh） | Win PS 5.1/7 | Git Bash | WSL |
|---|---|---|---|---|---|
| zsh hook（unit 真 PTY） | ✓ | ✓ | n/a | n/a | S（`findShellTarget` 需 WSL distro）/L |
| bash hook（unit 真 PTY） | ✓（版本＝映像決定，未宣告） | ✓ bash 5 | n/a | **S**（pty 檔全略過；只有 `git-bash-direct-send` 5 例 ✓） | — |
| PowerShell hook（unit 真 shell） | ✓ pwsh 7 | ✓ pwsh 7 | ✓ 5.1+7 | n/a | n/a |
| PTY relay / external session | ✓ | ✓ | S | S | — |
| 內建終端 / shell 整合（e2e） | — | ✓ unpackaged | —（多數 spec `skip win32`） | — | — |
| HTTP mitm（e2e 真 mitmdump） | — | ✓ | P（packaged） | — | — |
| 安裝包行為（smoke 變體） | **—**（只有手動） | P | P | — | — |
| release 變體（CSP、fuses 實效、啟動旗標拒絕、檔案權限） | L（手動，closeout §2） | 只有靜態 fuse 讀回（tag） | 同左 | — | — |
| 效能／負載／soak | L（`REDLOG_PERF`、`REDLOG_SOAK_*`、scratch 走查） | — | — | — | — |
| 真 IME、TCC、簽章公證、多螢幕 | L（只能手動） | — | — | — | — |

### 略過數（main run 43160639864）
- ubuntu：34 案例／7 檔全略過；macOS：37／7；**Windows：730 案例，53 檔全略過（657 例）**；本機 macOS：42（closeout 文件）。
- 三平台都略過（＝CI 從未執行）：`zsh-nc-upgrade.pty`（6，需 traditional nc；只在 Linux DEB smoke 有對應）、`zsh-latency.pty`（3）、`timeline-query-perf`（9）、`http-flow-query-perf`（2）、`export-workflow-perf`（1）、`secret-patterns-linear` 與 `loot-emit-dedup` 的比例測試各 1、**`csp-production` 3 例**。
- Windows 略過隱藏的：所有 zsh/bash PTY 行為、relay、`shell-*`（cwd 跳脫、專案切換、spool 上限、token 不進 argv…）、POSIX 權限（`export-file-mode`、`profile-export`、symlink 拒絕）——其中 bash adapter 的部分**正是 Git Bash 在 Windows 上會跑的程式碼**。

---

## Findings（依「解釋多少操作者可見錯誤 × 預防多少未來缺陷」排序）

### F1. 略過（skip）是靜默的、不分原因的，也沒有逐平台的帳——「沒驗」被報成「通過」

**機制。** 測試用「環境裡有沒有 X」決定 skip，但判斷式分不出「環境缺 X（合理）」與「程式或安裝壞了（應該紅）」，而且沒有任何東西記錄「這個平台預期略過哪些」。於是任何讓前提失效的變化——runner 映像少一個套件、步驟順序、原生模組 ABI、src 匯入期錯誤——都讓整檔安靜地變灰，run 照樣綠。

**實例。**
1. 39 個檔（約 355 案例）以 `try { await import(...) } catch { /* better-sqlite3 not built for this Node ABI */ }` 包住**所有**匯入，失敗即 `describe.skipIf(!available)`（例：`test/marker-amend.test.ts:15-35`、`chain-sampling.test.ts:33-38`、`cast-index`、`bundle-export`、`api-server`、`chain-concurrency`…）。catch 也吞下 `src/core/marker-amend.ts` 在模組頂層丟出的任何錯誤——那正是 CLAUDE.md 記載的「少一個 import → 執行期 ReferenceError，擷取停了三個 commit」那一類。memory 也記錄過 worktree 裡 electron-rebuild 會讓 vitest ABI 失配：那時這 355 例會整批變灰而非變紅。
2. `test/csp-production.test.ts` 的 3 個「已建置 renderer 不需要 unsafe-eval、入口腳本符合 CSP」檢查用 `skipIf(!fs.existsSync(out/renderer/...))`；`ci.yml` 把 `npm run build` 排在 Vitest **之後**（`ci.yml:102-125`），所以三平台每次都 `11 tests | 3 skipped`。CSP 最後只能在 closeout 裡「在打包的 mac app 手動驗證」。
3. 前例已被 workflow 註解承認兩次：ubuntu 沒裝 zsh 時「spec 052 每一個都報 skipped——一個什麼都沒檢查的綠 run」（`ci.yml:78-91`）；mitmdump 未安裝時 real-source e2e「每次都略過」（`ci.yml:172-183`）。兩次的修法都是「裝上缺的東西」，下一個缺的東西照樣靜默。
4. 已有零散的「必須真的跑」機制，但只在局部：`REDLOG_E2E_REQUIRE_MITMDUMP`、`REDLOG_REQUIRE_PS_EDITIONS`、`scripts/verify-smoke-report.mjs`（packaged 報告中出現 not-exercised 即失敗）。Vitest 這一層沒有對應物。
5. `test/powershell-spool-needs-project.test.ts:5-6` 以「pwsh 在 Linux/macOS runner 上不存在」為由改成掃描原始碼；同一份 CI log 顯示 `powershell-hook-exit-code` 在 ubuntu 跑了 7 例、macOS 14 例（pwsh 都在）。skip/替代的理由沒被任何東西核對過。

**為何先前只治標。** 每次都是補上那一個缺的前提（裝 zsh、裝 mitmdump、加 fetch-depth），沒有建立「預期略過集合」，所以下一個前提失效時一樣看不到。

**結構性修正。**
- 引入 `test/helpers/requires.ts`：`requires('sqlite-native' | 'zsh' | 'bash' | 'pwsh' | 'ps51' | 'git-bash' | 'pty' | 'listen' | 'python' | 'mitmdump' | 'built-renderer' | 'traditional-nc' | 'perf')`。每個能力有一個**窄的**探測（例：`sqlite-native` 只在 `err.code === 'ERR_DLOPEN_FAILED'` 或訊息含 `NODE_MODULE_VERSION` 時算「缺」，其他錯誤原樣丟出 → 紅）。缺能力時：本機 skip 並寫出原因；若 `REDLOG_REQUIRE` 列出該能力則 **throw**。
- 引入 `test/skip-manifest.json`：`{ "<os>": { "<file>": "<capability>" } }`，由一個自訂 Vitest reporter（約 60 行，讀 task 結果）比對：出現清單外的略過 → 失敗；清單內但這次有跑 → 失敗（清單只會縮小，與 `architecture-allowlist.json` 同一模式）。
- 刪除：39 處 catch-all import、所有 `process.platform === 'win32' ? describe.skip : describe` 的手寫變體（改用 `requires`）。
- 搬移：CI 在 Vitest 之前先 `npm run build`（或把 `csp-production` 的建置檢查移到 Build 之後的獨立步驟，以 `REDLOG_REQUIRE=built-renderer` 執行）。
- 不變式：「CI 每個 leg 的略過集合＝manifest 中該 OS 的集合」，由 reporter 強制；「略過理由必為能力缺失，不可能是匯入期程式錯誤」，由窄探測強制。

**遷移。** (1) reporter 先只**輸出**每 OS 的略過清單成 artifact（不失敗）；(2) 從三個 leg 的輸出產生初版 manifest 入庫，reporter 改為失敗；(3) 逐檔把 catch-all 換成 `requires()`，每換一批 manifest 不變；(4) 調整 build 順序，`csp-production` 從 manifest 移除；(5) 對每個 CI leg 設 `REDLOG_REQUIRE`（ubuntu：zsh,bash,pty,pwsh,python,sqlite-native,built-renderer；macOS 同；Windows：pwsh,ps51,git-bash,python,sqlite-native,built-renderer）。每步 CI 皆綠。

**影響範圍。** 只動 `test/`、`vitest.config.ts`、`ci.yml`；無產品程式、無磁碟資料。跨平台：Windows manifest 起始會很長（53 檔），這正是要讓它可見。

**可能出錯。** 探測過窄時把真正的環境缺失當程式錯誤（紅得冤枉）→ 先以「只報告」跑一週收集。manifest 隨 runner 映像變化需要更新 → 這就是想要的訊號（映像改變了驗證面）。

**驗證。** 人為破壞：在 `src/core/marker-amend.ts` 頂層丟錯，確認 `marker-amend.test.ts` 由灰變紅；在 ubuntu leg 移除 zsh 安裝步驟，確認 reporter 失敗。

---

### F2. 測試不擁有時間：隱含時間預算 × 多行程共用機器 ＝「每次不同檔」

**機制。** 大量測試把正確性綁在牆鐘上：Testing Library 預設 1000 ms 的 `waitFor/findBy`、真實 `setTimeout` 睡眠、`Date.now()` 預算、每檔 15 s 的 test/hook timeout。被測程式本身又刻意延遲（`useAppCounts` 1000 ms 節流 `LIVE_INTERVAL_MS`、Dashboard `minIntervalMs: 1000`、搜尋 300 ms debounce、Settings 350 ms autosave、FirstRun 300 ms poll、`TimelineEventRail` 400 ms）。同時 `pool: 'forks'`、`maxWorkers: 4` 與 46 個 spawn 檔 + 24 個 PTY 檔（每個再生出 shell/python/pwsh 子行程）在同一台 3–4 vCPU runner 上。任何一次機器層級停頓都會讓「剛好在等」的那幾個檔越過預算——所以失敗的檔每次不同、單獨跑都過。

**實例。**
1. main run 42787801521（Windows）：同一個 run 內 `bundle-export`、`cast-index`、`events`、`http-body-search`、`terminal-session-rotation` 五檔共 32 例失敗，訊息是 8×`Hook timed out in 15000ms`、8×`Test timed out in 15000ms`、`spawnSync python.exe ETIMEDOUT`、以及 `expected 11524 to be less than 5000`。run 42780889976 同型：8 檔、`spawnSync bash ETIMEDOUT`、一個 60 s 逾時。這不是 8 個獨立 bug，是一次全機停頓。
2. `d9d7cbd2`：Dashboard 恢復判定的 `findBy` 預設 1 s 等待「在節流的一秒讀取剛開始時就結束」——被測程式刻意延遲 1 s，測試等 1 s。修法：拉長等待。
3. `ca87f903`：`first-run-record-terminal` 等「預設 1 s」等一張經過多次 bridge 呼叫才出現的卡片，在兩台 runner 輸掉；修法：拉長等待。closeout §4 記錄 `record-terminal-adapter-selection` 同型且「根因未查」。
4. 比例牆鐘測試：`6f6599d3`（給 11 倍容忍 + 5 次重試）→ `57edf4cf`（改成 `REDLOG_PERF=1` 才跑）→ 仍有 `test/export-main-thread-stall.test.ts:67` `longestStall < scanMs * 0.3` 在 main run 43159691673 的 macOS 上失敗（42.2 vs 39.99）。`chain-sampling.test.ts:88` `dt < 500`（列在 ci.yml 的「不同檔」名單中）。
5. 處理全是放大預算：`vitest.config.ts` 把 testTimeout 與 hookTimeout 都提到 15 s；`test/` 有 37 處單點 `{ timeout: 1500–5000 }`（14 檔）；51 處真實睡眠（`setTimeout(r, 20/50/100/300/400/600/5000)`）。
6. 模組單例跨測試存活：`src/renderer/src/lib/` 有 `issues`、`captureHealthStore`、`useAppCounts`、`exportScope`、`replayStore`、`time`、`verifyResultCache`、`pendingSaves`、`terminalRunner` 等模組層級可變狀態；只有 `issues` 與 `captureHealthStore` 匯出 `_reset*`，且只有 8 個測試檔呼叫任何 reset。檔與檔之間有 fork 隔離，但**同檔測試之間**沒有——`useAppCounts` 的 `queued` 旗標、`pacer`、`generation` 依賴「上一個測試真的 unmount 完」。

**「每次不同檔」的假設與確認方法。** 假設：不是順序相依（`isolate` 預設開，fork 之間不共享模組），而是 (a) 共用機器的停頓（Windows 上很可能是 Defender 即時掃描新寫入的暫存檔與新 spawn 的 python.exe/bash.exe，或磁碟 I/O；macOS 3 vCPU runner 上是 CPU 超額）× (b) 檔內的隱含時間預算。確認：(1) 已上傳的 `unit-junit.xml` 有每個案例的時間戳——檢查同一 run 的失敗是否落在同一個 10–20 秒窗口（上述兩個 run 依訊息判斷是）；(2) 在 CI 的 Vitest 步驟旁跑一個 1 Hz 取樣器（Windows `Get-Counter '\Processor(_Total)\% Processor Time','\PhysicalDisk(_Total)\Avg. Disk sec/Transfer'`，POSIX `vmstat 1`）寫成 artifact，失敗時對時間軸；(3) 對照實驗：Windows leg 加 `Add-MpPreference -ExclusionPath $env:GITHUB_WORKSPACE,$env:RUNNER_TEMP` 跑 20 次，看失敗率是否從約 1/10 降到 0；(4) 本機以 `--maxWorkers=8` 加 `stress-ng --cpu N` 重現。UNCONFIRMED 直到 (1)(2) 完成。

**結構性修正（不是加大 timeout）。**
- **時間由 harness 擁有**：`test/helpers/clock.ts` 提供 `withClock()`（`vi.useFakeTimers({ toFake: [...], shouldAdvanceTime: false })` + `advance(ms)` 會同時沖 microtask 與 React `act`）。元件測試預設在 setup 開啟 fake timers；需要真時間的檔顯式 `realTime('理由')`。
- **規則**：`test/` 禁止 `new Promise(r => setTimeout(r, N>0))` 與 `waitFor/findBy` 的 `{ timeout }` 參數（現有 37+51 處進 ratchet 基線，只降不升）；牆鐘比較只能出現在 `perf` project。
- **分 project**（Vitest `projects`）：`unit`（純函式 + jsdom，平行）、`proc`（spawn/PTY/python/pwsh/listen，`maxWorkers: 2`，自己的 timeout，失敗時附取樣器 log）、`perf`（`REDLOG_PERF`，nightly，只與同一台機器的基線比）。把「會生子行程的測試」和「對時間敏感的元件測試」拆到不同行程池，就切斷了「停頓 × 預算」的乘積。
- **單例重置**：每個有模組層級可變狀態的 renderer lib 匯出 `_resetForTest()` 並在模組內 `registerTestReset(fn)`；`test/setup.ts` 的 `afterEach` 呼叫全部。一個結構檢查（AST，放在 `verify:architecture` 旁）：`src/renderer/src/lib/**` 中模組層級 `let` 或 `new Map/Set` 的檔必須呼叫 `registerTestReset`。
- **HOME 沙箱**：`test/setup.ts` 目前只隔離 `REDLOG_KEYS_DIR`；改為在任何匯入前把 `HOME/USERPROFILE` 指到每 worker 的暫存目錄，並在 `afterAll` 斷言真實 `~/.redlog` 的 mtime 未變。現在是靠每個檔自己 `vi.mock('os')` 或設 `FAKE_HOME`（至少 7 檔各自實作），漏一個就寫到操作者的真實目錄（未發現實例，UNCONFIRMED）。

**遷移。** (1) 加取樣器 artifact 與 junit 時間戳分析（只觀察）；(2) 建 `clock.ts` 與 `projects` 分割，`proc` 檔先整批搬過去（不改內容）；(3) 加 ratchet 基線；(4) 從 closeout 列的兩個 flaky 檔與 d9d7cbd2/ca87f903 兩檔開始改用 `withClock()`，移除其 `timeout:`；(5) 單例 reset 與 HOME 沙箱；(6) 15 s 全域 timeout 降回 5 s（`unit` project），`proc` 保留較大值。

**影響範圍。** `test/`、`vitest.config.ts`、`src/renderer/src/lib/*` 加入無行為影響的 reset 匯出（`verify:architecture` 已允許 `_` 前綴為測試縫）。

**可能出錯。** fake timers 與 `useSyncExternalStore`/`queueMicrotask` 的交互需要 harness 正確沖 microtask，否則測試會卡住 → harness 自己要有測試（fake 時鐘下 1000 ms 節流讀取恰好在 `advance(1000)` 後發生）。

**驗證。** 以 `--repeat 50` 跑被改寫的檔、在 `stress-ng` 下跑整個 `unit` project 零失敗；CI 一週失敗率對比（目前 main 近 4 天 6 次紅，至少 4 次是此型）。

---

### F3. 測試沒有被證明「會紅」：沒有獨立 oracle、測試碼不受型別檢查、沒有 red-before-green

**機制。** 一個測試的價值是「實作錯了它會紅」，但流程裡沒有任何一步檢查這件事。測試常與實作同一個 commit 寫成、以實作當下的行為為答案、在 mock 上斷言、或掃描原始碼文字；`test/` 與 `e2e/` 不在 typecheck 範圍，讀不存在的欄位不會被發現。docs/TESTING.md「Races a test cannot reproduce」寫了「confirm the test fails against the old code before trusting it」——是規範，不是 gate。

**實例。**
1. `test/escape-layers.test.tsx:96-100`：「Escape 從欄位送出時 Timeline 根本收不到，所以這個案例在**兩層都移除**時也通過」——在同一 commit（9aa28ed3）裡被發現並修正，靠的是人工懷疑。
2. `test/app-counts-config-saved.test.tsx:53-63`「stops listening once unmounted」：unmount 後派送 `redlog:config-saved`，等 20 ms，斷言 `isConfigured` 呼叫數不變。但 `useAppCounts` 的 detach 同時把 `pacer` 設為 null（`useAppCounts.ts:150`），`pump()` 走 `pacer?.request` → 即使 `removeEventListener` 被刪掉，也不會產生讀取。依程式推理此測試不可能失敗（未實跑 mutation，標為 reasoned）。
3. `test/powershell-spool-needs-project.test.ts`：以 `indexOf('"engagementId"') < indexOf('New-Item')` 判斷「沒有專案就不建 spool 目錄」——前提（pwsh 不在 runner 上）是錯的，真實行為測試可在三平台跑。
4. 原始碼文字釘選：`test/timeline-track-wiring.test.ts` 12 處、`timeline-flush` 8、`update-status` 8、`settings-ia` 7……約 30 檔 70+ 處 `expect(SRC).toMatch(/const baseTrackW = scrollerW > 0 \? .../)`。重構必紅（假陽性），行為在別處退化不紅（假陰性）；檔頭自己寫「These structural guards do not prove rendered layout」。
5. 型別：以暫存 tsconfig 把 `test/**`、`e2e/**` 納入 `tsconfig.check.json` 的設定，`tsc` 回報 **279 個錯誤（test 215、e2e 64；src 0）**。e2e 的 `page.evaluate(() => window.redlog...)` 中 `window.redlog` 多處被推成 `{}`（`evidence-views.spec.ts:606`、`official-agent-capture.spec.ts:106` 等 TS2339），代表 e2e 讀 IPC 回傳欄位完全沒有型別約束；`capture-health.test.ts` 14 處 fixture 缺 `builtin` 欄位（TS2741）——fixture 與真實型別已漂移。`test/typecheck-guard.test.ts` 只檢查 gate「有接線」，且只認 `src/**`。
6. 抽樣估計（偏向可疑檔，非隨機）：讀了約 75 個測試（escape-layers、confirm-dialog、chain-sampling、hooks-manager、project-manager、timeline-pages、timeline-shared-filter、revalidate-on-focus、app-counts-config-saved、clipboard-monitor、query-tool-pairing、powershell-*、timeline-track-wiring/flush、scroll-centering、csp-production、typecheck-guard）。約 60 個（80%）斷言的是實作可以違反、且答案獨立於實作的性質（例：`hooks-manager` 的 rc 編輯「自身互逆」、`query-tool-pairing` 的查詢次數不隨 key 數增加）；約 6 個是合理的 lint/接線檢查（應搬到 lint）；**約 9–10 個（12–13%）在行為退化時不會紅或在 CI 從未執行**（上面 1–4 項 + csp 3 例 + 牆鐘 1 例）。外推到 6853 例需打折，但「每 8 個有 1 個不能作證」這個量級足以解釋「綠但壞」。

**已有、應擴大的 oracle。** `timeline-incremental-equivalence`、`timeline-window-equivalence`（增量 vs 從零重建，seeded RNG）、`activity-query-incremental`（增量 vs 選取驅動路徑）、`export-events-equivalence`、`ingest-golden`、`secret-patterns-golden`、`fixtures/shell-session-golden.json`、`command-class-golden.json`、`bash/zsh-transparency` 的「baselines ran」自檢。這是 repo 裡最可信的測試形狀。

**結構性修正。**
- **typecheck 涵蓋 test/ 與 e2e/**：`tsconfig.check.json` 的 include 加入兩者（或 `tsconfig.test.json` 由 `npm run typecheck` 一併跑）；`e2e/` 宣告 `window.redlog: RedLogBridge`（從 preload 型別匯出），讓 `page.evaluate` 內的 IPC 讀取受檢。先修 279 個錯誤。
- **red-before-green job（PR）**：`git diff --name-only base...HEAD`，把非 `test/`/`e2e/` 的變更還原到 merge base，只跑本 PR 新增或修改的測試，**要求至少一個失敗**；若 PR 只改測試或只做重構，以 PR label `no-red-proof: <理由>` 豁免（理由進 PR body，可稽核）。成本：一次額外的局部 Vitest，約 1–3 分鐘。這把 TESTING.md 的規範變成機制，也直接抓到「Escape 兩層都拿掉仍通過」這一類。
- **Mutation testing（nightly，非 gate→ratchet）**：Stryker（vitest runner）只對少數核心模組：`src/core/redaction.ts`／secret patterns、`chain-anchor`、`hooks-manager` rc 編輯、`query/contract`、`renderer/src/lib/timelineIncremental`、`db/activity-queries`、`renderer/src/lib/useAppCounts`。每模組記錄 mutation score，ratchet 只升不降；存活的 mutant 清單作為 issue 來源。
- **原始碼掃描分流**：可泛化的規則（`scroll-centering`、`raw-button-ratchet`、`tailwind-classes`、`mutation-guard`、`danger-not-on-numbers`）搬成 lint 規則（F6）；釘實作文字的（`timeline-track-wiring`、`timeline-flush` 等）逐一換成行為測試（jsdom 量測或 e2e geometry），換不掉的刪除。用一個 ratchet 計數「讀 src 文字並 `expect(SRC…)` 的檔數」，只降不升。

**遷移。** (1) 新增 `typecheck:tests` 腳本，CI 先以 `continue-on-error` 跑並上傳錯誤數；(2) 修 279 個錯誤（多為 fixture 補欄位、e2e bridge 型別），合併後把它併入 gate 1；(3) red-before-green 先以報告模式（留言結果）跑兩週，再設為必過；(4) Stryker nightly；(5) 原始碼掃描分流與 ratchet。

**影響範圍。** 只有測試與 CI；無產品行為。red-before-green 對「改測試修 flake」的 PR 需要 label——這是有意的摩擦。

**可能出錯。** 還原 src 後測試因匯入不存在的新匯出而「失敗」——這不算紅的證據 → job 要求失敗是 assertion error（Vitest 的 `AssertionError`/`TestingLibraryElementError`），不是 import/型別錯。

**驗證。** 對 9aa28ed3 之前的 escape-layers 版本、對 app-counts 那個 unmount 測試跑 job：應報告「未證明會紅」。

---

### F4. 只有真實執行能證明的事，沒有可重複的家

**機制。** 「release 版實際行為」「負載下主行程不卡」「整個 app 走一遍」這三類，目前靠 scratch 目錄裡的腳本或手動執行；CI 裡的對應物要嘛是 smoke 變體（不是發佈的那個二進位）、要嘛只在 PR 路徑命中時跑、要嘛 opt-in 從未排程。結果是最貴的缺陷（42.9 秒主行程停頓、5 MB loot scan 180 秒無回應、HAR 匯出逾時）都是人工負載走查才找到，修好之後也沒有東西防止回歸。

**實例。**
1. `scratchpad/wt-run/e2e/zz-qa-abuse.spec.ts`（1667 行，`monitorEventLoopDelay` 取樣、`PerformanceObserver` longtask、IPC RTT p95、明確門檻）、`zz-qa-functional.spec.ts`（1479 行，107 項）、`zz-audit.spec.ts`（273 行，三種尺寸走所有頁面）——閉幕文件 §2 的「修正前 71/18/17 → 修正後 79/13/14」與負載表全來自它們，但它們不在 repo。報告 `qa-abuse-after2/report.json` 的 `meta.thresholds` 已寫好預算。
2. 效能套件 `timeline-query-perf`（9）、`http-flow-query-perf`（2）、`export-workflow-perf`、`zsh-latency` 在 CI 三平台都略過；任何 workflow 都沒有 `REDLOG_PERF` 或 `schedule:`。closeout §4 自己寫「較輕微的效能退化不會被 CI 攔下」。
3. release 變體：`release.yml` 打包後只做 `verify:package-resources`（靜態 fuse 讀回、資源存在），從不啟動。CSP 擋 `new Function`、`--inspect`/`--remote-debugging-port` 無監聽，是 closeout §2 在本機未簽章 mac app 上手動做的。install-smoke 跑的是 smoke 變體，而 smoke 變體**刻意**打開 `enableNodeCliInspectArguments` fuse 並接受 `REDLOG_E2E`——它恰好無法驗證 release 的拒絕行為。
4. macOS：沒有任何安裝包 smoke workflow；`docs/RELEASE_CHECKLIST.md` 的 macOS 項全靠人。
5. install-smoke 只在 `pull_request` + 路徑清單命中時跑（清單內只列了 6 個 renderer 元件）；push 到 main 不跑；`verify-release-ci.mjs` 只要求 `ci.yml` 綠，所以一個 tag 可以在 install-smoke 從未對該 sha 執行的情況下發佈。
6. 已有的好零件：`launchWithTempHome` 的 HOME 隔離、`capture-soak.spec.ts` 的成長預算（`REDLOG_SOAK_MAIN_GROWTH_MIB`）、`verify-smoke-report` 的嚴格 not-exercised 檢查、Windows smoke 的「乾淨機器前置條件」。

**結構性修正。**
- **入庫**：三支走查搬進 `e2e/qa/`（Playwright project `qa`，`testIgnore` 於預設 project），共用 `e2e/helpers.ts`；把「腳本找不到元素、無法判定」的那半數失敗項（closeout §4）先修成穩定 locator，判定不明的項目明確標 `unclear` 而不是 pass。
- **觸發**：`qa.yml`：nightly（main）＋ PR label `run-qa`；Linux xvfb；結果 JSON 上傳，並與上一次 main 的結果 diff（新增 fail 才算紅）。
- **預算與失敗政策**（沿用走查已定的門檻，只把「fail」那一端當 gate，「warn」那一端只報告）：IPC p95 > 500 ms、event-loop max > 1000 ms、5 s 閒置 long-task 總和 > 1000 ms、頁面 settle > 5000 ms → 紅；介於 pass/fail 門檻之間 → 黃（報告、不擋）。效能套件以**同一 runner 類型的滾動中位數 × 2** 為上限，不用跨機器絕對值（TESTING.md 已說「別台機器的數字沒有意義」）。soak：nightly 跑 `REDLOG_SOAK_MINUTES=10`，保留現有成長預算。
- **release 變體 smoke（不需要 Playwright 就能做的部分）**：新 job 在三平台對**真正要發佈的**產物：(a) 已有的 fuse 讀回；(b) 以 `--inspect=9229 --remote-debugging-port=9222 --js-flags=...` 啟動，等 `~/.redlog/api-port` 出現，`/api/health` 200，並斷言 9229/9222 無監聽（`lsof`/`Get-NetTCPConnection`）；(c) `stat` 檢查 `~/.redlog` 與專案目錄的權限位元（POSIX 0700/0600）；(d) 斷言 release 與 smoke 兩個變體的 `app.asar` 中 renderer 檔案逐位元相同（只允許 `build-variant.json` 與 main bundle 中變體旗標不同）——如此 smoke 變體上用 Playwright 做的 CSP 檢查（`new Function`、inline script 被擋）就能代表 release。把這個 job 加進 `release.yml` 的 build 之後、release 之前，並在 main 上 nightly 跑。
- **macOS install smoke**：macos-latest 上 `electron-builder --mac dir`（未簽章）+ packaged-smoke spec（TCC 無關的部分）。
- **release gate**：`verify-release-ci.mjs` 擴充為要求 tag sha 上 `ci.yml` + `release-smoke`（新）綠；install-smoke 改成 nightly 對 main 也跑一次，使每個候選 sha 都有紀錄。
- **不在開發機彈視窗**（memory：不在本機跑 Electron e2e）：`qa`、`release-smoke` 都只在 CI；本機提供 `npm run qa:linux`（`docker run` + xvfb，掛載 repo 唯讀），不提供直接在 macOS 桌面跑的指令。

**遷移。** (1) 入庫走查，`qa` project 預設不跑；(2) `qa.yml` nightly 只報告；(3) 一週基線後啟用「新增 fail 為紅」；(4) release-smoke 先加在 tag 流程，再加 nightly；(5) release gate 擴充。

**影響範圍。** e2e 目錄與 workflows；走查使用的 `/api/events/seed` 等測試端點只存在於 `REDLOG_E2E` 啟動，release 不受影響。CI 時間：nightly 約 15–25 分鐘。

**可能出錯。** 走查 locator 對 UI 文案變更很脆 → 要求以 `data-testid` 為主，並讓 `verify:i18n` 也掃 `e2e/qa/`。負載預算在共用 runner 上的變異 → 只對「fail」端設 gate、以滾動中位數比較。

**驗證。** 在 nightly 中故意 revert 一個已修的負載缺陷（例：timeline append-aware 衍生）應使 `qa` 變紅。

---

### F5. 跨平台覆蓋取決於「runner 映像剛好有什麼」，不是宣告出來的

**機制。** 平台差異集中在 shell 語意（bash 3.2 vs 5.x、zsh 版本、Git Bash/MSYS 路徑）、路徑分隔符、換行與檔案語意（rename/ACL/權限）。目前的覆蓋是：本機 macOS（bash 3.2）、CI 三個映像各自帶的版本、Windows leg 只跑可攜子集。沒有任何地方宣告「bash adapter 必須在 3.2 與 5.x 上都過」，也沒有 Windows 語意的單元層 fixture，所以一個平台專屬缺陷只會在剛好有該版本的那台機器上、被剛好寫到那條路徑的新測試看到。

**實例。**
1. bash 5 幽靈 `command_start`（`68561a57`）：「Present on main; the tests that show it are new here」——main 上一直存在；Mac 只有 3.2，看不到；closeout §2 用「本機容器 bash 5.1」才驗證。`test/helpers/bash-trap-chain.ts` 的探測、`bash-hook-prompt-command.test.ts:213` 的 `bashMajor < 5` 略過，都是讓覆蓋隨版本**自動縮小**而不是失敗。docs/TESTING.md 寫「bash 3.2 on macOS」，但 CI macOS 映像的 bash 版本沒被印出也沒被固定（log 中 `bash-auto-capture` 在 macOS 跑滿 13 例、`bash-hook-prompt-command` 略過 3 例，兩者暗示的版本能力不同，UNCONFIRMED）。
2. Git Bash 反斜線路徑（同一 commit）：bash adapter 用 `${x%/*}` 取目錄，Windows 上 `BASH_SOURCE` 給 `D:\repo\hooks\...`；Windows leg 的 bash PTY 測試全略過，只有 `git-bash-direct-send` 5 例在跑。
3. `@electron/asar` 以平台分隔符查檔（`57edf4cf`，`scripts/build-variant.mjs:45`）；在 Windows unit leg 與 Windows install-smoke 才紅。
4. `#!` 行在 CRLF checkout 下破壞 `verify-fuses.mjs` 的匯入（`ca87f903`）；`.gitattributes` 只對 `*.sh/*.zsh/*.bash/*.py/*.svg` 強制 LF，`.mjs/.ts/.ps1/.json` 都隨 Windows checkout 變 CRLF。
5. Windows 失敗集中在子行程與 rename：`mitm-stop-gap`（`PermissionError` on spool rename，run 42767772877、42439286504）、`bundle-export` 的 python 驗證器、`5206ac01`（「retry across a Windows rename」）。
6. closeout §4 列「未驗證的環境：Windows PowerShell 與 Git Bash、WSL…」，但 CI Windows leg 其實每次都跑 PS 5.1/7 的真 hook 與 Git Bash direct-send——文件與 CI 覆蓋互相不知道對方，因為沒有一份可機器讀的覆蓋矩陣。

**結構性修正。**
- **宣告 shell 矩陣**：`shell-matrix` job（Linux）用官方 Docker 映像 `bash:3.2`、`bash:4.4`、`bash:5.2` 與 zsh 5.8/5.9 執行 `proc` project 中標記 `requires('bash')`/`requires('zsh')` 的檔，`REDLOG_REQUIRE=bash` 使其不可略過；每個 job 印出版本。這樣 Linux 一台就覆蓋 macOS 的 3.2 語意（非 TCC 部分）。
- **Windows 真執行**：讓 `findShellTarget()` 認得 Git Bash（`C:\Program Files\Git\bin\bash.exe` + node-pty ConPTY），把 bash PTY 測試在 Windows leg 以 Git Bash 跑；Windows manifest（F1）中這些檔從「略過」移除。
- **平台語意的單元層 fixture**：路徑處理一律經過一個小模組（`toPlatformPath`、`asarEntry`），並以 `path.win32`/`path.posix` 兩種實作各跑一遍（不需要 Windows 機器）；CRLF：`.gitattributes` 改為 `* text=auto eol=lf`（`.bat/.cmd` 例外為 crlf），並在 Linux leg 加一個以 `core.autocrlf=true` checkout 的步驟只跑 `scripts/*.mjs` 的匯入測試。
- **覆蓋矩陣是資料**：`test/coverage-matrix.json`（行為 × 平台 × 層級 → 檔名）由 F1 的 reporter 依實際執行結果填「本次是否執行」，CI 上傳；closeout/RELEASE_CHECKLIST 引用這份 artifact，而不是手寫「未驗證」。
- **只能手動的**：真 IME（中文/日文輸入法組字）、macOS TCC 提示與狀態、簽章與公證、多螢幕/DPI、真實 Kali 桌面首次安裝秒錶、WSL 真機。清單放在 `docs/RELEASE-SMOKE-TEST.md`（已存在），每次結果記錄在 `docs/records/<date>/` 一份帶 run id/機器/版本的表，`verify:specs` 檢查 release 筆記引用了最近一份紀錄（不判定內容，只要求存在與日期新於上一個 tag）。

**遷移。** (1) 印出每個 leg 的 bash/zsh/pwsh 版本；(2) `.gitattributes` 正規化（一次性 renormalize commit）；(3) `shell-matrix` 只報告→必過；(4) Windows Git Bash PTY；(5) 覆蓋矩陣 artifact。

**影響範圍。** `hooks/` 不變；`test/helpers/zsh-pty.ts` 擴充；CI 增加一個 Linux job（約 5 分鐘）。`.gitattributes` 正規化會讓既有 Windows 工作樹出現大量換行差異，需在無他人未提交工作時進行（CLAUDE.md 分支節）。

**可能出錯。** ConPTY 與 POSIX PTY 的輸出切分不同，部分 transparency 斷言需要放寬為語意比較 → 這是真實差異，應該寫成 Windows 專屬預期，而不是略過。

**驗證。** 在 `shell-matrix` 上 revert `68561a57` 的 bash 段落：bash 5.2 job 應紅、3.2 job 應綠；revert 反斜線分支：Windows Git Bash job 應紅。

---

### F6. Gates 只看靜態一致性；缺 lint；比對 ref 的 gate 在 main 上空轉

**五道 gate 能／不能看到什麼。**

| gate | 看得到 | 看不到 |
|---|---|---|
| typecheck（`tsconfig.check.json`，只含 `src/**`、`optional-plugins`） | 未匯入的名稱、型別不符 | test/e2e 的任何錯誤（279 個）；hooks 的 shell/PS；執行期順序（TDZ） |
| verify:specs | spec 狀態、任務/計畫/驗證紀錄存在、CT 對照檔存在 | 那些測試是否真的跑、是否會紅（`verify-contract-coverage` 自己寫「this does not run tests」） |
| verify:architecture | 只被測試引用的匯出、死匯出 | 死測試（只測自己 mock 的檔）、被略過的測試 |
| verify:i18n | 測試斷言本分支刪掉的字串 | 文案漂移（字串改了但語意測試仍以舊 key 通過）；在 main 上比較是空的 |
| npm test | 行為（在跑到的範圍內） | 見 F1–F3 |

**缺的 gate（每項：本週會抓到什麼／假陽性成本／是否必須在分支上判斷）。**
1. **ESLint（type-aware）作第六道**。repo 沒有任何 ESLint 設定，卻有 22 處 `eslint-disable … react-hooks/exhaustive-deps`、3 處 `no-control-regex`、1 處 `@typescript-eslint/no-require-imports`——規則從未執行，註解是死的。建議規則：`react/no-unstable-nested-components`（CLAUDE.md 的 ExportMenu 三個巢狀元件）、`react-hooks/rules-of-hooks`+`exhaustive-deps`、`@typescript-eslint/no-floating-promises` 與 `no-misused-promises`（與 `mutation-guard` ratchet 同一類，但看得到所有 promise）、`no-use-before-define`（Timeline TDZ）、`@typescript-eslint/no-unused-vars`（`tsc --noUnusedLocals` 今天在 src 回報 69 處）、`vitest/expect-expect`、`vitest/no-disabled-tests`、`testing-library/no-wait-for-side-effects`、自訂規則：禁止測試中的真實睡眠與 `{ timeout }`（F2）、把 `scroll-centering`/`raw-button-ratchet`/`tailwind-classes` 搬成規則。本週會抓到：至少 exhaustive-deps 的實際違規數（UNCONFIRMED，未能離線安裝 typescript-eslint 量測）、巢狀元件型缺陷。假陽性：exhaustive-deps 中等 → 以「現有違規基線檔」上線（`eslint --max-warnings` + 基線），只擋新增。main 上即可判斷，但基線比較要對 merge base。
2. **typecheck 涵蓋 test/e2e**（F3）。本週：279 處 fixture/bridge 漂移。假陽性低。main 即可。
3. **略過 manifest**（F1）。本週：csp 3 例從未跑、39 檔 catch-all。假陽性：runner 映像變更時要更新 manifest（這是訊號）。main 即可。
4. **red-before-green**（F3）。本週：escape-layers 原始版本、app-counts unmount。假陽性：純重構/改測試 PR 需 label。**只能在分支上判斷**（main 上 base==HEAD，與 i18n 同理），所以它在 main 上必須報「not applicable」而不是「passed」。
5. **死測試偵測**：(a) 在所有 CI OS 上都略過且不在 opt-in 清單的檔（今天：`zsh-nc-upgrade.pty` 在 unit 層三平台皆略過）；(b) 一個 `it` 中所有 `expect` 的對象都是 `vi.fn()` 或本檔建立的常數；(c) 同一檔所有斷言都在 `readFileSync(src…)` 文字上。本週：(a) 1 檔、(c) 約 30 檔。假陽性：(b) 對「驗證呼叫契約」的合法測試會誤報 → 只報告、不擋。
6. **無上限處理器預算**：IPC handler 與 API route 的「單次工作量」沒有上限是本週多個缺陷的共同形狀（loot scan 180 s、單一 loot 事件無命中上限、第一次搜尋走訪全部參照）。gate 形式：`proc` project 中對每個 IPC/API 入口以「大輸入 fixture」呼叫一次並量 event-loop 最長停頓（`monitorEventLoopDelay`），超過 250 ms（同機器基線 × 2）即紅；入口清單由 `ipcMain.handle`/route 表自動列出，新入口沒有 fixture 即紅。本週會抓到：loot scan、單事件命中數。假陽性：共用 runner 抖動 → 以中位數多次取樣。nightly。
7. **i18n 文案漂移**：`verify:i18n` 只看「被刪的字串」。補一個「同一 key 的 en/zh-TW 值在本分支改變時，引用該 key 的測試必須也改動或宣告」——對使用者「minimal UI copy」決策的保護。必須在分支上判斷；main 上應報「trivial」。
8. **a11y 名稱**：jsdom 中對每個頁面根元件 render 後跑 `axe-core` 的 `button-name`、`label`、`aria-*` 規則子集；`test/button-names.test.ts` 已有雛形（原始碼掃描）→ 改成 DOM 檢查。假陽性低。main 即可。
9. **bundle 大小**：`out/renderer/assets` 總量與最大 chunk 的上限（基線 +10%）。本週無直接缺陷，但 `useLivePagedQuery` 等重構與 major 升級評估（electron-vite 6、plugin-react 6）會動到它。main 即可。

**ref 比較 gate 的通則**（CLAUDE.md 已記錄 i18n 的教訓）：任何比較 merge base 的 gate，在 base==HEAD 時必須輸出「trivial: nothing compared」並在 job summary 標示，不能輸出「passed」。`verify-i18n-assertions.mjs:89` 目前在 main 上印「passed: … 0 string(s)」——技術上正確、讀起來誤導。

---

## 分階段計畫（每一階段 CI 維持綠，且比前一階段更誠實）

**Stage 0 — 只觀察（1–2 天）。** 印出每 leg 的 bash/zsh/pwsh/python/mitmdump 版本；Vitest reporter 上傳每 OS 的略過清單；Vitest 步驟旁的 1 Hz 機器取樣器 artifact；`typecheck:tests` 以 continue-on-error 跑並上傳錯誤數；ref 比較 gate 在 trivial 時改印「trivial」。不改任何判定。

**Stage 1 — 讓沒跑的東西看得見並擋住（約 1 週）。** 略過 manifest 入庫、reporter 失敗於清單外略過；`npm run build` 移到 Vitest 之前，`csp-production` 從 manifest 移除；39 個 catch-all 換成窄探測 `requires('sqlite-native')`；`.gitattributes` 正規化；修 279 個型別錯誤並把 test/e2e 併入 gate 1。

**Stage 2 — 讓時間屬於測試（約 1–2 週）。** `clock.ts` harness；Vitest `projects` 拆 `unit`/`proc`/`perf`；真實睡眠與 `{ timeout }` 進 ratchet；從 closeout 列的兩個 flaky 檔與 d9d7cbd2/ca87f903 開始改寫；renderer 單例 `registerTestReset` + 結構檢查；HOME 沙箱；`unit` 的 testTimeout 降回 5 s。依 Stage 0 取樣器結果決定 Windows Defender 排除。

**Stage 3 — 證明測試會紅（約 1 週起，持續）。** red-before-green 先報告模式兩週再必過；ESLint 第六道以基線上線（只擋新增）；原始碼釘選測試分流並設 ratchet；Stryker nightly 對 6–7 個核心模組，mutation score ratchet。

**Stage 4 — 把真實執行入庫（約 2 週）。** `e2e/qa/` 三支走查入庫，`qa.yml` nightly + label；release-variant smoke（啟動旗標拒絕、埠、檔案權限、release/smoke renderer 逐位元相同）加入 `release.yml` 與 nightly；macOS `--mac dir` smoke；`verify-release-ci.mjs` 要求 release-smoke；install-smoke nightly 對 main 執行；效能套件 nightly 以同 runner 滾動中位數為上限；soak 10 分鐘 nightly。

**Stage 5 — 宣告跨平台矩陣（約 1–2 週）。** `shell-matrix`（bash 3.2/4.4/5.2、zsh 5.8/5.9 容器）；Windows Git Bash ConPTY PTY 測試；`path.win32/posix` 雙跑 fixture；覆蓋矩陣 artifact 取代手寫「未驗證環境」清單；手動項目（IME、TCC、簽章公證、多螢幕、WSL 真機、Kali 首裝秒錶）結果記錄格式與存在性檢查。

---

## 已檢查且健全（不必重做）

- 無 retry：Vitest 未設 `retry`、Playwright 未設 `retries`；flake 會以紅色出現，沒有被重試吞掉。
- `forbidOnly: !!process.env.CI`（playwright.config.ts）。
- e2e 一律透過 `launchWithTempHome` 隔離 HOME/USERPROFILE/CODEX_HOME，且處理 Windows `AppData\Roaming` 需預建的坑（`e2e/helpers.ts:45-51`）。
- `ci.yml` 的 `fetch-depth: 0` 與「fetch 不加 `--depth`」的處理正確；e2e 不再 `needs: unit`；main 上每個 merge 都有完整 run。
- `verify-i18n-assertions.mjs` 在缺 merge base 時於分支上失敗、只在完全無 origin/main 時略過（第 56–69 行），符合 CLAUDE.md 的通則。
- `verify:architecture` 的「只被測試引用即失敗」設計，以及 allowlist 只縮不增。
- 等價／golden 測試（`timeline-incremental-equivalence`、`timeline-window-equivalence`、`activity-query-incremental`、`export-events-equivalence`、`ingest-golden`、`secret-patterns-golden`、shell session golden）以從零重建或固定答案為 oracle，且多數用 seeded RNG——是 F3 要擴大的形狀。
- `bash/zsh-transparency.pty` 先斷言「baseline 真的跑了，否則以下比較皆空洞」（`bash-transparency.pty.test.ts:160`）——正確的自檢模式；`zsh-nc-upgrade.pty` 以實際 banner 判斷 nc 種類，避免「整檔略過報綠」。
- `hooks-manager` rc 編輯以「自身互逆、重複安裝冪等、多種 `$HOME` 拼法」測試——獨立 oracle。
- Windows install smoke 的乾淨機器前置條件、解除安裝保留操作者自己的 profile 行、`verify-smoke-report` 嚴格模式。
- `project-manager` 的排序測試在同毫秒建立時仍穩定（`unshift` + 穩定排序），不是 flake 來源（曾懷疑，已排除）。

## 刻意如此（附出處）

- e2e 只在 ubuntu：`ci.yml:127-139` 與 CLAUDE.md「e2e」節；以 install-smoke 與手動清單補其他平台。F4/F5 的建議是補 release/mac 層級，不是把 e2e 搬到三平台。
- smoke 變體開 inspect fuse、接受 `REDLOG_E2E`：`docs/releasing.md` Build variants；`test/build-variant.test.ts` 防止 release workflow 誤用。F4 只是指出它無法代表 release 的拒絕行為。
- 效能比例測試改為 `REDLOG_PERF=1`：`57edf4cf` 理由是共用 runner 的牆鐘雜訊；方向正確，缺的是排程（F4）。
- `verify:i18n` 在無 origin/main 時略過：避免 gate 因環境被關掉（腳本第 20–21 行註解）。
- `workers: 1`（Playwright）：主行程單例鎖與 6660 埠。
- install-smoke 路徑觸發：packaging 數分鐘＋PyPI 安裝，「不屬於每個 PR」（`windows-install-smoke.yml` 檔頭）。F4 建議補 nightly 而非改成每 PR。

## 未確認（UNCONFIRMED）與如何確認

- 「每次不同檔」的 Windows 成因是 Defender 掃描或磁碟 I/O：以 Stage 0 取樣器與 junit 時間戳對齊、加排除路徑做 20 次對照實驗確認。macOS 上的同型失敗（`first-run-record-terminal`、比例測試）是 CPU 超額：以 `stress-ng` 本機重現。
- `app-counts-config-saved` 的 unmount 測試不可能失敗：依程式推理（`pacer` 於 detach 時為 null）；以刪除 `removeEventListener('redlog:config-saved', …)` 後跑該檔確認（本審查唯讀未做）。
- 有測試寫到真實 `~/.redlog`：未發現實例；以 Stage 2 的 HOME 沙箱 + mtime 斷言確認。
- CI macOS 映像的 bash 版本與能否串 DEBUG trap：log 中 `bash-auto-capture` 13 例全跑、`bash-hook-prompt-command` 略過 3 例（需 ≥5.1），推測為 bash 5.0 或 Homebrew 版本；以 Stage 0 印版本確認。
- ESLint 今天會報多少：未能離線安裝 typescript-eslint；`tsc --noUnusedLocals` 的 69 處是下限。以一次 `npx eslint` 基線量測確認。
- 抽樣的 12–13% 不能作證比例：樣本偏向可疑檔，非隨機；以 Stryker 對 6–7 個模組的存活 mutant 比例取得無偏估計。
