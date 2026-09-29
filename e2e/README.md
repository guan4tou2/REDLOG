# RedLog tests

## 選擇入口

| 驗證範圍 | 入口 | 環境 |
|---|---|---|
| Core、資料庫、React 行為 | `npm test` | Node；自動重建 SQLite 的 Node ABI |
| Electron 操作與跨層整合 | `npm run build` 後 `npm run e2e` | 桌面環境；自動重建 SQLite 的 Electron ABI |
| 指定操作流程 | `npm run e2e -- e2e/project-flow.spec.ts` | 同上 |
| 互動除錯 | `npm run e2e:ui` | Playwright UI 與 Electron 視窗 |
| 規格／架構／包裝資源 | `npm run verify:specs`、`npm run verify:architecture`、`npm run verify:package-resources` | 各入口的參數與失敗訊息為準 |

首次使用依 repository lockfile 安裝相依套件。不要平行跑 Vitest 與 Electron rebuild：兩者使用不同 SQLite ABI。一般 `out/main/index.js` 是開發建置，不是安裝包；E2E 不會自動 build。Electron 需要顯示伺服器，不是無視窗瀏覽器測試。

## 測試分工

- `project-flow.spec.ts`：隔離 HOME 下啟動、標題、專案、導航與設定保存；已吸收舊 `smoke.spec.ts` 的啟動檢查。
- `scope-entry.spec.ts`：真正 Create 表單與 exclude／唯讀 ID。
- `first-run.spec.ts`、`setup-command-review.spec.ts`、`progressive-disclosure.spec.ts`：首次設定與漸進揭露。
- `command-io.spec.ts`、`external-session.spec.ts`、`command-artifact-correlation.spec.ts`：指令、輸出、PTY 與檔案來源。
- `managed-http-capture.spec.ts`、`http-activity-view.spec.ts`、`http-body-search.spec.ts`：代理控制及 HTTP 查詢。
- `timeline-*.spec.ts`、`search-query-contract.spec.ts`、`transcript-view.spec.ts`：閱讀、查詢、幾何與分頁。
- `export-preview.spec.ts`、`event-causal-chain.spec.ts`：匯出預覽及證據關係。
- `hud-overlay.spec.ts`、`app-shell-layout.spec.ts`：HUD 互動、縮放、窄視窗與多語系。
- 其他 `*.spec.ts` 依功能命名；完整清單使用 `npx playwright test --list`，不在此維護易過期的測試數量。

`openTestProject()` 是透過 bridge 建立專案並 reload 的 fixture，**不能證明使用者從 Create 進入的首次引導正確**。新建／切換專案旅程應從實際 UI 操作；不可加 reload 來讓失敗通過。當前已知差異見 `docs/reviews/2026-09-28-uiux-settings-audit.md`。

## 額外環境測試（跳過不等於通過）

真實 HTTP／HTTPS 使用本機 origin、mitmdump、openssl；需預先安裝相依工具：

```sh
REDLOG_REAL_PROXY_TEST=1 npm run e2e -- e2e/http-verification.spec.ts
```

macOS 安裝包必須先從目前程式重新打包，不能拿舊 dist 當本次成果：

```sh
REDLOG_PACKAGED_APP="$PWD/dist/mac-arm64/RedLog.app/Contents/MacOS/RedLog" \
  npx playwright test e2e/packaged-session-smoke.spec.ts

REDLOG_REAL_PROXY_TEST=1 \
REDLOG_PACKAGED_APP="$PWD/dist/mac-arm64/RedLog.app/Contents/MacOS/RedLog" \
  npx playwright test e2e/http-verification.spec.ts e2e/app-shell-layout.spec.ts
```

上述封裝測試使用套件內的 runtime。套件路徑依實際架構調整。它們不代表已驗證下載、Gatekeeper、Windows installer 或 WSL 真機安裝。

## CI 與產物

`.github/workflows/ci.yml` 已執行 Linux／Windows unit、typecheck、spec／architecture gate、build，以及 Linux Xvfb Electron E2E。缺少額外環境的 opt-in 案例不會因此被驗證。

失敗產物在 `test-results/`、`e2e/screenshots/`，CI 會上傳。臨時稽核腳本留在系統暫存目錄；可重用案例才整合進正式 suite，不把日期版本腳本長期堆進 repository。截圖可能包含測試機資訊，公開前先檢查。

刪除依據是重複、失效契約或已被取代，不是檔案年齡。舊版發現但仍可重現的回歸風險保留；條件式平台／工具 skip 保留並說明前提。歷史 CHANGELOG 與稽核文件不改寫成新狀態。
