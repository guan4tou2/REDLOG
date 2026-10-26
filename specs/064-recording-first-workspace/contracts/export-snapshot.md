# C5 — 匯出快照、持續寫入與錄影邊界

**Status**: Draft contract · 2026-10-26。適用 FR-037–039、FR-048；驗收 CT-05／06／07。延伸既有 ExportPlan，不建立另一套預覽／匯出引擎。

## 1. 確認時固定的集合

預覽先把使用者選擇解析為一份不可變 plan；確認與執行使用同一份。必要資訊如下，沿既有欄位承接，缺少能力再於 bounded plan 補齊：

- project、plan ID／有效期限、正規化 query／選取方式及規則版本。
- 兩個 Event tier 的資料邊界、原始選定 Event IDs／內容識別；Activity 與 Session 選擇在此邊界解析，不於執行時重新查全量。
- 真正必要 companions、僅供閱讀的相關背景、使用者另選內容分開，預覽呈現各自數量與用途。
- Scope snapshot、私人流量／遮蔽／禁止匯出政策及附件逐項選擇。
- 附件來源身分、內容版本／hash；仍在追加的檔案固定可驗證完整 prefix 及長度，分段錄影固定實體分段清單與各段邊界。

既有 `ExportPlan` 已有 project、snapshot、selectedEventIds、scopeSnapshot、附件及 policy／內容指紋；這裡要求 Activity／Session 映射與其語意一致，不聲稱全部新選取模式已存在。

## 2. 預覽後資料改變

| 變化 | 必須結果 |
| --- | --- |
| 新 Event、晚到 Result、新輸出 chunk／cast part | 不自動加入已確認 plan；操作者「更新預覽」才建立新 plan。 |
| Live 檔案只追加 | 可輸出已確認 prefix，核對原 prefix 未改；尾端及新分段不偷渡。 |
| 同大小改寫、截短、同名替換、清理／遺失 | 不以檔名／大小當版本證明；停止並回具體錯誤／要求重建預覽，不靜默少交附件。 |
| 政策／授權收緊或新增禁止匯出 | 舊 plan 不得繞過限制；失效後重新確認。一般暫停不禁止交付既有已准許證據。 |
| 確認前切專案 | 不用另一專案執行舊 plan；重新開對應預覽。 |
| A 的匯出已開始，再切 B | 工作仍綁 A，按既有能力完成或取消；不切換輸入／輸出歸屬，成品來源及通知仍為 A。 |

從讀取到寫出須核對實際輸出 bytes 的內容識別，再完成成品；僅執行前 stat 不足。失敗產物不冒充成功交付，重試不改選取。預覽時缺少必要資料也不得以綠色成功掩蓋；未完成 Result／部分 prefix 的狀態會隨 plan 固定。

## 3. Session 與目標選取

目前查詢、明確 Activity／Event 選取、整個 Session、全部專案是不同範圍。展開 Session 或搜尋命中其中一筆，不等於選取整個 Session；模式切換不改 plan。

**草案預設**：目標／事件子集合匯出時，若一段 cast 含其他目標、歸屬不明或無法安全裁切的內容，整段錄影不預選。預覽列出跨目標／未知範圍，操作者可逐項「加入整段錄影」，重新確認後才附上。單一命令回放片段不等於已安全裁切的可交付錄影。

明確選「整個 Session」表示願意選取該 Session 範圍，但仍顯示跨目標／私人內容限制、附件選擇及適用政策；不宣稱整段 cast、截圖或 AI Session 已通過目標 Scope 清理。無法可靠裁切就不自動製造裁切後成品。

此保守預設是待實作契約，不是目前附件預選行為的描述。附件政策應在 canonical plan 解析處落實，各格式／執行入口共用，不能只在 React 過濾勾選。

## 4. 成品及驗證

Manifest／結果保留 plan、資料邊界、已交付事件／必要上下文、實際附件／prefix、排除與已知缺口。部分事件鏈的驗證與完整原鏈驗證須區分；可讀摘要不能當作全量原件。證據包、HAR 及既有進階格式均遵守自身能力邊界，同一承諾不能只對其中一條執行路徑成立。

## 2026-10-27 implemented slice

`activity`／`session` subset 由展開列的 anchor Event、project 及 ActivitySnapshot 決定。兩 tier 的 row boundary／count／tail 在解析前核對；後端以 canonical activityKey 或 sourceSessionKey 選全部成員，而非 renderer 當頁 IDs。Session namespace 包含 project、capture binding、來源種類、provider／shell 及 producer Session；未知 Session 不提供整組匯出，不跨重啟 binding 推測合併。

JSON、NDJSON、Bundle 沿既有 plan，HAR／Timeline 格式不接受此新選取方式。預覽使用該查詢快照；晚到的配對結果、chunk 不自動加入。無關截圖／body 不隨包帶出；相關 cast（含現存實體分段）預設不選，逐檔 opt-in。cast 的 target 歸因以快照中完整來源核對，不只使用選中的單目標事件；不宣稱裁切乾淨。執行不加入新附件／分段，只複製核准 prefix，並再核對成品附件 digest。預覽後新增禁止匯出使 plan 失效。

這是 macOS 候選實作與合成資料流程驗收；不代表全部 C5／平台矩陣皆 Verified。
