# RedLog 全應用程式改版規格：Forensic Editorial

日期：2026-10-26。狀態：Draft。本文件保留全產品的視覺基礎與舊表面驗收責任。

**優先規格**：[紀錄優先工作區 Spec 064](../specs/064-recording-first-workspace/spec.md)。
後續決策以易用性、低學習成本及操作效率為先；五主入口、Activity／I/O／AI 三閱讀方式、
Settings 五分類及來源唯一入口以 Spec 064 為準。本文件不再要求保留十一個平行主選單。

## 1. 範圍與目的

對象是既有 React/Electron 桌面產品，不是展示網站，也不是只改 Dashboard。
現有十一個工作頁的能力必須在新工作區找到承接位置；導覽可依 Spec 064 整併。
專案選擇、首次設定、匯出、HUD、確認與通知同樣納入；整併前須驗證閱讀、搜尋與交付對等。

以專業資安工作的資訊密度、清楚的閱讀層級與可核對的證據狀態建立識別。
不增加 Hero、行銷標語、裝飾性 3D、霓虹效果或為展示而設的動畫。
使用者方向稿的標語屬視覺示意，不加入產品介面，也不承諾記錄所有行為。

本文件補充 UIUX-STANDARD.md 與 UIUX-CONTROLS-AND-COPY.md。
既有 domain contract、明確警告與證據正確性優先；只改視覺不得擴大擷取授權。

## 2. 參考與取捨

- [Webby：Best User Interface](https://winners.webbyawards.com/winners/websites-and-mobile-sites/features-design/best-user-interface?sort=0)：官方名錄列出 Rijksmuseum Collection Online 為 2025 得主。
- [Webby：Copilot Money](https://winners.webbyawards.com/2025/apps-software/app-features/best-practices/337284/copilot-money)：官方列出 2025 Apps & Software Best Practices Webby Winner。

參考其資訊組織、導覽與互動品質，不複製版面或聲稱已實際操作完整參考產品。
獎項不是本產品驗收資格；不得用主觀「無可改善」取代可觀察的完成條件。

## 3. 視覺基礎

### 字體與資訊層級

- 沿用隨 App 發布的 Noto Sans TC 與 JetBrains Mono，不新增線上字體依賴。
- IP、UUID、hash、指令、路徑及資料值用等寬；一般中文標籤不強制等寬。
- 標題、主要數值、內文、次要資訊有穩定字級與重量；不靠全大寫或更長說明建立層級。
- 過長路徑與識別碼可換行或在明確閱讀區捲動；需要複製的原值仍可取得。

### Obsidian Red 配色角色

保留品牌紅與獨立危險紅。候選方向如下，但尚未全面套用；先完成狀態配對與視覺驗收。

| 角色 | 候選值或要求 | 使用限制 |
| --- | --- | --- |
| 背景 | #101114 | 視窗與畫布需一致處理；不可只換 body 而留下舊 Canvas/xterm 背景。 |
| 表面 | #17191E | 以少量可辨識的層次組織內容，不為每段內容加卡片。 |
| 主要文字 | #F2F2F4 | 與既有 dim/faint/muted 層級一起量測，保留實際可讀差異。 |
| 品牌紅候選 | #D9434E | 與深色按鈕文字配對；不能直接當所有黑底小字與 focus 的顏色。 |
| 深紅候選 | #A92C3A | 深色裝飾或混色用途候選，不直接當可讀文字或既有深字按鈕底。 |
| 次要灰候選 | #85909F | 不直接替換需閱讀的小字；與 hover 表面的對比仍須檢查。 |
| 錯誤／危險 | 獨立 danger token | 與品牌、選取、錄製不同語意；有文字或形狀輔助。 |
| 正常／未知 | 既有 safe/warn token | 不因品牌紅而把正常來源染紅；未知不等於已驗證。 |

本機 sRGB 量測：#D9434E 在 #101114 約 4.37:1；#A92C3A 配既有
#16090A 按鈕字約 2.88:1；#85909F 在既有 hover 表面 #2A2A30 約 4.41:1。
這些不符合目前需閱讀灰階 ≥6:1 的專案規則，不能直接整套替換。
當前可讀品牌 token 先保留 #D75F63。第一個落地修正是 primary hover：
舊 #B84D51 配 #16090A 僅約 3.91:1，改以獨立 accent-hover 角色修正。

### 空間、邊界與密度

- 以 4px 基礎間距規劃新佈局，沿用 comfortable/tight 設定；不新增第三套密度或頁面級縮放。
- 既有 10/14px 緊密間距與 34/30px 控制高度須在基礎階段審核，不先宣稱已符合新網格。
- 字體光學微調、1px 邊線、HUD 與標題列是明列例外，不為湊數壓縮可點範圍。
- 表單依輸入內容定寬；證據、來源清單及工作台使用可用寬度。不能用全頁固定窄欄解決所有閱讀問題。
- 清單優先用對齊與間距；卡片只用於需要成組操作或獨立狀態的單元。

### 互動與動態

- Button、Input、Table、Badge、Dialog、Tooltip 先盤點現有實作與共用能力；沒有缺口不新增包裝元件。
- 共用預設／hover／focus-visible／pressed／disabled／pending／failed 規則；鍵盤焦點不能只有輕微變色。
- 非必要動畫不做；需要的狀態過渡以 120–200ms 為目標，Reduced Motion 必須有效。
- 焦點、點擊與輸入立即回應，不等動畫播完才執行；不在事件資料上加進場排序或動態重排。
- Copy 有實際成功或失敗回饋；pending 不冒充成功；載入不卸載使用中的欄位或重設查詢。

## 4. 原有表面的驗收責任（不是新版主選單）

| 畫面 | 主要視覺／操作成果 | 不可退步的契約 |
| --- | --- | --- |
| Dashboard | 擷取狀態與待處理問題優先，來源入口直接到既有設定；近期活動居次。 | 開著不等於在記；收到指令不等於有輸出；代理監聽不等於 HTTPS 已驗證。 |
| Timeline | 時間、事件類型、選取與細節層次一致；保留閱讀位置。 | 排序、時間尺度、已載入邊界與事件 ID 不變；效能不依賴全量 DOM。 |
| Search | 查詢、共用篩選、結果與鍵盤路徑一致；匹配位置清楚。 | 完整查詢與分頁語意、取消、失敗與空結果分開。 |
| Transcript | 區分指令、輸出、AI 對話與 Tool I/O；完整性狀態貼近內容。 | 增量合併、捲動錨定、歷史頁保留、來源關係及原始資料不變。 |
| HTTP History | Request/Response 閱讀區、Headers/Cookies/Body/Raw 層次與複製一致。 | 保留完整內容取得方式、binary/truncated/decryption/failed 區別；本輪不新增比對引擎。 |
| Terminal | 分清即時終端與既有回放；錄製、定位、輸出狀態在操作附近。 | PTY 行為、鍵盤、resize、Ctrl-Z/fg、exit code 不受視覺動畫干擾。 |
| Screenshots | 縮圖、來源、預覽、分頁與失效附件狀態一致。 | 不把預覽缺失誤認原始證據不存在；大圖不阻塞工作。 |
| Targets | 目標、活動、來源歸因與證據列可讀；計數單位正確。 | eventCount 不冒充 commandCount；候選歸因不冒充確定來源。 |
| Scope | 規則、例外、違規與重算狀態分層；錯誤可恢復。 | scope 未設定、無違規與讀取失敗不同；exclude 不變成停記防火牆。 |
| Loot | 命中線索、類型、來源與相關附件狀態清楚。 | Loot 是秘密偵測投影，不改成一般檔案管理器，不新增 flag 功能。 |
| Bookmarks | 註記、編輯、來源與返回路徑簡潔。 | Bookmarks 不上鏈，與 append-only Marker 明確區別。 |
| Settings | 統一欄位、狀態、安裝／授權／修復路徑；避免同功能雙重開關。 | 開啟設定只讀；不自動安裝、啟用 AI 或擴大來源授權。 |

## 5. 跨頁與系統表面

AI 對話來源本階段只提供 Claude Code 與 Codex，依此順序呈現；兩項預設未安裝。
OpenCode 不提供安裝或擷取入口，既有證據仍按一般事件閱讀與匯出。


- 專案選擇與首次設定：外部終端優先、依平台選 adapter；可略過並重新進入，不重做一套設定。
- Export：凍結選取、格式、附件與 scope 的真實預覽；完成結果與最近成品可找回。
- HUD：維持預設開啟的 IP 顯示用途；保留縮放、穿透、退出方式、焦點與快捷鍵，不擴充成迷你 Dashboard。
- 確認視窗：依既有風險分級保留確認門檻；取消、錯誤、長文字與小視窗動作可到達。
- 通知：成功只在完成後出現；錯誤不因時間消失；重試成功只清該操作通知。
- Empty/Loading/Error/Disabled：結構一致，語意不同；不靠一段泛用說明掩蓋缺少資料或失敗。

## 6. 實作階段與順序

後續順序採 Spec 064 的四階段：Capture Baseline → Activity Core → Reading & Evidence →
Navigation & Polish（導覽／Settings／全產品驗收）。基礎對比等小缺陷可獨立修，
但不再以全面換色／動畫作為整套改版的第一階段。

各批可獨立 review，沿用 Spec 062／063 與既有 domain contract；不複製查詢、安裝、來源狀態或
ExportPlan。下表保留原有能力的驗收責任；新版工作區與任務驗收以
[Spec 064 acceptance](../specs/064-recording-first-workspace/acceptance.md) 為準。

## 7. 驗收矩陣與證據要求

各畫面共同檢查：空／少量／大量資料、長文字、loading、read failure、disabled、
窄／一般／寬桌面、繁中／英文、鍵盤與高縮放；不適用須寫理由。
本次不新增手機版本、未支援的 OS 或明亮主題。既有主題／外觀設定均須檢查。

| 表面 | 特別需要的測試資料 | 本改版完整驗收 |
| --- | --- | --- |
| Dashboard | 混合已驗證／未驗證／失敗來源 | NOT RUN |
| Timeline | 大量跨來源事件、長摘要、已選取事件 | NOT RUN |
| Search | 多頁匹配、無匹配、慢／拒絕查詢 | NOT RUN |
| Transcript | 長輸出、未完成工具、增量到達、舊頁錨點 | NOT RUN |
| HTTP | 長 Headers/Cookies、JSON、Raw/binary、失敗 sidecar | NOT RUN |
| Terminal | 活躍 PTY、停止錄製、resize、回放與失效 cast | NOT RUN |
| Screenshots | 長名稱、大圖、多頁與遺失檔案 | NOT RUN |
| Targets | 多類型計數、未知歸因、多頁證據 | NOT RUN |
| Scope | 空 scope、規則例外、重算中、讀取拒絕 | NOT RUN |
| Loot | 多類型命中、無匹配、來源／附件失效 | NOT RUN |
| Bookmarks | 空、長註記、編輯、來源返回 | NOT RUN |
| Settings | 未安裝／已安裝未授權／已啟用／失敗／保存中 | NOT RUN |
| 專案選擇／首次設定 | 新使用者、現有專案、略過後再接入 | NOT RUN |
| Export | 大量篩選、附件排除、失敗重試、完成後重開 | NOT RUN |
| HUD | 預設開啟、縮放、穿透與真實恢復快捷鍵 | NOT RUN |
| 確認／通知 | 長後果、不同風險門檻、錯誤與成功並存 | NOT RUN |

NOT RUN 指這次全產品改版的完整驗收，不否定舊版及既有子流程的測試成果。
每份紀錄綁定 build/ref、資料 fixture、OS、語言、視窗尺寸與縮放；截圖須能對到當下狀態。
視覺回歸使用固定合成資料，不把真實客戶證據或主機 IP 放進 repo／公開 issue。
原生截圖不同步時保留未通過，不把自動化幾何檢查冒充手動驗收。

效能沿用固定 fixture 與改版前基準比較查詢、鍵盤／輸入、捲動與增量更新。
相同環境下可重現的退步需解釋或修正；幾何與對比測試不能代替效能量測。
視覺工作不以無來源的任意時間數字宣布效能通過。

完成每批前逐項對照八個面向；修正已知問題後重新查看受影響處。
全產品未完成前只報該批成果，不宣稱所有頁面無可改善或可正式發版。

## 8. 本輪落地與未完成

已完成規格整合與品牌候選對比量測。既有 source-row 改善與原生驗收限制，
保留於 Spec 062 的 ui-refinement-20261026.md。
本輪第一個基礎修正：primary hover 的可讀對比；測試結果記入 verification.md。
其餘全產品配色、元件套用與逐頁改版尚未完成，不因本文件完成而打勾。
