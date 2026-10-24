# Verification: Mac 驗收三項局部修正

062 全規格仍為 Draft；本文件只記錄本輪確定缺陷的 assess → fix → verify。

## RED

- 原生候選包看到 Bash 顯示「不含輸出」，同時 DB 保存 stdout/stderr；HTTP 577B body 只顯示 preview；scope 空白時匯出選單先稱已遮蔽。
- 新增 HttpDetail 完整 inline text 測試先失敗：只找到 short preview，找不到 complete response including END。
- request inline 截斷案例先失敗：完整 body 顯示但缺警告；修正時保留 truncated。
- 文案修正不要求先寫測試；既有匯出行為測試改為定位新標籤，保留 maskOutOfScope true/false 與錯誤處理斷言。

## GREEN

- `vitest run` 指定 http-detail-tabs、first-run-record-terminal、export-mask-toggle、export-menu、export-preview-truth、export-range-format-dest：6檔89測試全過。
- `npm run typecheck`、`verify:i18n`、`verify:architecture`、`verify:specs`、`build` 通過；`git diff --check` 通過。
- 原 HttpDetail.tsx sentinel 含實體 NUL，改成等價 \u0000 字面表示以便檢閱，沒有改變 sentinel 的執行期值。
- 未跑完整 vitest；本輪僅 renderer 行為及文案改動，沒有改資料保存／篩選引擎。

## Operational Verification

Risk surface: renderer / packaged UI。
候選包實際操作、artifact 內容與簽章驗證結果見 mac-acceptance-20261021.md。原生手動操作取代不了全部自動契約測試，89 測試也不代替 Mac 安裝包流程；本輪兩者均有執行。
未執行 Playwright desktop suite；本次受影響的 HTTP 詳情／匯出選項／Bash 完成畫面以原生候選包實測，有相關元件回歸測試。仍不能宣告整份 062 Verified。

## Release Impact

| 項目 | 結果 |
| --- | --- |
| User-visible | yes |
| Breaking | no |
| Packaging affected | 無資源契約改動；已重打候選包驗收 |
| CHANGELOG updated | yes |
| Upgrade note required | no |

## Workflow Gates

- Clarify：沿用已確認需求，沒有新增產品選擇；採局部 defect 流程。
- Checklist：需求與人工驗收範圍有對照，完整矩陣未通過項未勾成完成。
- Analyze：沒有新完整 plan/tasks，完整跨 artifact analyze 尚未執行；本輪不宣稱完整 SDD 實作完成。
- Converge：三個局部症狀已在修正包確認；AI/整合匯出/全平台驗收仍待辦，062 保持 Draft。
