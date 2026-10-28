# RedLog UIUX 改善提案（2026-10-29，v3.2）

**狀態：提案。P1-1a 的拒絕測試、P1-3a 的標籤拆分、P1-5b 的鍵位已實作；其餘新增工作未開始。部分依賴能力原本就已實作（見各項「既有能力」欄），驗收狀態另列。** 規則沿用 [`DESIGN-OPEN-ITEMS.md`](DESIGN-OPEN-ITEMS.md)。

- 基準：`main` @ `55567a58`（v0.18.4）
- 版本沿革：v1（首版，含誤判）→ v2（修正四處沿用 2026-09-09 舊稽核的誤判，見附錄 A）→
  **v3（本版）**：吸收第二輪外部審查——A1 重訂規格、B2 狀態模型修正、C4a/C4b 拆分、
  A3 狀態化呈現、新增 E1（DB 恢復）與每項欄位結構（E2）、B1 分輪、D 驗收準則。
  新增的程式碼事實見附錄 B。**v3.1**：吸收第三輪審查——完整性五級改為 C3 三軸狀態
  契約（P1-7，v3 重構時誤刪該項，本版復原並修正模型）、匯出測試集擴為「格式 × 資料
  載體 × 政策」＋四項完成條件（P1-1）、規格權威拆成「規格」與「驗收證據」兩套
  （排程原則 4／P1-6）、Baseline 允許局部迭代（P1-2）、⌘+ 綁鍵收入 P2-6、E1 補
  重試情境。修正記錄見附錄 C。
  **v3.2（本版）**：吸收第四輪審查——PII 清洗改為逐格式陳述（Bundle／HAR 不支援）、
  Cast 區分「不做內容裁切」與「只複製核准前綴」、P1-3 拆開 HTTPS 擷取與 CA 信任、
  補 Verification Evidence／Current Source State 兩層、匯出測試加入 UNSUPPORTED／
  NOT APPLICABLE、E1 補安全失敗條件、首次使用量測補 AI 還原。修正記錄見附錄 D。
- 附註：本文引用的 `REVIEW-2026-10-29.md` 已於 `36287fa3` 進版控（`55567a58` 本身沒有
  這個檔）；同批加入 `ISSUE-CONVERGENCE-2026-10-29.md` 與
  `ACCEPTANCE-326-345-2026-10-29.md`。

## 每項的欄位結構

除 P0 兩項是既有驗收工作的執行外，全部項目共用常數：**提案狀態＝未開始（僅指本提案
的新增工作；「既有能力」欄列的是已實作的依賴）、驗收狀態＝NOT RUN、完成證據＝—
（交付時填 commit／測試／平台與安裝包）**。各項只列有資訊的欄位：既有能力（附程式碼
錨點）、尚缺能力、權威契約。已實作者在該項就地標注完成證據，不另改常數。

## 排程原則

1. [`REVIEW-2026-10-29.md`](REVIEW-2026-10-29.md) §6 裁定不變：P0 完成前不動
   Workspace 導覽與 Reader 重設計。
2. 順序：**契約可靠 → 呈現準確 → 元件架構**。不把「小、可平行」當優先條件——
   看起來小的修改可能直接影響保存、隱私與驗證契約（P1-1、B2a、C4b 皆屬此類）。
3. 每項過 [`UIUX-CONTROLS-AND-COPY.md`](UIUX-CONTROLS-AND-COPY.md) §2 必要性測試。
4. 規格與驗收分開看權威：**「應該做什麼」**由已核准的 domain contracts／Spec 062/064
   與 `UIUX-STANDARD.md` 仍有效的規則決定；**「實際做到什麼」**由指定 commit 的程式碼
   與對應版本／平台的驗收證據決定——兩套不可互換、不排成一條序列（見 P1-6）。Spec 064
   目前為 Draft，引用時區分已核准不變條件與提案階段新行為。
5. **引用任何稽核表前逐項對程式碼複核**——v1 的誤判全部來自跳過這一步。

---

## P0 — 擷取傳輸與資料邊界（既有驗收的執行，非新工作）

### P0-A. #326／#345 原生實機驗收

REVIEW §6 的 P0；D1–D4 情境表照走。含文件與 Issue 收斂（發行說明、#326/#345 狀態）。

### P0-B. #291 擷取邊界驗收

Spool、pause、project binding、gap（CT-15/16）——「已保存，但不完整」的底層行為
先於任何 UI 語意工作。

---

## P1 — 契約與狀態語意

### P1-1. 跨格式交付隱私與來源完整性驗收（原 A1，重訂規格）

| 欄位 | 內容 |
|---|---|
| 既有能力 | 三套機制並存：`redact-export.ts`（layer-4 恆套、scope 條件套、遮蔽拔 ref 的統一匯出 choke point）；`operator-pii.ts`（`<home>`／`<user>`／`<host>` 替換，提供共用清洗函式；**實際套用範圍由 `export-capabilities.ts` 的 `piiScrubbing` 決定**，不是所有匯出格式）；`diagnostics.ts`（`HOME_PREFIXES`，僅診斷）。另有 `export-capabilities.ts` 各格式能力宣告（bundle 無 piiScrubbing、HAR 無 scopeMasking）與 `bundle-export.ts` 自帶的 manifest／附件／來源鏈語意 |
| 尚缺能力 | 敏感資料測試集；預覽反映格式能力差異；bundle／HAR 的政策決策；「遮蔽 ↔ 證據可驗證性」的契約設計 |
| 權威契約 | #436、Spec 064 C5 |

逐格式能力（`src/core/export-capabilities.ts:18–22`）：

| 匯出格式 | `piiScrubbing` | `scopeMasking` | 備註 |
|---|---|---|---|
| JSON | 支援 | 支援 | — |
| NDJSON | 支援 | 支援 | — |
| Timeline | 支援 | 支援 | — |
| Bundle | **不支援** | 支援 | manifest、cast、附件不受 operator-PII 清洗 |
| HAR | **不支援** | **不支援** | 事件與 body 皆無 scope 遮蔽 |

`ExportPlan` 會拒絕格式不支援的清洗要求——能力宣告是拒絕的依據，不是說明文字。
Bundle 的 manifest、cast 與附件都不會因為 JSON 開啟 `scrubPii` 而跟著清洗。

**先驗收，後改政策。** 測試集是**格式（JSON／NDJSON／HAR／Bundle）× 資料載體 × 政策**
三維，不是逐格式一張表——`redact-export.ts` 是**事件匯出** redaction 的 choke point，
此描述不能延伸成「所有交付資料經同一清洗路徑」：`bundle-export.ts` 有自己的序列化與
sanitization，且 Bundle 不只包含 event。載體維度：

| 資料載體 | 核對重點 |
|---|---|
| Event | Sanitization、Scope、來源 hash |
| Manifest | Operator（`signedBy.operatorName`）、host（`hostname`）、project metadata（`engagementId`） |
| HTTP Body | Body reference、原始內容是否仍可取回 |
| Screenshot | 圖像內可見的敏感資訊 |
| Cast | 多目標內容、排除機制；**不做內容層級的 Scope 裁切或 operator-PII 清洗**，但只複製 ExportPlan 核准的固定 byte prefix（`bundle-export.ts:453` 的 `copyPrefix`／`frozenBytes`）。固定前綴不代表內容已完成隱私清理 |
| 原始 AI Transcript | 是否明確授權、是否含未清洗資訊 |
| 人工附件 | 檔名、內容、來源與交付確認 |

（載體事實：`bundle-export.ts:32–34` 的 manifest 欄位、`:50–55` 的 cast 不做內容裁切、
`:438–441` 的理由（自動切分不安全，且靜默改寫會使 io offset 失效）、`:453` 的
`copyPrefix` 只依 `frozenBytes` 限長。`:437` 起是 casts/ 的複製區塊。）
敏感資料維度（每載體 × 每格式）：

| 測試 | 必須確認 |
|---|---|
| 使用者名稱與家目錄 | 各格式是否洩漏（含 scrubPii 開與關） |
| 專案名稱 | 是否應保留於交付 metadata |
| Shell 輸出 | 敏感字串處理 |
| HTTP Authorization／Cookie | 事件與 body ref 是否可能繞過遮蔽 |
| URL query | 是否含敏感資訊 |
| AI prompt／result | 交付政策是否覆蓋 |
| 截圖／cast／binary | 是否含未清洗內容 |
| Bundle manifest | 是否宣告轉換及其驗證邊界 |

**完成條件：**

- **P1-1-01**：每種格式及資料載體的保護能力均有測試結果——**包含刻意不支援自動清洗
  的項目**（如 cast），明示而非遺漏。
- **P1-1-02**：預覽正確反映實際交付的資料集合、未遮蔽內容類型與限制。
- **P1-1-03**：政策修改或附件變動後，既有 ExportPlan 不得在未重新確認下產生不同成品。
- **P1-1-04**：成品的 hash、manifest、來源鏈關係及獨立 verifier 結果符合對應契約。

測試結果的狀態集合（避免把「不適用」記成「失敗」）：

| 狀態 | 定義 |
|---|---|
| PASS | 支援的能力符合契約 |
| FAIL | 實際行為違反契約 |
| UNSUPPORTED | 格式明確不支援，且正確拒絕 |
| NOT APPLICABLE | 該格式沒有此種資料載體 |
| NOT RUN | 尚未執行 |
| BLOCKED | 有明確阻礙，無法完成驗收 |

例：HAR 不支援 `piiScrubbing`，要驗的是「要求清洗時被拒絕」，不是「HAR 清洗正確」；
JSON 不含 cast 附件，該格是 NOT APPLICABLE 而非 PASS。

**預覽的承諾邊界：** 匯出預覽不得宣稱已辨識所有敏感資料。可承諾的是準確說明已知
資料集合、清洗政策、未清洗的載體及其限制。預覽沒有出現敏感資料警告，不代表交付物
沒有秘密。

**完成證據（2026-10-29）：** 拒絕行為已有測試——`test/export-plan-ipc.test.ts`
斷言 bundle／har 要求 `scrubPii` 時回 `unsupported-policy`，json／ndjson／timeline
接受。移除 `data-export.ts:69` 的檢查會讓前兩者失敗。

**硬性 vs 政策判定：** 零未授權附件是硬性條件；敏感資料清洗按明確的交付政策判定——
**不把「原始資料仍存在」算成測試失敗**。

**約束（決定「必須遮蔽的交付 metadata」vs「應保留的原始證據參照」之前要能回答）：**
原始與清洗後內容如何對照？清洗後相對路徑能否定位附件？原始事件 hash 是否仍可驗證？
遮蔽文字是否改變 UTF-8 byte offset（版本化座標會失效）？證據包是否應標為 projection？
所有交付格式是否同一政策？——**v1 稱「`redlog-verify.py` 不受影響」不能直接成立**：
輸出位元組的 SHA-256 只證明匯出後未改，不證明清洗後內容仍與原始證據保有可驗證對應。
路徑可能同時是操作者識別資訊**和**證據與指令間的關聯（`/Users/alice/…/results.xml`）。
診斷輸出可以容忍失去路徑語意，證據輸出不一定可以。

**不做：** 未經契約設計就強制改寫所有格式的路徑與專案名；只改 `data-export.ts` 就
假設 bundle 的 event／sidecar／附件都受到相同處理。

### P1-2. B1 第一輪：Spec 064 基準驗收

UX-01–19 的**第一輪＝Baseline（P0 完成後、主要 UI 修改前）**，不當一次性開發前置；
修改後的回歸是第二輪（P2-5）。**Baseline 允許局部迭代**：不必等 UX-01–19 全數跑完
才修局部問題——例如 HTTP 接入先跑 UX-02/03、找出摩擦、修改、重跑相關案例；但宣稱
Spec 064 整體完成仍需完整 gate。第一輪範圍含搜尋 coverage 的零結果門檻
（UX-06/07/18、CT-03/04——#454 已改善底層契約，驗證 UI 是否呈現覆蓋限制）。
零結果的證據範圍要限定：**只能宣稱「在已涵蓋的來源與查詢範圍內無命中」，不宣稱
某項操作從未發生**。

### P1-3. B2a：驗證結果與失效契約（先契約後 UI）

| 欄位 | 內容 |
|---|---|
| 既有能力 | `HttpCaptureStep.tsx` 已有：per-attempt nonce、HTTP／HTTPS 分開驗證、client 歸因（`clientLabel(report.userAgent)`）、CA 指紋處理；且 `:250–251` 已寫明「一次檢查歸屬 endpoint／CA／client policy；歷史成功不得點亮重啟或重新設定後的代理」——失效語意的核心已在 |
| 尚缺能力 | 驗證結果的持久化、跨重啟／跨專案的重新驗證與失效條件、狀態模型 |
| 權威契約 | #289、#291、#434、Spec 064 |

狀態模型：

| 狀態 | 意義 |
|---|---|
| Not configured | 尚未設定此 client |
| Ready to verify | 已準備，尚未取得實際證明 |
| Previously verified | 過去曾成功驗證 |
| Verified for current configuration | 目前設定符合該次驗證的適用條件 |
| Verification invalidated | 相關設定改變，舊結果不再適用 |
| Failed | 實際驗證失敗 |
| Unknown | 無法確認 |

**驗證的兩個事實必須分開**（`HttpCaptureStep.tsx` 目前合併）：

| 驗證事實 | 意義 | 現況 |
|---|---|---|
| HTTPS capture verified | 確實透過 Proxy 收到該次 HTTPS 驗證請求 | `:145` `const verified = running && attempt.https !== null` |
| CA trust verified | 有足夠證據表明該 Client 不是靠忽略憑證錯誤完成驗證 | `:246` `httpsCaveat = attempt.https && !httpsProvesTrust(...)`，目前只降級成警告 |

前者成立不必然代表後者成立：受管 Chromium 以忽略憑證錯誤的模式完成 nonce 驗證時，
`attempt.https` 有值，但該 Client 並沒有真正信任 RedLog CA。

**驗收案例（B2a 階段處理，不等 B2b）：** 受管 Chromium 使用忽略憑證錯誤完成 nonce
驗證時，可以顯示「HTTPS 擷取成功」，但不得把該 Client 標成「CA 信任已驗證」。

**完成證據（2026-10-29）：** 狀態列已拆成 `data-ca-trust="proven|unproven"`，
unproven 時顯示「◐ 已擷取 · CA 未驗證」且為琥珀色，不再用綠色 `✓ 已驗證`。
`test/http-ca-trust-label.test.tsx` 守住兩個方向。持久化與失效判定仍屬 P1-3b。

驗證結果至少綁定：`Project + Client Identity + Proxy Endpoint + CA Fingerprint +
Routing Configuration + Verification Timestamp`。**兩條紅線：**（1）Client Identity
不能僅依 User-Agent——不足以唯一識別程式及其 TLS 設定；（2）**不以工具名稱相近跨
client 授權**——v2 的「curl／certifi 一組、Node 一組」歸組假設不可靠（curl 的 TLS
backend 未必相同、requests 可換 CA 來源），一個 client 的 HTTPS 驗證結果不得授權給
另一個 client。B2a 先於 B2b，避免把「降低摩擦」做成「降低驗證可信度」。

**補充裁定：** 信任庫相同只能作為**顯示分組**，不能作為驗證結果繼承的依據；無法可靠
識別的 Client 保留「曾由此類 Client 驗證」的歷史資訊，不宣稱目前仍有效。App 重啟
不必然使歷史驗證無效，但**不能只因持久化紀錄存在就恢復 Verified**——重啟後重新判定
目前設定與紀錄是否相符（7 狀態的 Previously verified 與 Verified for current
configuration 正是此語意）。

**兩層資訊不得合併（v3.2）：**

| 層 | 回答 | 來源 |
|---|---|---|
| Verification Evidence | 哪個 Client、什麼時間、什麼設定與來源實例下，通過哪一種驗證 | 持久化的驗證紀錄 |
| Current Source State | 代理是否在跑、設定是否改變、來源是否可達、是否需要重新驗證 | 執行期狀態 |

「目前設定符合上次驗證的條件」不等於「目前擷取能力已再次被證明」。Proxy endpoint 與
CA fingerprint 都沒變，但使用者改了瀏覽器的代理設定時，歷史紀錄仍有效，卻證明不了
現在的流量會經過 RedLOG。沒有足夠新近的證據時，畫面可以說「上次驗證成功」，不能暗示
持續保證。這與 P1-7 的三軸同一個原則：**不同事實不要壓成一個綠色狀態。**

### P1-4. E1：DB 無法開啟與恢復流程核對（新增，2g）

| 欄位 | 內容 |
|---|---|
| 既有能力 | 初查：`src/main` 無 `SQLITE_BUSY`／`SQLITE_CORRUPT` 的專門處理；第二實例已擋、ErrorBoundary 是渲染層。ProjectManager／DB 開啟失敗如何呈現——**待調查** |
| 尚缺能力 | 對證據工具而言這不是錯誤處理，是「暫時無法取回證據」的體驗設計（§12 2g：「RedLog 不會自行修復或覆寫證據檔」） |
| 權威契約 | `UIUX-STANDARD.md` §12 2g |

| 情境 | 預期 |
|---|---|
| DB 被鎖 | 區分「暫時無法開啟」與「資料不存在」 |
| DB 損毀 | 不自動覆寫、重建或刪除原始資料 |
| 專案路徑不可達 | 保留專案參照、提供修復方向 |
| 權限不足 | 顯示實際原因 |
| 重試成功 | 恢復讀取，不重複建立資料 |
| 恢復失敗 | 保留原始檔案與可用診斷資訊 |

**完成條件（v3.2 補）：**

- **安全失敗**：復原操作不得修改原始證據。重試、關閉視窗、重啟 App 都不得自動覆寫
  資料庫、重建同名專案，或破壞既有證據鏈。
- **可用的退出路徑**：即使 DB 打不開，使用者仍要能看到錯誤原因、取得不含敏感原文的
  診斷資訊，並正常退出。

先查既有涵蓋，再決定是否需要畫面。**排在 C2（Related Activity）之前。**

### P1-5. A2 修訂：Recording Badge 真實性驗收

| 欄位 | 內容 |
|---|---|
| 既有能力 | 分頁徽章 castRecording／castTruncated／castPaused、recording-gap 橫幅、no-hook 橫幅（`TerminalView.tsx:258–267, 685–698`） |
| 尚缺能力 | 語意真實性驗收：PTY 畫面錄製 ≠ shell hook 已接入 ≠ 指令事件已收到 ≠ 輸出已保存——核對現有文案是否讓操作者把「正在錄 `.cast`」誤讀為「指令與輸出都已保存」；`⌘+`／`⌘−`／`⌘0` 綁鍵 |
| 權威契約 | `UIUX-STANDARD.md` §12 2b |

快捷鍵獨立補強，先界定：調整的是 **Terminal 字級**而非 Electron 視窗縮放，且不
攔截瀏覽器或作業系統的既有快捷鍵（keydown 目前只綁 ⌘T／⌘W／⌘⇧[]，
`TerminalView.tsx:221–238`；`:71` 註解宣稱有 ⌘+/⌘−）。

### P1-6. 規格與驗收權威的對帳（純文件，可隨時開始）

**規格定義應該做什麼，驗收證據證明實際做到什麼——兩者不能放進同一條權威序列**
（排程原則 4 已依此修正）：

| 問題 | 權威來源 |
|---|---|
| 產品應有什麼行為？ | 已核准且適用於該版本的 domain contract／Spec |
| 介面應遵循什麼規則？ | `UIUX-STANDARD.md` 中目前仍有效的規範 |
| 目前程式實作什麼？ | 指定 commit 的原始碼 |
| 實際功能有沒有通過？ | 對應版本／平台／安裝包的驗收證據 |
| 哪些功能已正式交付？ | 發布資產與 Release Notes 核對 |
| 為什麼以前這樣設計？ | 歷史 audit／decision record |

Spec 064 仍為 **Draft**——對帳時區分「已核准的不變條件」與「仍在提案階段的新行為」，
避免把未核准規格當成現有版本必須已實作的要求（規格漂移的另一個方向）。

**交付物是規格與實作追溯表**，每項記錄
`Requirement → Contract → Existing Code → Test Evidence → Remaining Gap → Status`
——不只是為 §24 稽核表補已修復標籤（該表已知過期：2b chip 列、5a 錨定列、匯出清洗
判斷）。§24 與歷史 UX audit 降級為「問題發現與設計決策紀錄」，不作現況依據。

### P1-7. 內容狀態三軸語意一致性（Spec 064 C3）

| 欄位 | 內容 |
|---|---|
| 既有能力 | C3 契約已定義**三組獨立狀態軸**（`specs/064-recording-first-workspace/contracts/content-viewer.md` §2「三組獨立狀態」）；`evidence-content.ts` 的版本化 ref／cursor／`hasMore` 已實作讀取側 |
| 尚缺能力 | Activity、I/O、AI、HTTP、Reader 與 Export 對三軸的語意一致性驗證 |
| 權威契約 | Spec 064 C3（CT-11/12） |

| 狀態軸 | 應回答的問題 | C3 定義的狀態 |
|---|---|---|
| 可讀性 | 內容現在能否讀取？ | available、pending、not-captured、metadata-only、undecrypted、pruned、missing、denied、failed |
| 擷取完整性 | 已保存內容是否完整？ | 已知完整、已知部分／截斷、未知（需來源依據） |
| 閱讀範圍 | 畫面正在顯示多少？ | 預覽／載入視窗／已確認保存範圍 |

一筆事件同時帶三軌（例：HTTP 事件＝`metadata-only` × 完整性未知 × 只顯示摘要；
shell 輸出＝`available` × 已截斷 × 只載入前 64 KiB）。**底層不得把三軸壓成一個狀態
值**——v2 的「五級列舉」正是此誤（v3 重構時又誤刪該項，本版復原並改用契約模型）；
畫面可選擇只呈現其中一軸。關鍵不變式（C3 原文）：**`hasMore` 不等於原件截斷、
`metadata-only` 不等於資料遺失、`missing` 不等於原本沒有擷取**；讀取失敗不清成空內容。

P1-3（驗證失效）、P1-5（終端語意）、P1-7（內容三軸）可共用測試資料，但**各自獨立
驗收與交付**，不綁成一個必須一次完成的大 PR。

---

## P2 — 狀態化 UI 與閱讀效率

### P2-1. B2b：HTTP 驗證狀態化 UI

依賴 B2a。已驗證項目收合＋上次驗證時間；未驗證項目單一主要動作。不重做
HttpCaptureStep 既有的 nonce／client label／CA 邏輯。

### P2-2. A3 修訂：逐字稿有界預覽

**不自動展開所有非零 exit**（滲透工具裡非零 exit 常見，全面展開傷密度與效能）：

| 狀態 | 預設呈現 |
|---|---|
| 一般成功指令 | 輸入＋有界輸出首行 |
| 非零 exit | 顯示異常狀態；是否展開依內容與使用者偏好 |
| 搜尋命中輸出 | 自動定位並揭露命中片段 |
| Loot 命中 | 顯示命中提示，**不無條件展開敏感原文** |
| 大量輸出 | 有界預覽＋完整 Reader |
| 只有保存內容參照 | 顯示「有已保存輸出」，不假造首行 |
| 保存不完整 | 明確顯示 Partial／Truncated |

核心目標：**讓使用者不用展開就知道這筆操作值不值得看。** 回歸測試必須涵蓋閱讀
密度、長輸出與敏感內容。

### P2-3. C1：HTTP 範圍狀態標示

流量列標示範圍狀態，**區分「未設定／未知／範圍外」**三種；不改擷取引擎。匯出預覽
把範圍外 host 列數計入明細。**前置：先核對 scope 分類能否可靠區分三態，再改列表。**

### P2-4. C4a／C4b：違規詳情（原 C4 拆分）

Inline allowlist 是 **scope 政策修改**——影響之後判定、交付政策、歷史重算（8a 的
`scope_recomputed`）、既有 violation 顯示，不是 UI 展開；且 Spec 064 規定 scope 編輯
回唯一設定入口。拆成：

- **C4a**：只加違規詳情展開（命中哪條規則＋完整指令）。
- **C4b**：〈編輯相關範圍規則〉deep link，帶入候選條件，**仍由使用者確認**——
  不建第二個 allowlist 編輯器，不讓單次點擊悄悄改變歷史事件的解讀。

### P2-5. B1 第二輪：回歸驗收

P1／P2 變更落地後，UX-01–19 回歸。

### P2-6. 終端字級快捷鍵

`⌘+`／`⌘−`／`⌘0` 綁 Terminal 字級。界定：只調**終端字級**、不動 Electron 視窗縮放；
不攔截瀏覽器／OS 既有快捷鍵。語意驗收在 P1-5，綁鍵實作在此——v2 記錄了缺口但未指派
批次，v3.1 補上批次。

**完成證據（2026-10-29）：** 已綁定（`TerminalView.tsx:220–250`）。`=` 與 `+` 都接受
（`+` 是 shift+=，不能要求 `!shiftKey`）；`⌘0` 回預設。上下限集中在
`src/renderer/src/lib/terminalFont.ts`，與持久化值的解析共用同一組常數——
先前只有解析有界，連按 `⌘+` 會存下 33，下次啟動被靜默重置。原生鍵位驗收仍 NOT RUN。

---

## P3 — 視覺與結構

- **B3 設定側欄徽章**：先證明與既有健康狀態顯示不重複，才做。
- **C3 回放器標記刻度**：小型視覺功能，低優先級。
- **C2 修訂：Inspector Related Activity（可信關聯與時間背景分離）**。歸屬
  **C1 Activity Projection**（哪些事件相關、哪些可信因果、哪些只是同 host／同時間
  背景、每個關係的依據），不屬 Content Viewer、**不依賴 D2**。既有決策：早期
  `events:hostChain` 已於 2026-09-23 移除（`CHANGELOG.md:1346`、
  `design-project-sync.md:32`），Spec 014 的 `events:causalChain` 涵蓋——**先確認
  現有 projection 能否滿足，不恢復另一套 host 聚合 API**；資料關係不可靠時不畫
  暗示因果的連線；同 host 時間排序最多是「相關活動序列」。須先證明必要性。
- **D1／D2／D3（Timeline／Reader 對齊／Transcript 拆分）**：驗收準則是工程性的，
  **不是行數**——行為不變、共享邏輯不再重複、狀態權威來源清楚、測試可獨立執行、
  後續修改不需要跨多個不相關元件同步更動。Reader 沿用 `evidence-content.ts`／
  `content-contract.ts` 對齊 C3，先做**缺口分析**（HTTP／Shell／AI／Cast 各閱讀面
  是否採用一致的來源版本、搜尋、定位與狀態語意——CT-11/12 契約驗收），再決定是否
  抽共用 hooks／元件；不造 mega reader。

---

## 執行順序（v3.2 裁定）

P0→P1→P2→P3 的層級不變，只調整層內順序。

| 順序 | 工作 | 完成條件 |
|---|---|---|
| 1 | P0-A #326／#345 原生驗收 | Windows／WSL／Git Bash 取得實機證據 |
| 2 | P0-B #291 擷取邊界 | CT-15／16；Pause／Project／Spool 不誤寫 |
| 3 | P1-6 規格對帳 | 移除錯誤的現況宣告，形成追溯表 |
| 4 | P1-2 Baseline | 主要操作流程的可重現問題 |
| 5 | P1-1 匯出隱私驗收 | 格式能力、資料載體、政策與結果對帳 |
| 6 | P1-3 HTTP 驗證契約 | 區分 HTTPS 擷取、CA 信任、歷史驗證與目前狀態 |
| 7 | P1-7／P1-5 | 內容三軸、終端錄製語意一致 |
| 8 | P1-4 DB 恢復 | 既有處理路徑核對及安全失敗測試 |
| 9 | P2 UI 精修 | 只修 Baseline 證明過的摩擦 |
| 10 | P2 Regression | 受影響 UX 案例重測，完整 Gate 收斂 |
| 11 | P3 架構重整 | 有實測維護問題才拆分 |

P1-6 與不依賴執行環境的測試設計可以與 P0 平行。

## 首次使用量測

| 指標 | 目標 | 性質 |
|---|---|---|
| 理解 RedLog 的作用 | 30 秒內知道如何產生並查看測試事件 | 探索性，不代替驗收 |
| 第一次外部 shell 接入 | 5 人至少 4 人主動操作 5 分鐘內完成 | acceptance |
| 第一次 HTTPS 驗證 | 5 人至少 4 人完成並理解驗證範圍 | acceptance |
| 找回既有指令與輸出 | 60 秒、4 個動作內 | acceptance |
| 還原 AI 操作 | 5 人至少 4 人，90 秒內辨識 Session、Prompt、Tool I/O、最後回答及證據性質 | acceptance（Spec 064 既有門檻） |
| 正確交付證據 | 零未授權附件、預覽與成品一致 | acceptance |

記錄需要解釋、返回上一頁、誤認狀態、把「來源已接入」誤當「已保存資料」的位置。

AI 還原不另建測試，直接引用 Spec 064 的既有使用者任務門檻。它檢查的是操作者能否
分辨：AI 宣稱執行了什麼、工具實際產生了什麼、哪些結果由 RedLog 獨立觀測、哪些只有
AI 來源回報。

## 不做（v3.1 更新）

- 重做終端記錄 chip、更新前錨定、Reader 底層（皆已實作——走驗收）
- 未經契約設計強制改寫交付格式的路徑與專案名（P1-1 先驗收）
- 以工具名稱相近跨 client 授權 HTTPS 驗證結果（B2a 紅線）
- 第二個 allowlist 編輯器（C4b 只 deep link）
- 把重啟確認改成非阻斷（會停擷取，本來就該明確確認）；「約 8 秒」不寫死，記實際邊界
- 恢復 `events:hostChain` 式的 host 聚合 API
- 2a 證據包報告、3c pending 層、P0 前任何導覽變更（既有裁定）

## 收尾：產品層級驗收

三個問題不變：（1）操作員是否清楚知道 RedLog **現在真正記錄了什麼**？（2）來源
異常、資料不完整或專案切換時，RedLog 能否**說明影響**？（3）能否從某次操作**快速
找到相關原始證據**，在不誤交付敏感資料的前提下產生可驗證成品？

**結論：不開新一輪 UI 重設計；以 Capture → Verify → Investigate → Export 為主線做
端到端產品驗收，只有驗收確認的摩擦點才進下一輪修改。**

---

## 附錄 A：v1 → v2 修正記錄（經程式碼核實）

| v1 判斷 | 核實結果 | 證據 |
|---|---|---|
| 2b per-pane 記錄 chip 未實作 | 誤判：徽章與橫幅皆在 | `TerminalView.tsx:258–267, 685–698` |
| 5a 重啟前錨定未實作 | 誤判：`anchorBeforeRestart` 已整合 | `updater.ts:2, 203–205`；`src/core/update-anchor.ts` |
| 匯出無隱私清洗 | 部分誤判：`redact-export.ts` 統一 choke point；實況是格式能力不均 | `export-capabilities.ts`；`ExportMenu.tsx:189/302` |
| Reader kernel 需新造 | 方向修正：契約與後端已在 | `evidence-content.ts:98–174` |
| 首次路徑以內建終端為最佳 | 過時：Spec 064 主路徑為外部 shell | `specs/064/spec.md` US1 |
| ⌘+／⌘− 未綁鍵 | 仍成立 | `TerminalView.tsx:221–238` |

## 附錄 B：v2 → v3 修正與新增（經程式碼核實）

| 項目 | 事實 | 證據 |
|---|---|---|
| 操作員 PII 清洗已有第三套機制 | `operator-pii.ts`：`<home>`／`<user>`／`<host>` 替換，scrubPii 開啟時全匯出路徑套用（原 NDJSON-only） | `src/core/operator-pii.ts` |
| B2 的失效語意已部分存在 | per-attempt nonce、HTTP/HTTPS 分開、client 歸因、「檢查歸屬 endpoint／CA／client policy，歷史成功不得點亮重啟後的代理」 | `HttpCaptureStep.tsx:15–16, 250–251`；`core/http-verify.ts` |
| 信任庫歸組假設移除 | curl TLS backend 未必相同、requests 可換 CA 來源——v2 P1-C 的「curl／certifi 一組」刪除；一個 client 的驗證不得授權另一個 | 本版 B2a 紅線 |
| host 聚合 API 已有移除決策 | `events:hostChain` 於 2026-09-23 移除；Spec 014 `events:causalChain` 涵蓋 | `CHANGELOG.md:1346`；`design-project-sync.md:32` |
| C4 的本質是政策修改 | inline allowlist 影響後續判定、交付政策、8a 歷史重算；Spec 064 規定 scope 編輯唯一入口 | `specs/064`；8a 行為（§20） |
| E1（2g）初查 | `src/main` 無 `SQLITE_BUSY`／`SQLITE_CORRUPT` 專門處理；開啟失敗的呈現路徑待查 | grep 初查（2026-10-29） |
| `redlog-verify.py` 不受影響的宣稱撤回 | 輸出位元組雜湊 ≠ 清洗後內容與原始證據的可驗證對應 | 附錄 A 的 A1 修正延伸 |
| REVIEW-2026-10-29.md 未進版控 | 本機未 commit，`55567a58` 遠端沒有此檔 | 本文附註 |

## 附錄 C：v3 → v3.1 修正記錄（經程式碼／規格核實）

| 項目 | 事實 | 證據 |
|---|---|---|
| 完整性「五級」壓成單軸是錯的 | C3 契約本來就是**三組獨立狀態軸**，原文並寫明「hasMore 不等於原件截斷」；v3 重構時又誤刪該項，本版復原 | `specs/064-recording-first-workspace/contracts/content-viewer.md` §2 |
| 匯出 choke point 描述過寬 | bundle-export 有自己的序列化；manifest 含 `hostname`／`engagementId`／`signedBy.operatorName`；cast 不做內容裁切、刻意不做 operator-PII 清洗（v3.2 再更正：仍只複製核准前綴，見附錄 D） | `bundle-export.ts:32–34, 50–55, 438–441, 453` |
| 規格與驗收混入同一權威序列 | 規格定義應然、驗收證明實然，不可互換；Spec 064 為 Draft | 排程原則 4／P1-6（本版） |
| 零結果的證據範圍 | 只能宣稱「在已涵蓋的來源與查詢範圍內無命中」 | P1-2（本版） |
| ⌘+ 綁鍵無歸屬批次 | v2 記錄缺口但未指派開發批次 | P2-6（本版） |
| E1 缺重試情境 | 重試成功應恢復讀取且不重複建立資料 | P1-4 表（本版） |
| Baseline 不必全綠才可局部修 | 允許先跑相關 UX 案例、修、重跑；整體完成仍走完整 gate | P1-2（本版） |

## 附錄 D：v3.1 → v3.2 修正記錄（經程式碼核實）

| 項目 | 事實 | 證據 |
|---|---|---|
| PII 清洗「全匯出路徑套用」過寬 | 實際逐格式：JSON／NDJSON／Timeline 支援 `piiScrubbing`，Bundle 與 HAR 不支援；`ExportPlan` 會拒絕不支援的要求 | `export-capabilities.ts:18–22` |
| Cast「never trimmed」混淆兩種裁切 | 不做內容層級的 Scope 裁切或 PII 清洗，但只複製 ExportPlan 核准的固定前綴；原始碼理由寫明「靜默改寫會使 io offset 失效」 | `bundle-export.ts:438–441, 453` |
| HTTP 驗證只有一個 `verified` | 需拆成 HTTPS capture verified 與 CA trust verified；現況 `:145` 把兩者併成一個布林，`:246` 只把 CA 疑慮降級成警告 | `HttpCaptureStep.tsx:145, 246` |
| `Verified for current configuration` 定義不足 | 補 Verification Evidence／Current Source State 兩層；設定相符不等於能力已再次被證明 | P1-3（本版） |
| 匯出測試矩陣缺「不適用」 | 加 UNSUPPORTED／NOT APPLICABLE；HAR 驗的是拒絕行為，不是清洗正確 | P1-1（本版） |
| 預覽的承諾邊界未寫明 | 只承諾已知資料集合、政策與未清洗載體，不承諾辨識所有敏感資料 | P1-1（本版） |
| E1 缺安全失敗條件 | 復原不得改寫證據；DB 打不開仍要有可讀原因、可用診斷與正常退出 | P1-4（本版） |
| 首次使用量測缺 AI 還原 | 引用 Spec 064 既有門檻，檢查 AI 宣稱／工具實際／RedLog 獨立觀測的區分 | 量測表（本版） |
| `REVIEW-2026-10-29.md` 的附註過時 | 已於 `36287fa3` 進版控，`55567a58` 沒有此檔 | `git log --oneline -3` |
