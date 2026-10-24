# 合併後 Mac 安裝包與設定驗收 — 2026-10-24

## 基準與隔離

- main：`375f2ee392878203d330928aadba5ddc0bb84e5c`，含 #437 / #439 / #441 / #442。
- 遠端 [main CI](https://github.com/guan4tou2/REDLOG/actions/runs/40096631179) 已核對成功：macOS／Windows／Ubuntu unit，以及 Ubuntu Electron e2e。不是三平台原生手動驗收。
- 在獨立 managed worktree 建立 `codex/post-merge-mac-acceptance`，沒有切換共用目錄的分支，也沒有改動 #432 / #391。
- 從原工作區複製本輪 T068–T071 的未提交收尾文件；原檔與私人 traffic DB 保留，不讀取後者。
- Mac arm64，Electron 44.4.1，版本 0.18.3；本機 ad-hoc 簽章、未公證。沒有發版、覆蓋 /Applications 或改系統 CA。

## 合併基準的實際安裝包

從原始碼 build → electron-builder DMG / ZIP（publish never）→ package resources 通過。
`verify:package-resources` 檢查 hooks、relay、verifier、內建 packs、獨立可選 AI 解析器、checksum，以及 strict/deep 簽章。

| 檔案 | SHA-256 |
| --- | --- |
| RedLog-0.18.3-arm64.dmg | 90d4551a20c635c9e805a403d0370e86812da9c22cd2587c5a4083c94960c4e2 |
| RedLog-0.18.3-arm64-mac.zip | 7f7ae8efe88013dccddc155513ca54f6f7c3d65d360de330f5b68aaa35ca41ac |
| 安裝後 Resources/app.asar | 7332cdae0ba999cde50f8d2615f41000bb888cde46f5839d1a4b979e5e70ba73 |

檔案位於 `/private/tmp/redlog-main-375f2ee3-dist/`。DMG 經 hdiutil verify、唯讀掛載，再以 ditto 複製至
`/private/tmp/redlog-main-375f2ee3-acceptance/installed/RedLog.app` 並卸載。
這是檔案系統安裝步驟，不冒稱 Finder 拖曳或下載後 Gatekeeper 手動驗收。
安裝後資源／簽章再次通過；ZIP 完整性檢查通過。

從 DMG 複製出的 App：**6/6 AI 流程通過（47.8s）**，包括真實 Claude Code
serializer 的新／既有來源目錄、Claude/Codex 配對 I/O／搜尋／實際交付、
單一對話與全域暫停，以及明確安裝。Claude 只連 loopback fake API，使用假金鑰，
沒有私人對話或付費推論。記錄在 `/private/tmp/redlog-main-375f2ee3-installed-e2e.log`。

## 原生手動操作

以獨立 HOME 與 --user-data-dir 啟動，未開 REDLOG_E2E；所有操作透過原生介面完成。
專案為 `PostMerge-A-20261024` / `PostMerge-B-20261024`，均為合成驗收資料。

| 子步驟 | 結果與範圍 |
| --- | --- |
| 空白首次啟動、新建 A | PASS；看到空列表，UI 建立專案；HUD 初始顯示，為操作主視窗才將測試 HUD 隱藏 |
| 日常設定入口 | PASS；直接開設定分類，不強制重跑首次引導 |
| 修改 A 名稱後立即離開 | PASS；離開確認後，列表與磁碟均保留 PostMerge-A-saved |
| 新建 B、修改操作員後快速切到關於 | PASS；B 持久化 Operator-B-only，A 保持 Operator，專案 id 不變 |
| Mac 手動檢查更新 | PASS（檢查／狀態）；顯示目前 0.18.3 與手動 DMG 更新方式，檢查時間更新；主程序確認 remote release 0.18.3 |
| 設定真實寫入拒絕 | PASS（保存契約）；只將 B/config.yaml 暫設 0444，修改 Operator-B-retried；顯示保存失敗／重試，原檔 SHA-256 不變 |
| 恢復權限、點重試 | PASS（資料）；恢復原 0644，UI 顯示已保存，磁碟可讀回新值 |
| 重試後錯誤提示 | FAIL（基準）；同時殘留舊「設定儲存失敗」toast，稍後仍可見；已記錄 T072 並做最小修正 |

沒有較新版本可測，也未執行另一版本的實際更新／重啟。關閉／暫停／退出、
完整互動終端、HUD 全域焦點、Windows／Linux 桌面與乾淨依賴安裝仍各自待驗。
不因此關閉 T008–T013 或將 Spec 062 改為 Verified。

## T072：重試成功後清除已解決的錯誤

原因：error toast 原本不逾時，Settings 失敗時建立它，成功時卻只更新 inline 保存狀態。
修正以 project id 為通知 key，只在保存成功後移除該專案的保存錯誤；拒絕／失敗仍保留，
其他專案及匯出錯誤不受影響。不新增文案、元件、設定或頁面。

RED：新的使用者流程測試在修改前為 1 failed / 8 passed；成功後仍有三則 alert（應只剩其他兩則）。
GREEN：Settings + Toast 三份相關測試 **20/20 通過**，包括拒絕重試不能清除錯誤，
成功只清除自己的錯誤，以及既有錯誤不逾時規則。
記錄：`/private/tmp/redlog-main-save-toast-red.log` / `redlog-main-save-toast-green.log`。

另在現有設定 Electron journey 加入 POSIX 真實檔案唯讀／恢復重試／重新載入的回歸。
原生工具在後續退出時明確回報 Mac 已鎖定；已請操作者解鎖。原設定權限已還原，
隔離程序已停止。修正後原生確認及最終測試結果續記於下方，不將未送達的動作算成完成。


## 修正後收尾

- 五道 gate 依序通過：typecheck → specs → architecture → i18n → unit；
  **4,234 passed / 28 existing skips；421 files passed / 5 skipped（116.00s）**。
  `/private/tmp/redlog-postmerge-save-toast-full.log`。
- 修正後 signed Mac app 重新建置至 `/private/tmp/redlog-postmerge-save-toast-dist/mac-arm64/RedLog.app`；
  package resources / independent optional AI checksums / strict-deep signature 通過。
  這是額外修正候選，不是前面純 main DMG 的相同 bytes，也沒有發版。
- 修正候選實際打包 E2E：真實 POSIX 唯讀檔案／失敗提示／恢復權限／重試／重載讀回，
  **1/1 passed（8.3s）**。檔案權限於 finally 還原。
  `/private/tmp/redlog-postmerge-save-toast-installed.log`。
- 操作者解鎖後，正常確認舊候選的退出提示；先前 SIGTERM 只觸發退出提示，
  不把它當成程序已結束。接著啟動修正候選至原隔離 HOME/profile，列表仍有
  PostMerge-A-saved 與 B，B 的操作員為 Operator-B-retried。
- **原生手動 PASS**：再將 B/config.yaml 設成 0444，輸入 Operator-B-final；
  顯示 inline 失敗與 error toast，SHA-256 不變。恢復原 0644，實際點重試；
  inline 顯示已保存，舊錯誤的文字與關閉鈕從 AX tree 移除。磁碟讀回新值。
- 透過正常退出提示「停止並結束」退出修正候選，主程序 exit 0；測試檔案權限
  還原，Node better-sqlite3 binding 還原並通過 in-memory query。
- 本輪沒有 commit / push / merge / release。共用原工作區未切分支；新內容留在
  codex/post-merge-mac-acceptance。T072 完成，不關閉 T008–T013。

修正候選 app.asar SHA-256：`4e47505f644bc694bb7f22edbb4d888b66a1e7353c118e17fadc64ec5b8409d8`。
