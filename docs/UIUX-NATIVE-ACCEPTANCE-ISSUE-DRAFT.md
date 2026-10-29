# 驗收追蹤：UIUX v3.2 跨平台與使用者量測門檻

已經使用者確認後公開發布：[guan4tou2/REDLOG #457](https://github.com/guan4tou2/REDLOG/issues/457)。以下保留發布內容。
此草稿只引用已公開提案及既有 issue 的驗收要求；不包含本機路徑、工作區變更內容、憑證或私人環境資料。

---

## 範圍

追蹤 `docs/UIUX-PROPOSAL-2026-10-29.md`、Spec 064 acceptance／contract-acceptance 尚待取得的跨平台與使用者實證。這是驗收協調單，不重報既有缺陷，也不把 CI 或單平台 E2E 當成全部完成。

## 待執行

- [ ] Windows＋WSL：依 `docs/ACCEPTANCE-326-345-2026-10-29.md` 執行 D1–D4。重點為 health 200／whoami 401 舊 token，以及 503 無法判定 token 的限制。缺陷沿 #326。
- [ ] Windows Git Bash：G1–G3，含 `MSYS_NO_PATHCONV=1`、預設環境及 App 重啟；記錄直送延遲、pending 變化與 Event 歸屬。缺陷沿 #345。
- [ ] Windows PowerShell 5.1／7：候選 installer、實際 edition／profile、stdout／stderr／exit、重開讀回。沿 #434／#226。
- [ ] Kali／Linux：候選 installer、外部 Bash／Zsh、HTTP(S)、保存失敗／重啟、搜尋、匯出與獨立 verifier。CT-15／16 邊界沿 #291。
- [ ] 各適用平台：完成 Spec 064 UX-01–19／CT-01–16；包含真實磁碟滿、程序中斷及原生授權操作。明確區分 PASS／FAIL／BLOCKED／UNSUPPORTED／NOT RUN。
- [ ] 五位使用者：首次 shell 接入 ≥4/5 主動操作 ≤5 分鐘；首次 HTTPS ≥4/5 並理解驗證範圍；找回操作 ≤60 秒且 ≤4 動作；AI 還原 ≥4/5 在90秒內辨識 Session、Prompt、Tool I/O、最後回答及證據性質；交付 fixture 零未批准附件。

## 證據及關閉條件

每案記錄實測候選 commit、installer SHA-256、OS／架構／DPI、來源版本、語言／視窗／App zoom、fixture、操作、elapsed／active time、實際 Event／binding／附件／hash、verifier 結果與限制。執行前選定候選，不將文件更新 commit 冒充測試版本。

不得把 mock／seed 當成真實 producer、以 macOS 結果充作另一平台，或移除失敗使用者以達門檻。每個適用門檻有可追溯實證或明確的 unsupported 裁定後才關閉；完整 gate 未過前不把 Spec 064 升為 Verified。
