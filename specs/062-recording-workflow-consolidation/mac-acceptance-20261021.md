# Mac 候選包人工驗收紀錄 — 2026-10-21

## 候選包與環境

- 程式基準：main `0d79823b`，package 版本 `0.18.3`；此為本機候選包，並非新的 GitHub Release。
- Mac arm64；electron-builder 26.15.3 / Electron 44.4.1。應用程式 build、typecheck、Spec Kit gates 通過。
- DMG：`/private/tmp/redlog-mac-acceptance-20261021-dist/RedLog-0.18.3-arm64.dmg`
- SHA-256：`9840d9ce57bb576ce6596c42c1436c1c4006055db7b760ee4274b2ab0ab85f80`。
- `codesign --verify --deep --strict` 通過；為 ad-hoc 簽章，沒有 TeamIdentifier，沒有公證。本機生成的包沒有驗證網路下載後的 Gatekeeper 流程。
- 使用 Finder 從已驗證掛載的 DMG 複製 App 到 `/private/tmp/redlog-mac-acceptance-20261021/installed/RedLog.app`，保留原 `/Applications/RedLog.app`（0.16.0）。
- 啟動以獨立 HOME 與 `--user-data-dir` 隔離，資料位於 `/private/tmp/redlog-mac-acceptance-20261021/home`；專案 `Mac-Acceptance-20261021`。未使用 E2E seed 或自動化點擊腳本。
- 第一次沙盒內啟動未成功，CUA 的 getApp 自行重新啟動時顯示真實專案列表；沒有開啟任何舊專案，立即退出，改用有環境的正常程序啟動。後續確認首次畫面為零專案，資料寫入隔離目錄。

## 本輪實際結果

| 案例／步驟 | 結果 | 證據與限制 |
| --- | --- | --- |
| M01：DMG 產生、掛載、Finder 複製 | 子步驟 PASS | 安裝到隔離資料夾，不是覆蓋 /Applications；Gatekeeper/下載隔離屬性未測 |
| M01：候選包啟動與新建專案 | 子步驟 PASS | 看到空列表，從 UI 建立專案；獨立目錄內有 config/timeline.db |
| 包內 hooks/分類檔/verifier 等必要資源 | PASS | verify-packaged-resources 指向候選包資源通過 |
| M14：HUD 預設開啟、展開／保持展開 | 子步驟 PASS | 原生 UI 實際點擊；單一「新增標記」按鈕存在 |
| M15：標記標題與更多內容 | 子步驟 PASS | 標題輸入後 UI 可讀回，更多內容展開備註欄位 |
| M15：儲存、時間／專案歸屬、焦點恢復 | BLOCKED | 操作到備註／儲存時 Mac 鎖定；未確認動作送達。只讀查詢尚無 marker 事件，不能寫成儲存成功或產品故障 |
| M02–M13、M16–M28 後續人工步驟 | NOT RUN | 等桌面解鎖繼續；build、typecheck 與資源檢查不代表這些流程通過 |

## 初次中斷的接續位置（已於本次接續完成）

Mac 解鎖後先確認 HUD 草稿，完成儲存/取消與焦點，再進首次設定驗收外部 Zsh/Bash。使用本次隔離資料；不可改真實 profile 或把既有使用者資料灌進測試專案。HTTPS 用明確測試客戶端 CA 或 App 路徑驗收，不因此宣稱已安裝系統信任。

後續：shell 指令與輸出 → HTTPS 請求讀回 → 搜尋 → 篩選匯出 → 實際檔案與 verifier → 重開讀回。若遇可重現缺陷，依既有規格做最小修正與相關驗證。Windows 專屬流程保持未驗收標記。

## 解鎖後的實際結果

操作者回覆解鎖後接續，App 畫面以原生 CUA 逐步操作，未以 Playwright 操作取代人工流程。桌面工具明確拒絕控制 macOS Terminal；外部 shell 改由 exec PTY 啟動真實互動式 `/bin/zsh -il` 與 `/bin/bash --rcfile <isolated>/.bashrc -i`，不是 GUI 終端驗收。一般沙盒禁止 nice/本機送件，改正常權限程序後排除此環境干擾。

| 項目 | 結果 | 可核對證據 |
| --- | --- | --- |
| Zsh 安裝與 nonce 驗證 | PASS | 從引導安裝隔離 `.zshrc`，UI 顯示 Zsh 已連線；事件包含實際 shell 身分 |
| Bash 3.2 安裝與 nonce 驗證 | PASS | 從 UI 改選 Bash、安裝隔離 `.bashrc`，真實 Bash 送件後 UI 顯示 Bash 已連線 |
| 指令／輸出與錯誤碼 | PASS | Zsh/Bash 的 MAC-*-OUT/ERR-1021 分別保存 stdout/stderr；`sh -c ... exit 7` 保存 exit_code=7 |
| Ctrl-C、Ctrl-Z/fg | PASS（此測試命令） | 真實 Zsh 執行 sleep，Ctrl-C 可回 prompt；Ctrl-Z 可暫停、fg 恢復再 Ctrl-C；事件結束碼分別含 130/146，不推論所有互動工具完整覆蓋 |
| HTTPS 驗證 | PASS（curl 路徑） | 指定 proxy 與隔離 CA、未用 -k；nonce 回應成功，UI 明確顯示 curl/8.7.1；未改系統信任，不能聲稱一般瀏覽器已信任 |
| HTTPS request/response | PASS | example.com 測試 URL 保存 GET/200、headers/TLS 與 577 B body；HTTP 頁原地開詳情 |
| 只在輸出中的文字搜尋 | PASS | `printf 'MAC-SEARCH-%s\n' OUTPUTONLY1021` 產生完整查詢字串，搜尋命中 command_end，跳到來源並可展開讀回 |
| 手動加入產物 | PASS | 原生檔案選擇器加入 report.txt，UI 有成功結果；候選指令關聯標示「可能相關，並非證明」 |
| 預覽及證據包交付 | PASS（此資料集） | examined=37，排除私人/本機=7，包含30；實際28 chained+2 logged；report.txt 與原檔 bytes 一致 |
| 包內驗證器 | PASS | `redlog-verify.py` exit 0；28 signatures、6 manifest files 通過；正確說明 projection、omitted chained=7、logged 不驗鏈，未偽稱完整來源鏈 |
| 搜尋篩選 JSON | PASS（單筆） | `redlog-2026-10-21T12-43-23.json` 包含1筆查詢命中事件。沒有以 `.manifest.json` sidecar 代替正式資料檔 |
| HAR | PASS | `redlog-2026-10-21T12-45-05.har` 為1 exchange；URL、200 與完整 response text 均相符，body 與下載 example.html 完全一致 |
| 儀表板來源入口 | PASS | 點擷取設定直接到設定頁的擷取來源區塊，沒有重新開首次引導 |
| 正常退出／重開 | PASS | UI 提醒將停止受管代理；確認後退出。修正候選包重開同一隔離資料，可讀回指令、HTTP、標記與附件 |
| HUD 草稿跨專案 | PASS | 原專案填草稿，切到 Mac-Binding-Check-1021 再存，UI 明示專案已切換且保留文字；兩個 DB 均無 DRAFT-MUST-NOT-CROSS-PROJECT-1021，原專案仍只有先前1筆標記 |
| HUD 草稿取消 | PASS | 取消後不新增 marker；測試後正常關閉 App，停止受管代理 |

## 本輪修正與修正包驗收

1. Bash 完成畫面原本寫「不含輸出」，實際 stdout/stderr 都已保存。加 Bash 專屬能力說明，保留互動程式需要 session 的限制；PowerShell 說明沒有被套成自動輸出。
2. HTTP 577 B body 已在 inline response_body，卻只顯示 preview 並要求再載入。改直接顯示已有的文字 body；sidecar/二進位仍明確載入，request 截斷警告保留。
3. 匯出選單「已遮蔽」在 scope 未設時造成誤解。改成「依網頁 scope 遮蔽範圍外內容」，維持預覽的未設 scope 說明，不改遮蔽或選取政策。

修正後候選 DMG：`/private/tmp/redlog-mac-acceptance-20261021-fixed-dist/RedLog-0.18.3-arm64.dmg`。
SHA-256：`6dbc0a93bbb8ea824defc836e3a3eeb24625a61eb8afc9e3162bdd3ff258297f`。
從 DMG 再複製至 `installed-fixed/RedLog.app`，簽章驗證通過，再以相同隔離資料啟動。

實際 UI 再驗收：577 B body 直接顯示到結尾、無「載入完整主體」按鈕；匯出選項為新文案；第二測試專案重新驗證 Bash 後顯示「一般指令的輸出會自動保存」。保存資料未遷移或重建。

## 尚未驗證或未解決

- Windows/WSL、macOS 網路下載 Gatekeeper/公證、覆蓋 /Applications 更新沒有在本輪跑。
- 本機原已有 mitmdump；沒有假稱本輪驗證了乾淨無依賴環境的真實安裝、取消與授權。
- 系統 CA 安裝、一般瀏覽器 CA 信任、原始封包/DNS、截圖權限、磁碟滿、超過一頁的完整匯出矩陣、錄影變動與更新重啟未實測。
- #344 是 Windows 偶發匯出問題，錯誤碼未知；本輪 Mac 成功不能宣稱已修復它。
- AI 真正按需安裝與匯出單一視窗整合仍在 Draft 規格範圍，不是本輪三個小修正已完成。
- 這是 Mac 基本紀錄到交付流程的操作證據，不代表 Spec 062 全部 28 個跨平台案例已通過。
