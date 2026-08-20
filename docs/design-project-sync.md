# Design project ↔ repo sync

Mirror of `github.md` in the Claude Design project "RedLog 設計規範". That
project is where `UIUX-STANDARD.md` and the phase PR templates are authored;
this file records which repo files each design screen was drawn from, so a
change to a component tells you which screen went stale.

---

repo: guan4tou2/REDLOG
branch: main
path: src/renderer

## Last sync

date: 2026-08-20T02:19:20Z

### 2026-08-20 · §10 裁決後同步

- §10 新增兩條規則，把「為什麼」寫進規範本身，避免下次重新裁決一次：
  移除 hook 屬第一級（非第二級），以及暫停錄製的文案不得聲稱「不會擷取任何東西」。
- 1c 的第二級範例由「移除 Shell hook」換成「信任外掛發行者」——前者是可復原的，
  真正的風險（悄悄停止擷取）由常駐的〈需要注意 N〉指示器承接，而不是一次性的對話框文字。
- 兩條規則在 `main` 上都已成立：hook 移除走 `toastDeferred`，暫停文案已修正。

### Updated in this project
- 對照 main（v0.14.3 + 未發布 commit）確認設計 tokens 未變：`tailwind.config.js`、`lib/hud.ts` 逐字節相同。
- `styles/index.css` 已變動（新增殼層 `user-select: none`），規範的 index.css 建議片段已同步保留該段。
- 新增原生右鍵選單子系統（`src/main/context-menu.ts`），規範新增右鍵互動規則，並標記它與時間軸「右鍵落標記」的衝突。
- 產出 `docs/UIUX-STANDARD.md`（規範摘要 + 三期檢查表）與三張分期 PR 模板。

## Screen map

| 專案畫面 | 依據的 repo 檔案 |
|---|---|
| 1a 規範 · 色彩 tokens | `tailwind.config.js`, `src/renderer/src/lib/hud.ts`, `src/renderer/src/styles/index.css` |
| 1a 規範 · 泳道配色 | `src/renderer/src/components/Timeline.tsx`（LANES / LANE_COLORS）, `test/lane-colours.test.ts` |
| 1a 規範 · 快捷鍵表 | `src/renderer/src/App.tsx`, `src/renderer/src/components/Sidebar.tsx`, `src/renderer/src/lib/sidebarOrder.ts` |
| 1a 規範 · 術語與譯名 | `src/renderer/src/i18n/zh-TW.json` |
| 1b 儀表板 | `src/renderer/src/App.tsx`（DashboardView / CaptureHealthCard / StatCard）, `src/renderer/src/components/IPStatusCard.tsx` |
| 1b 時間軸 | `src/renderer/src/components/Timeline.tsx` |
| 1b 逐字稿 | `src/renderer/src/components/TranscriptView.tsx` |
| 1b 目標 | `src/renderer/src/components/TargetView.tsx` |
| 1b 範圍 | `src/renderer/src/components/ScopeStatus.tsx` |
| 1b 戰利品 | `src/renderer/src/components/LootPanel.tsx` |
| 1b 標記 | `src/renderer/src/components/FindingsView.tsx` |
| 1b 設定 | `src/renderer/src/components/Settings.tsx` |
| 1b 狀態列 | `src/renderer/src/components/StatusBar.tsx` |
| 1b 側欄／標題列 | `src/renderer/src/components/Sidebar.tsx`, `src/renderer/src/App.tsx` |
| 1b Project Picker | `src/renderer/src/components/ProjectPicker.tsx` |
| 1b / 1c HUD Overlay | `src/renderer/src/OverlayApp.tsx`, `src/renderer/src/lib/hud.ts` |
| 1c 全部改良畫面 | 以上各檔為基準，套用 1a 規範 |
