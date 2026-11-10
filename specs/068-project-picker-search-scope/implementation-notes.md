# Implementation Notes — 068 專案選擇畫面:搜尋與範圍狀態

記錄現況與已驗證的事實,不把建議當成已實作。基準 `origin/main` 4b975111。

## 現況

### 專案選擇畫面(`ProjectPicker.tsx`)

- 列出 `project.list()` 回傳的全部專案(依 `lastOpened` 新到舊),`max-h-[50vh]` 內捲動。**沒有搜尋或篩選**。
- 每列顯示:名稱(同名時多顯示建立日期)、`formatFreshness(lastOpened)`、建立日期、`dbSize`(>0 時)。**沒有範圍相關資訊**。
- 建立卡只問名稱;範圍、排除目標、安全／暴露 IP 由 Settings 持有,只有匯入設定檔時才帶入(程式碼註解,#297)。這是刻意的邊界,本規格不改。
- 鍵盤:`12bd9d7f` 讓列表可用鍵盤開啟、建立欄位不再搶焦點。搜尋欄不得破壞這些行為。
- 狀態矩陣:載入中／空／讀取失敗(`project-list-status`,`useReadState`)已存在,「讀取失敗不是空清單」是既有原則。

### 資料來源

- `project:list` → `listProjects()`(`src/core/project-manager.ts`):讀 `~/.redlog/projects.json`,過濾目錄已不存在者,**每次呼叫對每個專案遞迴 `dirSize`**,回傳 `ProjectMeta { id, name, createdAt, lastOpened, path, dbSize? }`。沒有任何範圍欄位。
- 範圍存在各專案的 `config.yaml`(`scope.targets`、`scope.excludeTargets`、`scope.scopeFile`)。**實際生效的範圍**是 `snapshotScope(config)`:`scope.targets` 與 scope 檔的條目合併去重——只看 `scope.targets` 會把「只用 Burp／ZAP 範圍檔」的專案誤判為未設定。
- 既有的「範圍未設定」語意在 `scopeIssue.ts`:`pending` 層級而非 `attention`,理由寫明「剛建立幾分鐘的專案尚未宣告目標,沒有任何問題;一個每個專案第一天都正確的紅色計數,第二天就沒人看」。徽章必須沿用這個語氣。

## 已驗證的陷阱

1. **`loadConfig` 把任何讀取失敗都吞成預設值**(`catch { return defaults() }`)。`config.yaml` 損毀或權限錯誤時,範圍會被讀成「空」,徽章會誤報「未設定範圍」。正確做法要能區分:檔案不存在(新專案,合法的未設定)／讀得到且為空(未設定)／讀不到或解析失敗(未知)。
2. **`snapshotScope` 對讀不到的 scope 檔當作 0 條**(`loadScopeFile` 失敗回 `[]`)。`readScopeFile` 才會說明原因(`unreadable`／`invalid`)。同樣會把「範圍檔壞了」顯示成「未設定」。
3. `listProjects` 已經是每次遞迴掃描所有專案目錄;再在同一次呼叫裡讀每個專案的 YAML,會讓慢路徑更慢,而且範圍讀取失敗會連帶影響整個清單。
4. 專案可能在列表載入後被別的視窗修改範圍;徽章是某一刻的讀數,不是即時狀態。

## 設計稿(Stitch,2026-11-05 提供)可以採用與不可採用的部分

採用:單欄清單上方的搜尋框與計數、列上的範圍狀態徽章。

不採用:建立時填範圍(違反 #297 的邊界)、寫死的徽章判斷(`name.startsWith('QA-ADVERSARIAL')`)、注入 CSS 隱藏徽章、假的版本號與「離線儲存就緒」、`window.confirm`、「開啟本機專案」只跳 toast。
