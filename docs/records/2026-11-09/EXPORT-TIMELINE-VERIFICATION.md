# 背景匯出與 Timeline 控制狀態

基底 main `3e455574`。JSON／NDJSON 的已核准事件改以確認回覆的 16 筆批次交給 Worker，序列化、寫檔及 fsync 在背景執行。檔案使用獨占建立，重試不覆寫既有交付。切換專案、政策改變、來源遮蔽改變或寫入失敗時，移除未完成的本次檔案。完成時重檢政策、遮蔽與目的地身分。

事件陣列雜湊改成相同 JSON 位元組的增量 SHA-256，保留核准指紋。序列化仍沿用既有 NDJSON 格式；JSON、NDJSON、PII 遮蔽與空選取皆有逐位元組回歸測試。

198000 筆合成事件輸出皆為 221537780 bytes，SHA-256 皆為 bc5a9f0c2bb61456579d92b091b5ea6bcb5be4cd4efd02160546154e10461739。序列化與交付階段：原同步版本約 607 ms、RSS 1004688 KiB；背景版約 1342 ms、RSS 208224 KiB。10ms 主執行緒計時器分別執行 0 次／134 次。背景版犧牲本測試中的總時間，降低尖峰記憶體並保留主執行緒回應。數據及重現腳本隨附，非 Windows 198k 專案全流程數字。

Timeline 的總數、專案跨度、計數重試與增量計數抽成 useTimelineSummary，維持同查詢世代並拒絕較舊回覆。拖曳手勢抽成 useTimelinePan，保留 pan／click 區別，並在卸載時清理游標狀態。已有按可視區域限制 DOM 及高負載增量節流，本輪沿用。

核准匯出與 Timeline Electron 38 項通過。輸出位元組、選取、遮蔽、目的地、來源與政策的核心測試通過。完整本機 unit 曾有 5912 passed／4 failed／41 skipped，其中 fold-is-display-only 錯將工作目錄 export-closeout 視為匯出模組，已改為只判斷 basename 並複驗通過。其餘三項為已知原基底 Shell 失敗。

Bundle／HAR 的來源查詢與匯出仍有獨立成本。本次降低 JSON／NDJSON 交付與指紋的記憶體，不將該測量推廣到所有格式。
