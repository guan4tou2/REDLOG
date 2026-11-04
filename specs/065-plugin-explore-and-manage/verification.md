# Verification: 統一探索與管理入口 — 插件列表與詳情(A 批次)

**Date**: 2026-11-04。Feature 保持 **Draft**;這是 A 批次(renderer 探索與詳情)的局部實作與驗證 checkpoint,不是整份 Spec 065 完成。B/C 批次依裁決明確排除,完成前不逐項轉 Verified。

## RED

A 批次的核心剋難點都在「沒有原始註冊的插件長什麼樣子」這一個問題上,一路攔到三個實作缺陷:

- **consent.code 回歸**:以 `!cannotBeTrusted(p)` 判斷是否顯示 code-warning 許可對話框,會讓一個同時宣告 terminal profiles 的使用者 tailer 插件被當成 code 要求批准。正確語意是 `!tailerRefused(p)`(`source==='user' && report?.tailers?.state==='rejected'`)— 使用者 tailer 無論批准什麼都不會執行,不能叫它 code;同時宣告 profiles 也不改變這點。已內聯到 `confirms()`。
- **managedBy key 錯位**:VM 產生 `managedBy: 'plugin-folder'`(連字號),i18n 鍵是 `plugins.managedBy.pluginFolder`(camelCase)。typecheck 看不到字串,真機 e2e 的詳情快照在 Install 軸直接印出 `plugins.managedBy.plugin-folder` 原文。統一為 camelCase。
- **空 report 被存成 `{}`**:`applyContributions` 對任何載入的插件都 `reports.set(id, {})`,所以 main 對「零貢獻」插件回 `{}` 而非 null — 詳情既不畫 box 也不說「尚無診斷」。批次 A 的契約 `report === null = 尚未診斷` 變成只在測驗 fixture 出現的 dead code。修正:只有 report 至少一個 key 才存入,零貢獻插件真正回 null。

另有兩處測試先驗的剋難點:`useContainerWidth` 回 `clientWidth`,jestdom 無 layout 必須 mock;`plugins.axis.health` 標籤是「Capture health」(非「Health」),e2e 用 en.json 的 key 斷言而非硬編英文字串。

## GREEN

- **四道 push gates**:`npm run typecheck`、`npm run verify:specs`、`npm run verify:architecture`、`npm run verify:i18n` 全綠。architecture gate 抓到 `needsAttention` 只有測試用到 → PluginsPanel 改用同一個純函式,消除重複。
- **四份插件 suite(63→157 tests)**:`plugin-view-model.test.ts`(17)、`plugin-explore.test.tsx`(10)、`plugin-contribution-report.test.tsx`(13)、`plugins-panel-truth.test.tsx`(23)全綠;含核心修正後 `plugins.test.ts` 等 3 個 core suite 一同 157/157。
- **完整 unit suite**:499 passed / 8 skipped / 1 failed(508 files;5505/41/5547 tests)。唯一失敗 `test/shell-token-not-in-argv.test.ts:154` 為既存未改動測試(本批工作樹未觸碰該檔;平行 session 的完整 run 亦有它,並另有同屬未改動的 `relay-contract`,本次通過,屬環境變異)。沒有插件相關失敗。
- **`npm run build`** 通過。

## E2E Journey(T014)

真機 Electron(temporary home,語系 pin en),`e2e/plugin-explore.spec.ts`:

- 寬布局(1400×900):列表 + 「選擇外掛以查看完整診斷」hint;搜尋命中/落空、需處理濾器只留被拒插件、開詳情讀完整 report(被拒規則名稱+原因)、五軸齊讀、切換第二行詳情、零貢獻插件顯示「尚無診斷」。
- 窄布局(800×700,容器 <720):縮窗後已開啟的詳情保持,Back 回列表,再選取時詳情取代列表。
- 被拒規則「ticket-broken」以「Loot rules: 1 accepted, 1 rejected」+「ticket-broken: Invalid regular expression」列出,原因文字帶上編譯後的字串。執行中這些快照攔出兩個非單元可見的缺陷:`plugins.managedBy.plugin-folder` 原文印在 Install 軸(連字號 vs camelCase),與零貢獻插件無論如何顯示了一個「已診斷」的空效果軸(見 RED)。

## Gates

| Gate | Result | Date |
| --- | --- | --- |
| Clarify | 已由使用者提供的批次界定執行:A=統一探索與管理入口(renderer),B/C 明確排除。 | 2026-11-04 |
| Analyze | 五軸 ViewModel 純函式層 + 詳情面板 + 列表摘要,與既有 load/run/enable/toggle/grant/revoke/reload 行為同源。 | 2026-11-04 |
| Converge | 未執行最終收斂:B/C、官方整合入口、雙向定位、capture health 接線、安裝邊界尚未完成,不將局部 A 切片宣稱整份 Spec 完成。 | — |

## 尚未完成/不能宣稱

- B 批次:官方整合在插件頁的安裝/更新/解除安裝入口、`AgentsPanel` 操作改跳轉與回歸、插件↔擷取來源雙向定位、capture health 維度接線。
- C 批次:本機匯入、衝突恢復與安全檢查、非受管檔案保護。
- 全專案 e2e、正式安裝包、Windows/Linux GUI 未覆蓋;本機完整 unit 由 CI 裁決。

## Release Impact

| | |
| --- | --- |
| User-visible | yes:插件頁可搜尋、需處理濾器、列表/詳情雙布局、五軸診斷 |
| Breaking | no:既有插件頁操作(啟用/停用/授權/撤銷/reload)保留 |
| Packaging affected | no |
| CHANGELOG updated | yes:CHANGELOG.md Unreleased 已加 A 批次條目(未提交) |
| Upgrade note required | no |
| Packaged smoke required | no(本批無打包面變更) |