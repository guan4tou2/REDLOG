# Implementation Notes — 067 官方整合安裝邊界(C 批次)

記錄現況與已驗證的缺口,不把建議當成已實作。基準 `origin/main` 35e458f7(066 B 已合併)。

## 已經成立的保護(有測試,C 不重做)

`src/core/plugins/official-agents.ts` + `test/official-agent-plugins*.test.ts`:

- 只安裝 app 隨附、checksum 吻合的套件(`packages()` 比對 `redlogAgent.sha256`);第三方可執行 tailer 仍被通用外掛系統拒絕。
- 不採用既有的外來目錄,即使是空的 → `conflict`(`does not adopt an existing foreign directory`)。
- 不覆寫、不移除被使用者改過的 manifest;有多餘檔案時拒絕移除。
- 只刪自己建立的兩個檔案與空目錄;`lstat` 擋 symlink 與非一般檔、4 MB 上限。
- 更新為 staging → backup → swap,收據寫入失敗時回滾。
- 授權收據綁 `installationId`;重裝換新 id,專案授權不沿用。
- 主行程 `mutateOfficialAgent` 對成功變更寫 `config_changed` 稽核;`plugins:setEnabled` 對官方整合直接拒絕,恢復只走 install。

## 已驗證的缺口

1. **目錄讀取失敗會拖垮整個插件頁(B 引入的耦合)**。`list()` 在 `inspect` 的 try 之外呼叫 `packages()`:隨附套件目錄不存在(dev 沒跑 `build:ai-plugins`)或任一套件 manifest／checksum 不合,`list()` 整個 throw,IPC rejected。B 的 `PluginsPanel.load` 用 `Promise.all([api.list(), api.officialAgents()])`,所以一個壞套件讓**所有**使用者插件一起顯示「載入失敗」。B 之前插件頁不依賴這個目錄。
2. **收據檔(`.official-ai-installations.json`)損毀 = 所有整合 `error`,無出路**。`receipts()` 在 `inspect` 內 throw → 每個套件都回 `error: Invalid AI installation records`;`install`/`uninstall` 對 `error` 都直接回該錯誤。已安裝的整合既不能移除也不能更新,插件頁只剩「開啟資料夾」。
3. **收據遺失但檔案完整 = `conflict`**。目錄內容與 app 會寫的位元組完全相同,只因收據缺失就被判為「與安裝紀錄不符」;操作者只能手動刪資料夾。是否可安全重新採用(保留 `installationId`、保留專案授權)是信任邊界決定,見 spec 的決策 D2。
4. **`conflict` 沒有 app 內的出路**。詳情只給訊息與「開啟資料夾」(B 刻意不做修復)。
5. `inspect` 與 `unlink` 之間沒有鎖(check-then-act)。單實例鎖下只有使用者或外部程式能插手,實際風險低,列為可選加固。

## 「本機匯入」目前沒有定義

065/066 的批次界線只用了「本機匯入可行性」一詞,沒有說匯入什麼。可能的解讀:

- (a) 把使用者自己的 AI 轉錄 adapter(可執行 `.cjs`)匯入成官方整合 — 與現行信任模型直接衝突:官方整合的唯一信任依據是 app 隨附 + checksum,第三方可執行 tailer 被刻意拒絕;要做等於新增「受信任的第三方可執行碼」,屬新的安全決策,且接近已被劃掉的 marketplace／發佈機制(見 plugin-kernel 方向)。
- (b) 把使用者的**宣告式**外掛資料夾匯入 `~/.redlog/plugins/`(取代「手動放資料夾 + Reload」)— 可行,信任仍由內容雜湊 + 同意流程把關,不涉及可執行碼;但「手動放資料夾」目前就是文件化的流程,是否值得做要看價值。
- (c) 離線環境下由本機檔案安裝官方整合套件 — 套件已隨 app 打包,沒有需要匯入的東西。

## 風險

- 任何「修復」都是對 `~/.redlog/plugins` 的檔案系統寫入;只能移動／保留,不能刪除操作者不認得的內容。
- 重新採用既有目錄會把一個外部可寫的目錄重新放進信任鏈,必須以位元組完全相等為前提,且不得因此授權任何專案。
- 稽核:每個新的變更路徑都要寫 `config_changed`,與 B 的 install／uninstall 同等級。
