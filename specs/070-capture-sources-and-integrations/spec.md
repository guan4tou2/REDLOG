# Feature Specification: 截取來源、設定導航與外部工具整合

**Feature Branch**: `docs/070-capture-sources-draft`
**Created**: 2026-11-05
**Status**: Draft
**Input**: 2026-11-05 使用者提供的兩份設定頁 Stitch 原型與審查、兩份 HTTP／終端機截取審查、兩份 Burp Suite 整合建議。承接 069 的 T020。

> 本檔是**草稿**:把審查提出的主張整理成可決議的需求與待決事項。審查中涉及「現況如何」的敘述,凡未在程式碼確認者,一律標為**待驗證**,不當事實寫進需求。

## 決策與範圍

1. 設定頁的導航與版面由本規格決定;069 不再處理(069 T020)。
2. 截取來源有**共用的狀態契約**,HTTP、終端機、AI 對話、外掛來源都用它,UI 依狀態決定呈現。
3. 外部工具(先以 Burp Suite 為對象)走**選用外掛**,不寫進核心。
4. RedLog 維持**被動旁路記錄**:不要求使用者改變既有工具鏈,不預設接管系統流量。
5. 截取的**完整性**比視覺優先:資料可能漏記時,必須讓使用者看得出來。

## 原則(來自既有方向,見 PLUGIN-KERNEL／Burp 工作流)

- 最小可信核心;擷取與正規化由外掛提供;統一格式是 envelope 而不是轉換。
- 不新增報告產生、漏洞判定。
- 不把「設定完成」說成「驗證成功」,也不把「有連線」說成「有記錄」。

## User Scenarios & Testing

| Story | Priority | 摘要 |
| --- | --- | --- |
| US1 來源狀態一致 | P0 | 同一個來源在設定首頁、來源管理、詳細設定頁顯示同一狀態;所有操作經同一份狀態更新,不各自改畫面。 |
| US2 HTTP 設定與驗證分離 | P0 | 未設定／待驗證／正常／閒置／異常／已停用六態可區分;有「測試截取」入口與逐步診斷;HTTPS 憑證獨立檢查。 |
| US3 截取完整性可見 | P0 | 事件可標 `complete／partial／interrupted／unknown`;不完整時 Reader 提示,主列表只在異常時顯示。 |
| US4 重新連線不謊報 | P0 | 連線恢復後只說「連線已恢復」,保留原本的記錄缺口資訊,不宣稱已補齊。 |
| US5 Shell 偵測與安裝 | P1 | 列出實際偵測到的 Shell,依狀態提供安裝／修復／驗證／查看設定;未偵測到不算故障;安裝前顯示會改哪些檔、提供還原。 |
| US6 Burp Suite 整合 | P1 | 官方選用外掛:Burp 內的 Extension 以旁路、非阻塞方式送出 HTTP 事件,RedLog 外掛管理安裝說明與連線狀態。 |
| US7 異常列表資料驅動 | P1 | 首頁依嚴重度顯示前 3 個問題來源,其餘導向管理頁;不為單一來源寫死卡片。 |
| US8 搜尋與狀態篩選同時生效 | P1 | 符合關鍵字且符合目前狀態。 |
| US9 大量 HTTP 事件聚合 | P2 | 掃描類大量請求以工作階段聚合顯示,原始事件保留。 |
| US10 程序到網路行為關聯 | P0/P1 | 自製掃描器(Python／Go／Node)不裝外掛也能從指令 Reader 看到「執行期間**實際觀測到**的目的地、連線、DNS」,並明示哪些未觀測、哪些無法歸因。 |
| US11 範圍外目的地警示 | P1 | 以既有專案 Scope 標示觀測到的範圍外連線與 DNS 查詢(兩者分開);只針對**已觀測**事件警示,不是阻擋。 |
| US12 DNS 觀測 | P1 | 標準 DNS Query／Response 解析為事件欄位(name、type、server、rcode、來源);DoH／DoT 明示「只看到連線,看不到名稱」。 |

## Requirements

- **FR-001** 定義 `CaptureSourceStatus`(啟用、已設定、驗證結果、執行狀態、最近事件時間、錯誤與修復動作)。契約只描述**來源狀態**,不改各來源的事件格式。
- **FR-002** 狀態由實際觀測導出(最近事件、探針結果、錯誤),不只看設定。「設定完成 ≠ 驗證成功 ≠ 最近有流量」。
- **FR-003** 任何改變來源狀態的操作(啟用、驗證、重連、安裝)都更新同一份狀態,再由狀態重繪;不得分別修改多處畫面。
- **FR-004** 紅色僅用於真正的錯誤;「未安裝」「未偵測到」不是錯誤。狀態不得只靠顏色表達。
- **FR-005** 「重新連線」成功只代表連線恢復;記錄缺口維持顯示,直到使用者確認或資料被證實補齊。
- **FR-006** HTTP「測試截取」依序檢查:服務啟動、Proxy 可連線、經 Proxy 發送測試請求、RedLog 實際收到事件;HTTPS 憑證另列一項,不由 HTTP 測試通過代替。
- **FR-007** 原始 PTY I/O 完整保存;ANSI 與控制字元的處理只發生在 Reader 顯示。**不開放使用者以正則刪除會影響原始證據的內容**(例:`\x03` 是 Ctrl+C,有紀錄價值)。
- **FR-008** Recorder 自用的結束標記(如 `[exit:0]`)只在解析層使用,不出現在使用者可見的輸出。(現況:RedLog 無此標記,**待驗證**是否有任何路徑把內部標記寫進輸出。)
- **FR-009** 事件完整性欄位 `capture_status ∈ {complete, partial, interrupted, unknown}`;`ActivityState`(`interrupted` 等)與 `lateOutput`(incomplete)的既有語意要對齊,不並存兩套。
- **FR-010** Burp 外掛:Extension 的送出走非同步有上限的佇列,RedLog 不在線或變慢不得阻塞 Burp;丟事件時標示缺口;事件帶 `producer=burp`、Burp 工具來源、Request／Response 關聯 ID。
- **FR-011** 同時使用 Burp Extension 與 mitmproxy 時,同一 HTTP 交易可能被記兩次:保留來源資訊,**只在能可靠判定為同一交易時關聯**,不以 URL／時間／Body 去重(測試常重放相同請求)。
- **FR-012** 設定頁的固定文字(保存天數、雜湊、版本)改用真實配置。雜湊鏈不稱「簽名」。
- **FR-013** 異常列表資料驅動:依嚴重度排序,顯示前 3 個,其餘「還有 N 個」導向管理頁。
- **FR-014** 來源搜尋與狀態篩選為「同時成立」;篩選數字由資料計算。「健康狀態」與「擷取狀態」分開(healthy 不等於正在記錄)。

- **FR-015** 指令 Reader 聚合有可靠歸因的網路事件(目的地數、連線事件數、DNS 名稱、Port),不新增頁面;歸因不確定的事件**保留為獨立事件,不建立因果關係**。
- **FR-016** 觀測缺口可見:Connection Monitor 輪詢(預設 2s)、`EMIT_BUDGET_PER_POLL=400` 飽和、Process Monitor 輪詢(500ms)可能漏短命程序／短連線時,該時段標示「可能不完整」。**不移除上限**。「無連線紀錄」不得呈現為「沒有流量」。
- **FR-017** 專案層選項「包含本機（loopback）測試流量」,預設維持現狀(排除,避免 RedLog 自我觀測);開啟時仍排除 RedLog 自身埠。
- **FR-018** PCAP 來源解析標準 DNS(UDP/TCP 53)Query／Response(A、AAAA、CNAME、TXT、MX、NS、SRV);DNS 事件與 TCP 連線事件分開記錄(查詢 ≠ 連線)。DNS 歸因不得只靠「發包 PID」(系統 Resolver 如 mDNSResponder、systemd-resolved 代發);無可靠關聯時為未歸因事件。
- **FR-019** 能力依平台如實呈現:`已記錄 DNS 查詢／只觀測到 DNS 連線／無法確認`;缺 tcpdump／tshark／權限時說明需求,不自動安裝、不改系統 DNS。
- **FR-020** 觀測位置 ≠ 執行位置:SSH、Docker、VM、VPN 後方的程式,本機無對應觀測來源時,Reader 明說「只看到本機 SSH／終端機內容」。遠端觀測先走既有外部 Producer,不做遠端 Agent 管理平台。

## 待驗證(動工前須先查證,不當事實)

- `ls` 有 stdout、`ls -al` 沒有:至今**未重現**。已知存在 inline／ref／cast／streamed 多條路徑。內建 PTY 的隔離探針在隔離 HOME 下收不到 `command_end`,原因未明。
- 內建終端機以 cast 位元組範圍標定輸出(`ingest.ts` 的 `castProbe`);`command_end` 若早於最後一段輸出寫入 cast,長度可能偏短。**這是假設,未驗證**。
- 現有外掛安裝機制只支援 `manual`、`shell-source`、`claude-settings`(審查主張,**待驗證**)。
- 現有 CDP 連接器是否只擷取導覽與 Console、不含完整 HTTP(審查主張,**待驗證**)。
- **已在程式碼確認(2026-11-05)**:`connection-monitor.ts` 預設輪詢 2000ms、`EMIT_BUDGET_PER_POLL = 400`;`process-monitor.ts` 預設 500ms(Windows 2000ms),註解自承「spawn 且在輪詢間隔內結束的程序會漏」;`connection-table.ts isCapturable()` 排除 loopback 與 link-local;`pcap-parse.js` 只做 tcp/udp 流量摘要,**無 DNS 名稱解析**。
- **歸因錯誤風險(程式讀碼推論,待以測試重現)**:`socket-attribution.ts` 的 `pidCmd` 以 shell hook 回報的 PID 為鍵、`noteCommandPid` 後寫者覆蓋;同一 Shell 先 `python scan.py &` 再跑 `curl` 時,背景程序的後續連線可能被歸到較新指令。`portPid` 只存 localPort→pid(無五元組／時間區間),埠重用有誤歸風險。**先寫失敗測試再改。**
- 審查聲稱「漏掉 Loopback 使 `--target 127.0.0.1` 無紀錄」:`isCapturable` 確實排除,但 mitmproxy／PCAP 路徑是否另有紀錄**待驗證**。
- 外掛能否為 Java JAR 提供安裝流程;Burp 是否有受支援的自動安裝介面(預設:**由 Burp 載入,RedLog 只引導**)。

## 不在範圍

- 重做 069 已完成的活動紀錄／時間軸。
- 透明攔截設為預設(維持進階、需明確啟用)。
- 新增報告、漏洞判定、多人中央架構。
- 每種語言／協定一個掃描器或 DNS 外掛;自架 DNS Server;改系統 DNS;強制安裝 Wireshark／Npcap／mitmproxy;全系統 HTTPS MITM;自製完整 Packet Analyzer;AI 自動推斷 DNS 歸因。
- eBPF／ETW 事件式追蹤:列為 P2 評估,不進核心。
- 通用的「外部應用程式自動安裝框架」(先做 Burp 一個,驗證後再抽象)。
- 搬運 Stitch 原型的 JS、固定資料或假提示。

## 待決議

| # | 問題 | 選項 | 建議 |
| --- | --- | --- | --- |
| D1 | 先做哪一組 | (a) 狀態契約＋HTTP 驗證 (b) 截取完整性與 `ls -al` 重現 (c) Burp 外掛 | **(b)→(a)→(c)**:完整性影響所有後續,Burp 依賴狀態契約 |
| D2 | `capture_status` 持久化方式 | 寫入事件 `data`(進雜湊鏈)／存於旁表 | 先查 `data` 的雜湊範圍;旁表較不動鏈,但要能隨事件匯出 |
| D3 | Burp Extension 語言與發佈 | Java(Montoya)JAR 隨 RedLog 發佈／獨立倉庫 | 待評估建置與簽署成本 |
| D5 | 自製掃描器事件 API(`redlog.emit`) | 要做／不做／先文件化現有 ingest 契約 | 先文件化既有 `/api/events` 契約,視需求再包 SDK;不要求使用者改程式 |
| D6 | loopback 預設 | 維持排除／預設納入 | 維持排除,專案可開(FR-017) |
| D4 | 設定首頁是否凍結版面 | 依審查「首頁與分類定稿」 | 同意,但實作以真實資料,不照搬原型 |
