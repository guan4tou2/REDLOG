# Layout Reliability

> **狀態**：current  
> **範圍**：對話框、表格與長文字的排版契約（下方基準 commit 是當次修正的基準）  
> **最後核對**：本次整理未重新核對（not re-verified in this pass）

本輪是排版可靠性修正，以 `main` 的 `d2917021` 為基準。分支：`codex/layout-reliability`。
不包含 Spec 064 的 Activity、Content Viewer、導覽整併、Settings 重構或換色。

## 行為與邊界

| 元件 | 修正 | 必須保留 |
| --- | --- | --- |
| ConfirmDialog | 高度不超過視窗；標題、警告與確認輸入可捲動；底部按鈕固定 | 確認條件、取消、Escape、焦點限制 |
| FilterBar | 條件標籤換行、長值截斷；完整值保留在 title 與可及名稱；展開區限制高度並可捲動 | 查詢條件、時間輸入、清除個別條件 |
| HTTP History | 依實際容器 CSS 寬度，低於 960px 暫用上下詳情；空間恢復時還原偏好 | 選取 Flow、Request/Response、Reader 捲動、獨立的寬度／高度偏好 |
| Bookmarks | 低於 720px 採列表／詳情切換；提供返回 | 搜尋、選取、列表位置、尚未儲存的編輯；隱藏詳情不卸載表單 |
| Screenshots | CSS Grid 依容器自動決定欄數；240px 基準，小容器可縮為單欄 | 預覽、預覽內切換及來源檔案操作 |

HTTP 與 Bookmarks 共用小型 `useContainerWidth` hook，使用 `clientWidth` 與 ResizeObserver，
不以螢幕寬度推算可用空間。截圖使用原生 Grid，不新增 JS 量測。
自動布局不寫入使用者布局或面板大小設定，不修改事件、擷取、查詢、匯出或證據語意。

## 集中驗收

`e2e/layout-reliability.spec.ts` 使用一個隔離 App、一個合成專案。
一次依序檢查以下組合，不為每個尺寸另開 App，也不加入自動重試：

- 原生視窗：800×600、1280×800、1600×1000、1920×1080。
- Electron zoom：100%、150%、200%；App UI scale 使用預設值。
- 語言：英文、繁體中文。
- 每個元件 24 組，五元件共 120 組；每組保存實際 Electron 截圖。

800×600、200% 是操作可達性壓力測試；允許區域捲動，不要求呈現寬視窗的資訊量。
截圖透過 Electron `capturePage()` 保存，避免高縮放時瀏覽器截圖裁切影響判讀。
尺寸判斷使用 CSS pixels；捲動位置檢查允許 Chromium 的次像素誤差。

測試資料與操作：

- 長專案名及刪除後果確認；檢查固定操作列、警告可捲動、鍵盤焦點與輸入確認條件。最後取消，不刪除專案。
- 同時選取長 Target、來源與時間；展開後時間欄位仍可捲到，縮放不產生水平溢出。
- 81 個 HTTP Flow；搜尋、選取 Response 後切換尺寸，驗證搜尋文字與 Reader 捲動保留；回到寬布局還原 460px 側欄，180px 下方面板偏好不被覆寫。
- 35 個 Bookmark；編輯未儲存備註，返回後保留搜尋與列表位置，再開同一筆仍保留草稿。更新按鈕在各尺寸可捲到。
- 8 張合成圖片；檢查容器欄數、原檔操作可達，並驗證預覽在寬／窄切換後保留圖片且能關閉。

## 驗證記錄（2026-10-27，macOS arm64）

- `npm run typecheck`：通過。
- `npm run verify:specs`、`npm run verify:architecture`、`npm run verify:i18n`：通過。
- 七個相關測試檔共 54 項通過：Bookmarks、ConfirmDialog、FilterBar、HTTP 自動載入／詳情、面板大小及 UI copy。
- 推送前完整 `npm test`：4,341 項通過、28 項跳過；截斷文字檢查要求提示直接附在文字上，已修正，未增加例外。
- `npm run build`：通過。
- 集中 Electron 驗收：1 個工作流程通過（26.5 秒），內含 120 組檢查；結果見本分支的 `test-results/layout-reliability-*/matrix.json` 與同目錄 PNG。
- 已人工檢視五元件的尺寸／語言截圖總覽，並放大檢查窄視窗高縮放畫面。檢視時發現展開篩選面板遮住工作區，已修正為有界捲動並增補實際可達性斷言。

這是 macOS 原始碼建置的實際 Electron 驗收，不等同 Windows／Linux 原生或安裝包驗收；
也不代表 Spec 064 全部完成。本輪不重跑或變更擷取及匯出整套驗收。

## Read-state recovery follow-up

獨立後續分支 `codex/layout-state-recovery` 補載入／空白／讀取失敗的操作驗收。
Bookmarks 原本將初次讀取顯示成空資料，且拒絕未處理；現保留原資料、明確顯示錯誤並提供 Retry，重試成功清除錯誤。技術錯誤單行截斷但可查看完整值，不讓長路徑擠走操作。
HTTP 和 Screenshots 沿用共同載入元件；載入狀態有可讀名稱。

`e2e/layout-read-states.spec.ts` 在單一隔離程序故意延遲／拒絕讀取，避免污染真實擷取測試。
英文與繁中均檢查三頁載入不顯示空資料、空狀態、錯誤後重試，以及 1280×800/100%、800×600/200% 的操作可達性；另檢查 FilterBar 列表載入失敗後的重試。故障由 main-process IPC handler 注入，透過真實 preload 呼叫到 renderer，不使用 renderer 假錯誤。

最終狀態 journey 已通過（7.3秒）；發現截圖載入只有無文字 spinner，已統一使用共用載入名稱。截圖保存於 `test-results/layout-read-states-*/`。這不是擷取 producer 或原生系統權限驗收。

後續推送前五道檢查全部通過，完整 unit 為 4,342 passed / 28 skipped（134.94s）；production build 通過。

## Read-state matrix across views（#558 第四項）

第二個 journey 補其餘各 view 的「空／載入／失敗＋重試」矩陣，同一單一隔離程序、同一 IPC 注入模式，英文與繁中各跑一輪：

| view | 通道 | pending | empty | failed |
| --- | --- | --- | --- | --- |
| dashboard | `config:get` | `dashboard-loading` 骨架 | （專案無資料＝first-run 畫面，另由 first-run 驗收覆蓋） | （各讀取 `.catch()` 吞掉，無整體錯誤畫面） |
| targets | `events:aggregateTargets` | （設計上不閃空狀態：pending 時空狀態與錯誤都不出現） | `targets.empty` | `targets-load-error` |
| loot | `events:queryPage`(loot) | spinner | `loot.empty` | `loot-load-error` |
| timeline | `events:queryPage` | spinner（common.loading） | `timeline-empty-filtered`（預設帶 active conditions；`timeline.noEvents` 是無條件分支） | `timeline-load-failed` |
| transcript | `events:queryPage` | `transcript.loading` 文本 | `transcript.empty` | `transcript-load-error` |
| scope | `scope:getObservationCount`（五通道 `Promise.all` 之一） | spinner | `scope.observationsTitle` 標題（讀完才渲染） | `scope.loadFailed`（無 testid，以 role=alert＋retry 定位） |

「部分」狀態兩個真實案例：targets 主讀取成功而 `config:get` 失敗 → `targets-scope-failed`（in-scope 未知，出自己的重試）；dashboard 在有資料的專案上 scope 計數失敗 → issue store 的 `dashboard-issue-scope`（`issues.scopeUnknown`），並透過該列自己的「重新檢查」修復按鈕走完復原，unknown 標題消失、轉為未設定範圍的 pending 狀態。search 的部分讀取（index／types／casts 失敗與 partial warning）已由 `e2e/ui-closeout.spec.ts` 覆蓋，不在本檔重複。

**terminal 不進矩陣**：shell 立即建立，`terminal:list` 讀取失敗只是多開一個 tab，view 自身沒有空／載入／錯誤狀態可言；若未來出現清單語意再補。

實作上的三個釘子：live admission 繞過 stub 通道（列經 `events:matchIds` 直接進 timeline 的 map），故 timeline 腳位起 `matchIds` 一併 stub 為 `[]` 到旅程結束；空／失敗分辨的關鍵是 pending release 走 resolver 佇列（一次 release 所有掛上讀取，transcript 分桶與 scope 五通道都是 `Promise.all`）；每個 pending 腳位結束時把該通道還原成 plain 值，否則同通道的下一輪 retry 會撞上還掛著的 `Promise.all` 成員。

2026-11-04 macOS arm64 驗證：`npx playwright test e2e/layout-read-states.spec.ts` 2 passed（12.2秒）。

## Linux CI closeout

PR #445 首次 Linux E2E 發現日期時間原生輸入欄位在窄容器仍超寬，以及舊 Target 清除測試依賴 chip 文字外層結構。
日期欄位與時間預設改為換行並限制欄寬；清除測試直接使用既有可及名稱，維持清除行為驗證。
矩陣失敗現在回報實際容器／捲動寬度與具體尺寸、語言、縮放，避免只有布林逾時。
本機集中版面與 Target 跳轉／清除共5項 Electron 測試通過（35.4秒）。
推送前五道檢查再次通過，unit 4,341 passed / 28 skipped（122.08秒）。失敗截圖也改用 Electron 原生擷取，避免高縮放失敗畫面被瀏覽器截圖裁切。

同步至狀態恢復分支後，兩段文件均保留；再次依序通過五道檢查，4,342 passed / 28 skipped（124.24秒），未略過或放寬測試。
