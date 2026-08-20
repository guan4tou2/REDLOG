# 第一期 · Tokens 與字型

依據 `docs/UIUX-STANDARD.md` §1–§3。本期只改視覺 token 與字級，不改行為與資訊架構。

## 這次改了什麼

<!-- 一兩句 -->

## 檢查項

- [ ] 沒有新增任何硬寫色值——顏色一律取自 `redlog.*` 或 soften 色表
- [ ] 沒有新增 `text-[10px]` / `text-[11px]`；本次觸及的檔案內既有者已清除（HUD 例外，下限 11px）
- [ ] 承載可讀文字的顏色不低於 `text-redlog-text-dim` (`#9a9aa4`)；未使用 `zinc-600` / `zinc-700` 當文字色
- [ ] 品牌紅 `#d75f63` 只用於文字或細線；危險紅 `#ff4d4f` 只用於實心色塊
- [ ] 泳道一律 `#6e6e78`；顏色只用於狀態（安全／未知／危險）
- [ ] 新增圖示來自 Lucide，1.5px stroke，尺寸為 16 / 20 / 24px 之一
- [ ] 邊距與行高走 `var(--row-h)` / `var(--pad)` / `var(--gap)`，未新增固定 px
- [ ] 緊密密度下互動元素的實際點擊區仍 ≥32px
- [ ] `index.css` 的 `user-select` 殼層規則未被動到
- [ ] 等寬字用於 IP、hash、exit code、時間、事件數，並帶 `tabular-nums`

## 驗收

- [ ] `npm test` 全綠
- [ ] `npx playwright test` 全綠
- [ ] macOS / Windows / Linux 截圖人工目視，字重與字形無異常
- [ ] 對比度與最小字級的回歸測試已涵蓋本次改動
