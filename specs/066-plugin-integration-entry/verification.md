# Verification: 官方整合入口、雙向定位與擷取健康(B 批次)

**Date**: 2026-11-05。Feature 保持 **Draft**;這是 B 批次(renderer)的實作與驗證 checkpoint,不是整份 Spec 066 完成。C(安裝邊界)尚未開始,完成前不逐項轉 Verified。

## 候選與成品

- 資料合併:`mergeOfficialCatalog` 以 `pluginId` 把 `officialAgents()` 目錄併入 `plugins:list`;未安裝者得到 `notLoaded` 的 stub 列,信任／效果軸為「不適用」,不是「停用」。`plugins:list` 欄位未動(FR-006)。
- 插件頁成為安裝／更新／移除／恢復的唯一入口;`AgentsPanel` 移除 `mutate` 與四種按鈕,改為 `agent-manage-<kind>` 跳轉(依狀態標示「到插件頁安裝／更新／啟用／管理」)。
- 雙向定位:`Settings` 持有一次性 focus 意圖;`onOpenIntegration(pluginId)` → 插件頁選取該列(含未安裝),`onOpenCaptureSources(agentKind)` → 擷取來源列 `scrollIntoView`。跳轉不寫設定、不開確認框。
- 專案軸 `officialProjectLevel` 與健康軸 `officialHealth` 分開;健康來自 `useCaptureHealthState` 共用快照,讀取失敗 → 「狀態未知」。

## RED

- 先寫 `plugin-integration-entry.test.ts`(import 缺失,整檔 RED)再實作 View Model;12 例綠。
- **setEnabled 對官方整合被主行程拒絕**:最初沿用一般插件的啟用／停用鈕,e2e(`capture-settings-interaction` 的 disabled→恢復流程)抓到——`plugins:setEnabled` 對官方整合 throw「Manage official AI integrations in capture sources」,恢復的稽核路徑是 `installOfficialAgent`(`mutateOfficialAgent` 內的 disabled→re-enable)。單元測試的 mock 看不到這點。修正:官方整合不顯示啟用／停用鈕(`trust.canToggle`),已安裝但停用時顯示「恢復整合」(走 install)。
- `plugins-panel-truth` 的「官方整合隱藏」斷言是舊契約,依「改契約須同步改 spec」改成「每個官方整合恰好一列,含未安裝」。

## GREEN

- Gates:`typecheck`、`verify:specs`、`verify:architecture`、`verify:i18n` 全綠。
- 新／改單元:`plugin-integration-entry`(12)、`plugin-integration-panel`(10)、`plugin-view-model`、`plugin-explore`、`plugins-panel-truth`、`plugin-contribution-report`、`agent-sources-panel`、`capture-source-rows` 全綠。
- `npm run build` 通過。
- Electron e2e(macOS arm64 原生,需在 sandbox 外執行):`official-agent-capture`(claude-code／codex／session 隱私)、`capture-settings-interaction`(含「到插件頁恢復→跳回擷取來源且 config 不變」)、`plugin-explore`、`claude-code-producer`、`official-agent-installation` — 12 passed / 2 skipped(需外部 Claude binary 者)。

## 刻意不做

- 未安裝整合不提供「啟用／停用」;衝突／錯誤只給訊息與「開啟資料夾」,不做自動修復(C)。
- 沒有新增 IPC,健康軸不另造第二套判定。

## 尚未驗證

- Windows 原生布局與安裝包。
- 20 個 pty／shell 檔在本機環境本來就紅(見 Unit),CI 的 Linux 結果才是這些檔案的準據。

## Unit

完整 suite(sandbox 外):5400 passed / 126 failed,分布在 20 個 pty／shell 檔(zsh-*、bash-*、command-class、external-session、relay-* 等)。同一批檔案在乾淨 HEAD worktree 同樣失敗(抽樣 5 檔:18 failed),與本批無關,屬本機環境。sandbox 內另有 `listen EPERM`／`mktemp` 造成的更多失敗,不代表程式問題。

唯一與本批有關的失敗是 `ui-copy`:`plugins.projectAxis.na` 與 `plugins.healthAxis.na` 我寫成同一句,違反「同句不得兩個 key」;改成各自說清楚後綠。
