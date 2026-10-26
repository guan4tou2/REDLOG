# Validation guide

1. 在隔離 HOME／project 使用已安裝 adapter，選 all，確認 command／output／exit 可保存並重啟讀回。
2. 在同 OS 的 Warp 與另一 App 跑同 Shell，選 Warp，核對允許／拒絕來源的 Event、spool／sidecar；偽造 TERM_PROGRAM／REDLOG_TERMINAL 不可繞過。
3. 選擇中途變更、背景輸出、暫停／恢復、A→B→A 與故障注入依 CT-08／09／15／16，核對實際落盤。
4. S2–S4 依 acceptance.md／contract-acceptance.md 的 IDs 執行，不把舊候選結果挪成新工作區 PASS。

命令採 npm run typecheck、npm run verify:specs 及各 task 對應 Vitest。GUI／Electron 在 Codex 必須取得對應執行權限；實際平台不可用填 NOT RUN。前述 guide 是待執行流程，不是驗收結果。
