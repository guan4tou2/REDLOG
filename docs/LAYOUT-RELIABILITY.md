# Layout Reliability

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
