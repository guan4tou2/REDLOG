# Tool Design Analysis — RedLog Feature Reference

> 來源：競品/同類工具設計分析，用於識別 RedLog 可借鑑的 UX 模式與功能缺口。
> 建立：2026-09-18
> 狀態：持續更新中

## RedLog 核心約束（設計紅線）

依 `docs/DESIGN-plugin-kernel.md` + DESIGN-PRINCIPLES §5：

1. **只專注 log** — 不做 report generation
2. **不做多人中央架構** — 無 central server/shared DB/dashboard
3. **Envelope not transform** — raw bytes 不變形，unified format 是封套
4. **Minimal trusted core** — capture/normalize 走 plugin，core 只管 7 件事

任何參考功能必須在這些約束內評估。

---

## 1. Ghostwriter v6.3.0 (SpecterOps)

> 來源：https://specterops.io/blog/2026/04/10/ghostwriter-v6-3-0-and-cli-v1-0-0-new-activity-logging-faster-installs-and-better-writing-qa/

### 工具定位
Engagement management + reporting platform。Web-based，多人協作，覆蓋 operation log → evidence → report 全流程。

### 關鍵設計模式

#### 1.1 雙欄 Activity Log（Two-pane layout）
- Email client 風格：左欄事件列表，右欄選中條目詳情
- 不用跳頁即可掃描 + 深入
- 保留既有的欄位自訂、排序功能

**RedLog 現況**：Timeline 是單欄捲動，搜尋也是單列。
**參考價值**：★★★★ — detail pane 能承載 marker 修正歷史、關聯截圖、recording 片段。

#### 1.2 Evidence 直接掛在 log entry 上
- 每筆 log entry 可附加 evidence 檔案
- 有 friendly name、direct link、自動 tag
- Evidence 頁也有 deep link 回到 log entry

**RedLog 現況**：event/screenshot/recording 各自獨立，靠 timestamp 或 flowId 隱性關聯。
**參考價值**：★★★★ — 顯性化「事件 → evidence → recording」三角關係。

#### 1.3 Terminal Recording 內嵌播放（Asciinema .cast）
- 手動上傳 .cast、瀏覽器內嵌播放
- 提取文字做全文搜尋

**RedLog 現況**：**已有且更強** — 自動擷取、cast-index 全文索引、CastResults 搜尋。
**差距**：recording 與 event 的關聯可以更明確。

#### 1.4 自動 Tag 管理
- Evidence 附加/移除時自動加減 `evidence` / `recording` tag
- Tag 驅動篩選

**RedLog 現況**：有 technique-tagger + command-tagger，但 UI 層的 tag 篩選剛起步。
**參考價值**：★★★ — `has:evidence` / `has:recording` 快篩維度。

#### 1.5 Deep Link（事件永久連結）
- 每筆 log entry 可複製 deep link 分享
- 接收者直接開到該筆並高亮

**RedLog 現況**：無。只有 in-app 導航。
**參考價值**：★★★ — `redlog://event/<id>` 或 in-app copy event reference。

#### 1.6 Log Narrative 自動生成
- 從 log 自動產生結構化大綱插入協作編輯器
- 用 tag 控制納入範圍

**RedLog 現況**：walkthrough-export.ts 有基礎。
**評估**：⚠️ 觸及「no report gen」紅線 — 只能做 evidence export 延伸（結構化 Markdown 匯出），不能做報告撰寫輔助。

#### 1.7 被動語態偵測
- 本地 spaCy 模型，完全離線

**RedLog 現況**：不做報告撰寫。
**評估**：❌ 不適用。

#### 1.8 發布式容器映像
- Pre-built images 取代 local build

**RedLog 現況**：Electron 桌面應用，已有 electron-builder。
**評估**：❌ 架構不同。

---

## 2. PwnDoc / PwnDoc-ng

> 來源：https://github.com/pwndoc/pwndoc、https://github.com/pwndoc-ng/pwndoc-ng、https://skandashiled.medium.com/pwndoc-complete-guide-b927956d06d5
> 注意：pwndoc（原專案，含較新 AI-assist/review workflow）與 pwndoc-ng（社群 fork，Tiptap 2.0 協作編輯器）為兩條並行分支，功能有重疊但非完全一致，以下合併分析。

### 工具定位
Open-source pentest **report generator**（非 log/capture 工具）。核心價值主張是「mutualizing data like vulnerabilities between users」——把弱點資料庫化、跨稽核重複使用，最終產出可自訂的 Docx 報告。Web-based、Node/Vue 前後端分離、多人共享同一 server 上的弱點庫與稽核。工作流程是 **Vulnerability Database → Audit（稽核專案）→ Finding（引用或客製弱點）→ Docx Report**，完全落在「稽核結束後的寫作/交付」階段，不覆蓋執行中的操作記錄。

### 關鍵設計模式

#### 2.1 集中式可重用 Finding/Vulnerability 範本庫
- 弱點（title、CVSS、description、remediation、多語言內容）存在共享資料庫，跨稽核直接引用或複製後客製
- Audit 內的 finding 可以「連結」回範本庫，也可以獨立編輯不影響範本

**RedLog 現況**：Marker 系統有 amendment chain（修正歷史），但沒有「跨 marker 的可重用範本」概念，每筆 marker 都是獨立填寫。
**參考價值**：★★☆ — 若做「marker template」（例如常見 finding 類型的欄位骨架），可加速資料輸入；但必須止步於「本機範本清單」，不能演變成集中式弱點資料庫（違反紅線 2）。

#### 2.2 Docx 樣板 + AI-assisted 寫作（可配置 provider：OpenAI/Anthropic/DeepSeek/Ollama/Bedrock）
- 逐區塊（overall_risk / executive_summary / per-severity summary）AI 輔助生成文字，插入 Docx 樣板變數

**RedLog 現況**：不做報告撰寫。
**評估**：❌ 直接觸犯紅線 1「只專注 log，不做 report generation」，不適用。

#### 2.3 Audit Review & Approval Workflow + 討論串留言
- Draft → Review → Approved 狀態機，附加 threaded comments 供審核意見往返

**RedLog 現況**：無審核狀態機，marker 修正靠 amendment chain（單向歷史，非審批）。
**評估**：❌ 觸犯紅線 2「不做多人中央架構」——這本質是 server-based 多人審批系統，RedLog 是 local-first 單機工具。

#### 2.4 Finding 自訂欄位 / 自訂章節 + CVSS v3/v4 評分
- Finding 可加自訂欄位、自訂排序的自訂章節，供不同客戶樣板需求

**RedLog 現況**：Marker 欄位是固定 schema。
**參考價值**：★★☆ — 「自訂欄位」概念可考慮用在 marker metadata（結構化資料擴充），但要避免滑向「報告排版設定」這類 report-gen 專屬功能。

#### 2.5 Evidence 內嵌於 Finding 內文（WYSIWYG 貼圖 + 批次資料夾上傳）
- Proof/evidence 是直接貼在協作編輯器內文中的圖片（inline），示範 GIF 顯示可整個資料夾批次上傳多張截圖
- 沒有獨立的「evidence 物件」，評估完整性也無 hash chain

**RedLog 現況**：**已更完整** — screenshot 是獨立物件，透過 timestamp/flowId 關聯到 event，且有 SHA-256 hash chain 完整性；PwnDoc 的 inline 貼圖反而較弱、無防竄改設計。
**參考價值**：★★ — 唯一值得參考的是「批次資料夾匯入多張截圖」這個匯入動作本身，可用於手動匯入既有截圖到 manual screenshot 流程；evidence 關聯與完整性設計本身 RedLog 已領先。

#### 2.6 Finding 內容多語言（同一弱點維護多語系版本，依語言產出報告）
**RedLog 現況**：已有 UI 層 i18n（en / zh-TW），但 PwnDoc 的多語言是「同一筆資料維護多語系內容」，服務於「輸出不同語言報告」。
**評估**：❌ 不適用 — 這本質仍是 report-generation 的延伸功能，RedLog 不產出報告。

#### 2.7 無 Activity Log / Timeline / Terminal Recording / 事件搜尋
- PwnDoc 完全沒有「稽核過程事件時間軸」的概念，它服務的是 post-engagement 的「弱點庫 → 報告」階段，不記錄操作過程本身

**RedLog 現況**：這正是 RedLog 的核心強項（Timeline、Terminal Recording + cast-index、HAR、HTTP History、Search panel）。
**評估**：關鍵結構性差異 — PwnDoc 與 RedLog 落在 pentest 工作流程的不同階段（PwnDoc = 交付後段寫作工具，RedLog = 執行中即時記錄工具）。這代表 PwnDoc 的多數特色功能對 RedLog 參考價值低或直接違反紅線，兩者是互補而非競品關係。

#### 2.8 2FA / RBAC / 加密備份還原 / Server 架構
**RedLog 現況**：本機 Electron app，無多帳號、無 central server。
**評估**：❌ 不適用 — 架構前提不同。

### 小結
PwnDoc 驗證了 RedLog 的既有紅線判斷是對的：report-generation 工具與 live-capture/logging 工具是兩種不同問題域，功能不該匯流。唯二有參考價值的是「reusable template 加速資料輸入」與「批次匯入既有截圖」這兩個一般化 UI 概念，且都必須在不觸及 report 撰寫、不變成集中式多人架構的前提下才能考慮採納。

---

## 3. Dradis Framework (CE + Pro/Gateway)

> 來源：web research（2026-09-18 multi-model workflow）

### 工具定位
Self-hosted pentest collaboration + reporting platform。開源 CE 版 + 商業 Pro/Gateway。支援 47+ scanner 匯入（Nmap、Burp、Nessus、Qualys 等），Node → Issue → Evidence 三層資料模型，多人協作。

### 可參考模式

| 模式 | RedLog 相關性 | 評估 |
|------|-------------|------|
| Diff-style revision history（Issue 修訂歷史，綠底新增/紅底刪除） | 高 | ✅ **已有基礎** — marker amendment chain 已有修正歷史，缺的是 diff UI 呈現 |
| 統一單頁記錄（Node + Issues + Evidence + Notes 同一頁） | 中 | 🔄 改造為 target detail view（按目標聚合事件） |
| 三層資料模型（Node → Issue → Evidence） | 低 | ❌ Issue 是 vuln-management 概念，非 logging 模型 |
| 拖放/剪貼簿貼上 evidence | 低 | RedLog 已有自動截圖 + 手動截圖 |
| 多 scanner 匯入 + Mappings Manager | 低 | plugin system 已處理 |
| Gateway 客戶入口 / Webhook | 無 | ❌ 違反紅線 2 |
| Note/Report 範本 + Narrative 生成 | 無 | ❌ 違反紅線 1 |

**關鍵收穫**：最具體可轉移的是 **amendment chain 的 diff UI**（紅/綠 inline diff），純 UI 改善，不動資料模型。

---

## 4. PlexTrac

> 來源：web research（2026-09-18 multi-model workflow）

### 工具定位
商業 cloud-based pentest reporting + exposure management 平台。服務 pentest firm/MSSP/企業安全團隊。核心是 findings → report 生命週期管理。

### 可參考模式

| 模式 | RedLog 相關性 | 評估 |
|------|-------------|------|
| Findings detail side drawer（點擊列 → 滑出面板） | 高 | ✅ **採納** — Timeline/Search/HTTP History 共用滑出式 detail drawer |
| Finding-first / asset-first dual lens toggle | 中 | ✅ **採納** — 改造為 Group By: Time / Target / Source 切換 |
| Runbooks（MITRE checklist + timestamped log） | 中 | ❌ 拒絕 — 違反被動擷取哲學，runbook 是「計畫做什麼」非「記錄發生什麼」 |
| Global multi-project dashboard | 無 | ❌ 違反紅線 2 |
| NarrativesDB / WriteupsDB | 低 | ❌ report-authoring tooling |
| Vuln scanner ingestion + dedup | 無 | 架構不同 |
| Workflow Automation Engine | 無 | ❌ 違反紅線 2 |

**關鍵收穫**：**side drawer detail pattern** 是跨工具最高價值 UI 模式。

---

## 5. AttackForge

> 來源：web research（2026-09-18 multi-model workflow）

### 工具定位
商業 multi-user pentest program management + reporting SaaS。面向 consultancy/MSSP/enterprise。覆蓋 engagement 全生命週期 + 2026 年新增 AI agent swarms + 60 MCP tools。

### 可參考模式

| 模式 | RedLog 相關性 | 評估 |
|------|-------------|------|
| Consolidated Export & Collaboration panel | 中 | ✅ **改造** — 統一匯出面板（去掉 Jira/ServiceNow sync） |
| Evidence ZIP bundling | 中 | ✅ **改善既有** — bundle-export.ts 已有，確保包含所有 sidecar 檔案 |
| Expandable inline rows（table 內展開） | 中 | 🔄 可用於 marker 歷史展開 |
| Attack Chain Canvas（MITRE-mapped） | 中 | ❌ 拒絕 — 敘事建構 = report gen；Timeline IS the attack chain |
| ReportGen 範本 DOCX | 無 | ❌ 違反紅線 1 |
| Engagement request/review/approve | 無 | ❌ 違反紅線 2 |
| AI agent swarms | 無 | ❌ 架構不同 |

**關鍵收穫**：統一匯出面板 + Evidence ZIP 完整性改善。

---

## 6. Faraday

> 來源：web research（2026-09-18 multi-model workflow）

### 工具定位
Open-source vulnerability management platform。80-90+ tool 匯入，workspace-scoped host/service/vulnerability 記錄，團隊協作 + 範本化報告。

### 可參考模式

| 模式 | RedLog 相關性 | 評估 |
|------|-------------|------|
| Console plugins vs. report plugins 分類 | 高 | ✅ **已有** — RedLog plugin 四角色（producer/mapper/enrichment/exporter）已更精細 |
| Command interception + auto tool-output parsing (faraday-cli) | 高 | ✅ **改造** — 擴展 loot-detector 管線為更豐富的結構化實體抽取 |
| Column-customizable table + saved filters | 中 | ✅ **採納** — FilterBar 加 saved presets + column config |
| Workspace 切換 | 中 | ✅ **已有** — ProjectPicker |
| Host → Service → Vuln 樹 | 中 | ❌ 拒絕為核心模型；target detail view + custom fields 取代 |
| Bulk edit via context menu | 低 | 與 amendment chain 衝突 |
| Bidirectional ticketing sync | 無 | ❌ 違反紅線 2 |
| Executive report generation | 無 | ❌ 違反紅線 1 |

**關鍵收穫**：command-output 結構化抽取是現有 capture pipeline 的自然延伸。

---

## 7. Reconmap

> 來源：web research（2026-09-18 multi-model workflow）

### 工具定位
Open-source browser-based security operations platform。面向 infosec team/MSSP，Docker 微服務架構。覆蓋 planning → task automation → vuln tracking → report。

### 可參考模式

| 模式 | RedLog 相關性 | 評估 |
|------|-------------|------|
| MCP server 暴露 engagement 資料給外部 LLM | 中 | ⚠️ **爭議項** — 採納 read-only query，拒絕 AI summary 回寫 |
| Cron-scheduled command automation | 低 | 活動協調 ≠ 被動擷取 |
| Evidence attachments（docs/screenshots） | 無 | RedLog 已更強（hash chain、自動截圖） |
| Client/contact management | 無 | ❌ 違反紅線 2 |
| Whitelabel report generation | 無 | ❌ 違反紅線 1 |

**關鍵收穫**：唯一值得深入討論的是 read-only MCP server 暴露 evidence data。

---

## 8. 工具生態全景 — 按 RedLog 核心定位分類

> §1-7 分析的都偏向 vulnerability management / report generation 那一端。
> 本節重新按 RedLog 的實際定位（**即時操作記錄 + evidence chain**）分類整個生態。

### 8.1 C2 框架內建操作日誌

C2 框架自帶的 operator logging 是最接近「即時記錄操作者行為」的功能，但鎖定在各自框架內部，無法跨工具使用。

| 工具 | 日誌能力 | 維護狀態 |
|------|---------|---------|
| **Cobalt Strike** | 每個 beacon 獨立 log（beacon_[id].log）、operator 身份 + timestamp、keystroke log、截圖瀏覽器（View→Screenshots）、Aggressor Script Events API | 商業，持續維護 |
| **Mythic** | Event Feed（server 全域活動）、每個 task/command 記錄 operator + timestamp、artifact/credential/file 追蹤、v4.0 加入 operation chat | 開源，持續維護（SpecterOps 生態） |
| **Sliver** | server-side implant 通訊 + operator command log、task queue history、**AsciiCast 互動 shell 錄影** | 開源，持續維護（Bishop Fox） |
| **Havoc** | TeamServer 集中式 operator command log、Event Viewer、但 BOF-only 執行的可見度較弱 | 開源，積極開發中 |
| **Covenant** | 追蹤 operation 期間產生的 Indicators，用於與 blue team 的 deconfliction | 開源，基本停滯 |

**與 RedLog 的關係**：C2 log 記錄「C2 框架內發生了什麼」，RedLog 記錄「操作者桌面上發生了什麼」（包含 C2 以外的所有活動）。兩者互補——RedLog 可以擷取 C2 的終端輸出但不依賴特定 C2。

### 8.2 Red Team 操作日誌工具

| 工具 | 定位 | 維護狀態 |
|------|------|---------|
| **Ghostwriter Oplog** | Ghostwriter 的 Oplog 子功能：即時 operator command log，可手動輸入或透過 REST API 從 C2 自動 push。**最接近 RedLog 的既有功能**，但依賴手動記錄或 C2 特定整合，非 OS-level 被動擷取 | 持續維護（SpecterOps），v6.3.0 |
| **ghostwriter-oplog-populate** | 自動將 C2 活動推送到 Ghostwriter Oplog 的 companion script | SpecterOps 維護 |
| **Red Team Guide Oplog 範本** | 非軟體——是產業標準的 oplog 格式規範（timestamp/operator/target/ATT&CK ID/command/result/detected） | 持續更新的 living doc |
| **Lair Framework** | Meteor/Node web app，scanner 資料聚合 + 輕量級 command log | 基本廢棄（~2016-2018） |

**關鍵觀察**：Ghostwriter Oplog 是唯一認真做「跨 C2 操作日誌」的工具，但它是 **pull 模型**（需要手動/API push），RedLog 是 **passive capture 模型**（OS-level 自動擷取）。這是根本性的架構差異。

### 8.3 紅隊 infra 監控與 artifact 處理

| 工具 | 定位 | 維護狀態 |
|------|------|---------|
| **RedELK** (Outflank) | 紅隊的「自有 SIEM」——聚合多個 C2/redirector 的 infra/traffic log 到 ELK，**偵測藍隊是否在調查紅隊基礎設施** | 開源，持續維護 |
| **Nemesis** (SpecterOps) | 攻擊性資料富化管線（「攻擊版 VirusTotal」）——從 CS/Mythic/Sliver 攝入 file/output，自動分類 secret/credential、解密 DPAPI | 開源，持續維護，v2.0 |

**與 RedLog 的關係**：RedELK 看的是「紅隊基礎設施的 traffic pattern」，Nemesis 處理的是「已擷取的 artifact」。RedLog 在這兩者上游——它記錄操作者做了什麼，產出的 artifact 可以餵給 Nemesis 處理。

### 8.4 通用終端錄影（合規/audit 用途）

| 工具 | 定位 | 維護狀態 |
|------|------|---------|
| **tlog** (Red Hat) | RHEL 內建 session recording，JSON 格式寫入 syslog/journal，支援 PCI-DSS/HIPAA/SOX 合規 | 持續維護，RHEL 8/9/10 |
| **Teleport** (Gravitational) | SSH/K8s/DB/RDP session proxy + 錄影 + audit log，完整回放 | 商業+開源核心，持續維護 |
| **CyberArk PSM / BeyondTrust** | 企業 PAM（Privileged Access Management），特權 session 錄影/監控 | 商業，持續維護 |
| **ContainerSSH** | 容器化 SSH session audit，asciicast 匯出到 S3 | 開源，持續維護 |

**與 RedLog 的關係**：這些工具為「合規 audit」設計——記錄管理員做了什麼以滿足法規。缺少 ATT&CK tagging、loot detection、OPSEC 狀態追蹤、perceptual screenshot dedup 等 pentest 特有功能。

### 8.5 Evidence integrity / 防竄改工具

| 工具 | 定位 | 維護狀態 |
|------|------|---------|
| **Evidence Collector** | 法律級截圖工具：SHA-256 hash + FreeTSA timestamp (.tsr)，用於 chain-of-custody | 活躍，法律鑑識用途 |
| **TrueScreen** | 認證級 evidence 平台：裝置驗證 + hash + timestamp + 數位簽名 | 商業，持續維護 |

**關鍵缺口**：**沒有**專門為 pentest evidence chain 設計的工具。這個空間被通用法律/數位鑑識工具佔據。RedLog 的 SHA-256 hash chain + OpenTimestamps 錨定是 pentest 領域首創。

### 8.6 紫隊 / Adversary Emulation 平台

| 工具 | 定位 | 維護狀態 |
|------|------|---------|
| **Vectr** (SecurityRisk Advisors) | 紫隊追蹤——MITRE ATT&CK 覆蓋率追蹤、campaign 管理 | 持續維護 |
| **SCYTHE** | 對手威脅模擬 + 紫隊平台，記錄 detection 結果（logged/alerted/blocked/defended） | 商業，持續維護 |
| **MITRE Caldera** | 自動化 adversary emulation，server-side 執行 + 稽核軌跡 | 開源，MITRE 維護 |
| **Prelude Operator** | 持續安全測試平台（BAS），桌面 C2 風格應用 | 持續維護 |
| **Atomic Red Team** (Red Canary) | ATT&CK technique 的 atomic test 集合（不是平台，是測試庫） | 開源，持續維護 |

**與 RedLog 的關係**：這些工具關注「測試了哪些 technique + 偵測結果如何」，RedLog 關注「執行過程中實際發生了什麼」。Vectr 的 technique 覆蓋率追蹤與 RedLog 的 auto-tagging + dual-lens grouping 提案有概念交集。

### 8.7 截圖自動化（偵察用途）

| 工具 | 定位 | 維護狀態 |
|------|------|---------|
| **gowitness** (SensePost) | 大規模 web URL 截圖工具，偵察用 | 開源，持續維護 |
| **EyeWitness** (RedSiege) | web 截圖 + server header + default cred 檢查，偵察用 | 開源，持續維護 |

**與 RedLog 的關係**：pre-engagement 偵察截圖 ≠ in-engagement evidence capture。完全不同的使用情境。

---

### 生態定位圖

```
                    被動擷取 ←————————————→ 主動協調
                         |                    |
    即時記錄        RedLog ●                  |
    (engagement      Ghostwriter Oplog ○      |
     中)             C2 內建 log ◐            |
                         |                    |
    infra 監控       RedELK ○            Caldera ○
                     Nemesis ○           SCYTHE ○
                         |               Vectr ○
                         |                    |
    合規 audit       tlog ○                   |
                     Teleport ○               |
                         |                    |
    Evidence         Evidence Collector ○     |
    integrity        TrueScreen ○             |
                         |                    |
    Post-engagement      |           Dradis ○ PlexTrac ○
    報告/VM              |           PwnDoc ○ AttackForge ○
                         |           Faraday ○ Reconmap ○
```

● = RedLog 佔據的位置（唯一：OS-level 被動擷取 + 防竄改 + cross-tool）
◐ = 部分重疊（C2 內建 log 在各自框架內很強）
○ = 鄰接但不同領域

### 關鍵結論

1. **RedLog 的「OS-level 被動擷取 + 防竄改 evidence chain + cross-tool」定位基本沒有直接競品**
2. 最接近的是 **Ghostwriter Oplog**，但它是 pull 模型（手動/API push），不是 passive capture
3. C2 框架的內建 logging 在各自框架內很強，但彼此隔離——RedLog 的價值在跨工具統一記錄
4. 通用 session recording（tlog/Teleport）缺少 pentest 領域特有功能
5. Evidence integrity 工具存在但非 pentest 原生
6. §1-7 分析的工具（Dradis/PlexTrac/AttackForge/Faraday/PwnDoc/Reconmap）全部落在 post-engagement 報告/VM 端，與 RedLog 互補而非競爭

---

## 跨工具三視角評估結果

> 方法：Opus（架構師）、Sonnet（實用主義者）、Haiku（懷疑論者）分別獨立評估 26 項功能

### 共識採納清單（P1-P2）

| 優先 | 功能 | 來源 | 難度 | 說明 |
|------|------|------|------|------|
| **P1** | Master-detail Timeline + side drawer | Ghostwriter + PlexTrac | 中 | 左欄事件列表 / 右欄 detail drawer，共用元件跨 Timeline/Search/HTTP History |
| **P1** | Dual-lens grouping toggle | PlexTrac + Faraday | 低 | Group By: Time / Target / Source 切換，純 view toggle |
| **P1** | Saved filter presets + column config | Faraday | 低-中 | FilterBar 加 saved presets、column visibility toggles |
| **P1** | Auto-tagging（has:evidence/recording/loot） | Ghostwriter | 低 | 虛擬 computed tags，零新基礎設施 |
| **P2** | Deep link per event | Ghostwriter | 低 | `redlog://event/<id>` + copy link 按鈕 |
| **P2** | Evidence ↔ Event 顯性連結 | Ghostwriter | 中 | event envelope 加 evidence_ids，雙向導航 |
| **P2** | Diff-style amendment 視覺化 | Dradis | 低 | MarkerDetail 加 History toggle，綠/紅 inline diff |
| **P2** | 統一匯出面板 | AttackForge | 低 | ExportMenu 升級為 modal/panel，格式卡 + scope 設定 |
| **P2** | 結構化 tool-output 抽取擴展 | Faraday | 中 | 擴展 plugin pipeline，nmap/nuclei/burp 結構化解析 |

### 共識已有清單

| 功能 | 說明 |
|------|------|
| Terminal recording + playback | 已有且更強（自動 .cast + cast-index + CastResults） |
| Evidence bundle export | bundle-export.ts 已有簽名打包，可增量改善完整性 |
| Plugin 分類架構 | 四角色 trust-tier 已更精細 |
| Command interception + MITRE tagging | shell hooks + command-tagger + technique-tagger |
| Project/workspace 管理 | ProjectPicker + shared filter state |

### 共識拒絕清單

| 功能 | 拒絕理由 |
|------|---------|
| 範本化 executive report generation | 紅線 1 最明確違反 |
| Runbooks / MITRE procedure checklists | 違反被動擷取哲學 — runbook 是「計畫做什麼」 |
| Attack Chain Canvas | 敘事建構 = report gen；Timeline 本身就是 attack chain |
| Retest rounds | 漏洞管理生命週期，非 logging |
| Custom Forms on workflow Actions | 工作流引擎 = 協調邏輯，非 logging |
| Node → Issue → Evidence 三層模型 | 漏洞分類模型（taxonomic），非時序 logging 模型（temporal） |
| Host → Service → Vuln 樹（核心模型） | SIEM/vuln-management 功能 |
| AI 生成摘要 | DESIGN-PRINCIPLES §3：不將解讀記錄為事實 |
| Log narrative auto-generation | walkthrough-export.ts 已是正確上限 |

### 爭議項目

| 功能 | 正方 | 反方 | 建議 |
|------|------|------|------|
| Read-only MCP server | 外部 LLM query evidence 有日常價值 | 會產生加 AI summary 的壓力 | ✅ 採納，嚴格限制 read-only，明確禁止 AI 文字回寫 event store |
| 本機 marker 範本 | 常見 finding 類型加速輸入 | 是 report template 的入口 | ⏸ 延後到 1.0 後，custom fields 先上 |
| 單操作員 checklist（精簡版 runbook） | MITRE 覆蓋率追蹤 | 違反被動擷取 | ❌ auto-tagging + dual-lens 已解決同樣需求 |
| Evidence ZIP 完整性增強 | bundle-export.ts 增量改善 | 已有 | ✅ 確認所有 sidecar 檔案都包含 |

---

## UI 改造提案摘要

> 以下為交給 Claude Design 的 UI/UX 設計輸入

### 1. Timeline 佈局（Timeline.tsx）
- **現狀**：單欄 swimlane + 底部 detail panel
- **提案**：水平 master-detail split（左 70% 事件列表 / 右 30% persistent detail drawer）
- **靈感**：Ghostwriter 雙欄 activity log、PlexTrac side drawer、email client pattern

### 2. FilterBar（FilterBar.tsx + FilterContext.tsx）
- **現狀**：三維度篩選（target/agentType/timeRange），暫態、不可儲存
- **提案**：saved presets + virtual tag filters（has:screenshot 等）+ Group By 控制 + column visibility
- **靈感**：Faraday structured filter bar、GitHub saved filters

### 3. MarkerDetail amendment 歷史（MarkerDetail.tsx）
- **現狀**：只顯示 effective（folded）值
- **提案**：History toggle 顯示 word-level diff（green/red inline），使用 markerFold.ts diffAgainst
- **靈感**：Dradis inline color-coded diff、GitHub PR diff

### 4. Event 列 badge + Deep link
- **現狀**：事件列無 evidence 指示器
- **提案**：小型 badge icon（📷 截圖 / 🎬 錄影 / 🔑 loot / 🔖 marker）+ 右鍵 Copy link
- **靈感**：Ghostwriter auto-tagging、Gmail attachment icon

### 5. 匯出面板（ExportMenu.tsx）
- **現狀**：下拉選單
- **提案**：Modal/panel，格式卡 + scope 設定 + size estimate
- **靈感**：AttackForge consolidated export、macOS export dialog

### 6. Target Detail View（TargetView.tsx）
- **現狀**：flat list → 點擊跳到 Timeline
- **提案**：展開式 detail panel（metadata + mini-timeline + 截圖縮圖 + marker 連結）
- **靈感**：Dradis consolidated node page、Faraday tabbed finding detail

---

## 9. Session Recording 工具技術設計深研

> §8.4 列出了通用 session recording 工具的生態定位。
> 本節深入研究 **tlog（Red Hat）、Teleport（Gravitational）、ContainerSSH、asciinema、CyberArk PSM、BeyondTrust** 的技術設計，
> 提煉 RedLog 可參考的 log 擷取/格式/查詢/效能模式。
> **核心關注**：log 本身——擷取方式、格式結構、查詢搜尋、效能控制。ATT&CK / evidence chain 是附加，不是重點。

### 9.1 擷取架構模式比較

三種主流擷取架構，各有 trade-off：

| 模式 | 代表工具 | 原理 | 優勢 | 限制 |
|------|---------|------|------|------|
| **Shell wrapper（login shell 替換）** | tlog | SSSD 將使用者 login shell 替換為 `tlog-rec-session`，在真正 shell 外包一層 PTY，透明中繼並記錄所有 I/O | 零 infra 改動、對使用者透明、單一策略控制點（SSSD conf scope=none/some/all） | root 可 bypass/kill wrapper；無法跨多 hop 追蹤；不感知 command 語意（只是 raw byte stream） |
| **Proxy 中間人** | Teleport | Proxy Service 終結 SSH/RDP 連線，解密後記錄再轉發到目標主機 | 集中錄製，目標主機不需安裝軟體；可管控所有流入流量 | MITM 信任模型（需 SSH agent forwarding）、Proxy 必須解密再加密（CPU 開銷）、正在被 `proxy-v2` gRPC 串流取代 |
| **Gateway 攔截** | ContainerSSH | SSH gateway 層攔截，可設定擷取粒度：connection/auth/SSH request/program execution，且 stdin/stdout/stderr 可**個別開關** | 精細控制（如關掉 stdin 避免擷取密碼）；容器化環境天然適配 | 限定容器化場景；不涵蓋 gateway 以外的操作 |

**第四種——eBPF 核心層補強**（Teleport Enhanced Session Recording）：

- 在 PTY 錄影之外，透過 3 支 eBPF 程式（execsnoop / opensnoop / tcpconnect）追蹤核心層級行為
- 使用 **cgroupv2 per-session** 歸因：每個 SSH session 在獨立 cgroup，eBPF 事件透過 cgroup ID 追溯到具體 session
- 產出結構化事件（`session.command` / `session.disk` / `session.network`），不取代 PTY 錄影而是補充
- 自我保護：載入 BPF 後用 seccomp-bpf 永久撤銷自身 `bpf()` syscall 能力

**RedLog 對照**：RedLog 不攔截 SSH——它在操作者本機 OS 層被動擷取（截圖 + 終端 I/O + shell hooks），更接近「桌面側 shell wrapper」但不替換 login shell。eBPF 的 **per-session cgroup 歸因**思路值得參考——RedLog 的 socket→pid→command resolver 在做類似的事（將 traffic 歸因到具體 session/command）。

### 9.2 Log 格式結構比較

| 工具 | 格式 | 結構 | 語意豐富度 | 編輯/裁剪友善度 |
|------|------|------|-----------|---------------|
| **tlog** | JSON（per-message） | `ver/host/rec/user/id/pos/time` + `in_txt/out_txt/in_bin/out_bin` + `timing`（ABNF 編碼 interleaving） | 低——不分 command/prompt/output，raw byte stream 按大小（2048B）和延遲（10s）切 chunk | 低——absolute `pos` ms offset，插入/刪除需重算後續所有 timestamp |
| **Teleport** | Protobuf event stream（gzip 壓縮，可加密） | 強型別事件（resize/input/output/exec/exit），每個事件有 `DelayMilliseconds` | 高——SSH=PTY+lifecycle events，Desktop=TDP messages with PNG frames，eBPF 補充 command/file/network 結構化事件 | 中——delta timing（ms since previous event），但 protobuf binary 不可直接手動編輯 |
| **ContainerSSH** | 雙格式：native binary + asciicast v2 | Binary=nanosecond timing、完整 metadata；Asciicast v2=ndjson `[time, type, data]` | Binary 高（分 stdin/stdout/stderr + request metadata）；Asciicast 低（丟失 stdin/stdout 分離、無 request metadata） | Binary 低（需專用 decoder）；Asciicast 中（JSON 但 absolute time） |
| **asciicast v2** | ndjson（header + events） | Header: `version/width/height/timestamp/env/theme`；Events: `[absolute_time_s, "o"/"i", data]` | 低——只有 output("o") 和 input("i") 兩種事件類型 | 低——absolute time，插入/刪除需重算所有後續 timestamp |
| **asciicast v3**（2025-09） | ndjson（header + events，不向下相容） | Header: `term:{cols,rows,type,version,theme}` + `tags[]`；Events: `[delta_time_s, type, data]` | 中——新增 `"m"` marker（書籤/章節）、`"r"` resize、`"x"` exit status；支援 `#` 行內註解 | **高**——**delta timing**（距上一事件的秒數），插入/刪除只影響相鄰事件，不需全局重算 |
| **CyberArk PSM** | RDP=`.avi` video / SSH=`.log` text | 非結構化；text search 需 opt-in indexer（RDP=OCR，SSH=literal text flag），不可追溯 | 低——已記錄的 session 無法事後索引 | N/A |
| **BeyondTrust** | 加密 video + 獨立 keystroke log | Video=pixel-accurate；Keystroke=結構化事件流（非 baked into video） | 中——keystroke 獨立可搜尋，不需 OCR | 中——keystroke 結構化但 video 不可編輯 |

**關鍵設計洞察**：

1. **雙軌格式策略**（compact binary for storage + standard replayable for humans）——ContainerSSH 和 Teleport（`tsh play --format json`）都這麼做。RedLog 的 `.cast` + event envelope 已是這個模式。
2. **asciicast v3 的 delta timing** 是一個重要演進：如果 RedLog 未來需要支援錄影裁剪/脫敏，delta timing 比 absolute timing 友善得多（Bresenham/error-diffusion rounding 避免 drift）。
3. **語意分離**很重要：tlog 把所有東西混在一個 byte stream（prompt + echo + output），無法事後分離。Teleport 用結構化事件（但 PTY 本身仍是 raw bytes，靠 eBPF 補充語意）。RedLog 的 shell hooks 已經在 command 層面做語意分離（command_start/command_end），比 tlog 強。
4. **Marker/章節標記**：asciicast v3 新增 `"m"` event type（命名書籤/章節點），和 RedLog 的 Marker 系統概念一致但實作層級不同（asciinema 是錄影層 marker，RedLog 是事件層 marker）。

### 9.3 查詢與搜尋設計

**這是所有 session recording 工具的共同弱點**——沒有任何工具提供完整的終端內容全文搜尋。

| 工具 | Metadata 查詢 | 終端內容搜尋 | 設計選擇 |
|------|-------------|------------|---------|
| **tlog** | journalctl 欄位匹配（`TLOG_REC=<id>`、user/host/time） | ❌ 無——只能 grep export 的 JSON | metadata-only |
| **Teleport** | Audit log JSON 結構化查詢（event type/user/session/time），Enhanced BPF 產出的 `session.command` 可結構化搜尋 | ❌ 無——confirmed open feature request（#11694），社群明確表示需要「找到四個月前跑過的那個指令」 | metadata + structured BPF events only |
| **ContainerSSH** | 程式化 `List()` / `OpenReader()` API | ❌ 無——decode 後自行 grep | 無索引 |
| **asciinema-server** | 標題/描述搜尋 | ✅ **有**——PostgreSQL native FTS（`tsvector/tsquery`），server-side 用 `avt` 虛擬終端引擎渲染/展平終端輸出後索引為純文字 | **唯一做到終端全文搜尋的工具** |
| **CyberArk PSM** | 分頁瀏覽（Web UI 25/page、REST API 100/page） + timeline scrubber | ⚠️ 條件式——需 opt-in indexer（SSH=literal text flag，RDP=OCR，~20-30% 額外儲存），不可追溯 | opt-in indexer, non-retroactive |
| **BeyondTrust** | protocol/date-range/quick-filter | ✅ keystroke 獨立搜尋（搜尋 keystroke 結構化事件流，不靠 OCR） | 雙軌：video 不可搜 + keystroke 結構化可搜 |
| **Segura (senhasegura)** | session metadata 篩選 | ✅ 混合——SSH=native text capture，RDP=Tesseract OCR (~90% accuracy)，統一併入「Session Texts」全文搜尋報告 | protocol-native text + OCR fallback → 統一 index |

**三種搜尋策略及其 trade-off**：

| 策略 | 原理 | 成本 | 適用場景 |
|------|------|------|---------|
| ① **展平 + DB FTS** | 用虛擬終端引擎渲染 session，展平為純文字，灌入 DB 全文索引（Postgres tsvector） | 低（最便宜可行路徑） | SSH/terminal-only（純文字 protocol） |
| ② **獨立結構化事件索引** | 索引獨立的 keystroke/command 事件流，而非 video/PTY bytes | 中 | 控制 client 端的 protocol（keystroke 可分離） |
| ③ **OCR** | 渲染螢幕 frame → 文字辨識 → 索引 | 高（20-30% 額外儲存，~90% accuracy，非追溯） | 只有 pixel-only protocol（RDP/VNC） |

**RedLog 對照**：RedLog 的 `cast-index` 已實作策略①（展平 .cast 內容做全文索引），這在整個生態中**只有 asciinema-server 做了同樣的事**。Teleport/tlog/ContainerSSH 都確認缺少這個能力。這是 RedLog 的一個真實差異化優勢。

### 9.4 Replay UI/UX 模式

| 模式 | 出處 | 說明 | RedLog 相關性 |
|------|------|------|-------------|
| **Timeline scrubber + jump-to-point** | CyberArk、asciinema player | 近乎通用的播放 UI：scrubber bar + 點擊跳到任意時間點 | ✅ asciinema-player 已有 |
| **Web player + 自適應 resize** | Cockpit（tlog）、asciinema-server | CLI player 無法 resize（tlog-play 必須匹配原始終端尺寸）；Web player 可自適應瀏覽器視窗 | ✅ RedLog 用 web-based xterm.js |
| **Playback speed 控制** | tlog-play（1/16x–16x）、`tsh play --speed` | CLI 有速度控制，但 Teleport Web UI **沒有**（idle time 會真實阻塞 Web player，GitHub #38560） | ⚠️ 確認 RedLog player 是否有速度控制 |
| **Skip idle** | `tsh play --skip-idle-time` | 跳過無活動時段，大幅縮短回放長度 | ✅ 值得確認/實作 |
| **Marker/章節導航** | asciicast v3 `"m"` event | 錄影內嵌具名書籤，播放時可直接跳到章節點 | ⭐ RedLog 的 Marker 已在事件層做到；可考慮在 recording player 內嵌 Marker timestamp 跳轉 |
| **分頁式 session 瀏覽** | CyberArk（25/page UI、100/page API） | 大規模下沒人做 infinite scroll——straight pagination + metadata filters | ✅ Timeline 已是 virtualized scroll |
| **Review/accountability** | BeyondTrust | 「Reviewed」狀態標記 + 審查者稽核軌跡 | ⏸ 合規用途，RedLog 暫不需要 |

**RedLog 已有 player 的優勢**：web-based xterm.js player + cast-index 全文搜尋，在回放體驗上已超越 tlog 和 Teleport。最值得補強的是：

1. **Marker → recording player 時間點跳轉**（Marker 帶 timestamp，player 可自動定位到 Marker 發生的瞬間）
2. **Skip idle / speed 控制**（如果還沒有的話）

### 9.5 效能與節流設計

#### Token-bucket 速率限制（tlog）

tlog 的核心效能機制，直接可參考：

| 參數 | 預設值 | 說明 |
|------|-------|------|
| `rate` | 16384 B/s | 穩態最大 logging 吞吐量 |
| `burst` | 32768 B | 允許的瞬間超額量 |
| `latency` | 10s | 緩衝多長時間再 flush 一條 log message |
| `payload` | 2048 B | 每條 JSON message 的最大 encoded payload |
| `action` | `delay` | 預算耗盡時行為：`delay`（背壓，終端變慢）/ `drop`（丟棄多餘資料）/ `pass`（停用限制） |

`delay` 模式下，`cat` 大檔案或高速 log scroll 會**可見地讓終端變慢**——這是有意為之的 trade-off（保護 log 管線 vs. 使用者體驗）。

#### Sync vs. Async 錄製模式（Teleport）

| 模式 | 行為 | 保證 | 風險 |
|------|------|------|------|
| `node-sync` / `proxy-sync` | 每個事件即時提交 Auth Service，傳輸失敗 = session 終止 | **零丟失**——no session without full logging | Auth 不可用 → session 中斷；需低延遲可靠連線 |
| `node` / `proxy`（async） | 本地磁碟緩衝，session 結束後上傳 | 容錯 Auth 暫時不可用 | 上傳前存在竄改窗口；需本地磁碟空間 |

Upload completer 每 5 分鐘掃描未完成上傳（30 分鐘 session-tracker 過期），crash recovery 最差 ~35 分鐘。

#### 分段策略（Teleport / 通用）

- Teleport 長 session 按 **5 分鐘切段**，gzip 壓縮 + 可選信封加密（RSA-OAEP 4096-bit）
- 通用 PAM 工具常見 50MB/5min 邊界，或硬 10MB 加密段
- 目的：**限制 replay 延遲**（不需下載整個多 GB 檔案才能 seek 到尾端）+ 限制單段損毀的影響範圍
- 單一無界限 session file 被視為 **anti-pattern**

#### 本地緩衝 fallback（通用）

- ContainerSSH：S3 multipart upload（5MB parts），local staging directory 作為 fallback/buffer
- Teleport async：寫入本地磁碟，session 結束後上傳
- **共識**：永遠有 local fallback，session 擷取絕不因 remote storage 不可用而中斷

**RedLog 對照**：RedLog 作為本機 Electron app，所有 log 天然寫入本地——沒有 remote storage 延遲問題。但以下模式值得參考：

1. **Token-bucket 節流**：RedLog 的 `ScreenshotAgent` 已有 perceptual dedup（dHash），但終端錄影（pty-recorder）沒有對高吞吐量終端輸出做節流設計。如果操作者 `cat` 大檔案，.cast 會瞬間膨脹。可參考 tlog 的 rate/burst/action 三參數模型。
2. **分段**：長 session 的 .cast 檔案不做分段，會影響 replay seek 效能和 cast-index 建構速度。5 分鐘或固定大小分段是值得考慮的方向。
3. **Sync/async 取捨**：若 RedLog 未來做 push-only log export（user 提過 ELK/Splunk/SIEM），Teleport 的 sync/async 模式是直接可參考的架構。

### 9.6 跨工具設計模式總結

以下提煉出 RedLog 最值得參考的設計模式，按「log 為核心」的視角排序：

| # | 模式 | 來源 | RedLog 行動 | 優先級 |
|---|------|------|-----------|--------|
| 1 | **展平終端 + DB FTS（全文搜尋）** | asciinema-server（PostgreSQL tsvector） | ✅ **已有**——cast-index 全文索引。生態中只有 asciinema-server 和 RedLog 做到 | — |
| 2 | **Delta timing** | asciicast v3 | 📝 注意——如果 RedLog 需要錄影裁剪/脫敏，delta timing 比 absolute timing 友善得多。目前 .cast 用 asciicast v2（absolute），v3 尚新 | P3 |
| 3 | **Per-stream toggle**（stdin/stdout 個別開關） | ContainerSSH | 📝 考慮——RedLog pty-recorder 是否能選擇性不記錄 stdin（避免記錄密碼輸入）？目前全錄 | P3 |
| 4 | **Token-bucket 速率限制** | tlog（rate/burst/latency/action） | ⚠️ 建議——pty-recorder 對高吞吐量輸出無節流，.cast 會膨脹 | P2 |
| 5 | **長 session 分段**（5min / 50MB 邊界） | Teleport、通用 PAM | ⚠️ 建議——長 session 的 .cast 是單一無界限檔案 | P2 |
| 6 | **Audit log / recording 分離** | Teleport | ✅ **已有**——event DB（輕量、可查詢）vs. .cast/.jpg（heavy blobs）已是分離架構 |  — |
| 7 | **Marker → player 時間跳轉** | asciicast v3 `"m"` event | ✅ 採納——Marker 帶 timestamp，player 可定位到 Marker 瞬間 | P2 |
| 8 | **eBPF cgroup 歸因** | Teleport Enhanced Session Recording | 📝 參考——RedLog 的 socket→pid→command resolver 在做類似歸因，eBPF 是更強力的替代方案（但需 Linux kernel ≥5.8、非跨平台） | P3 |
| 9 | **Sync/async export 模式** | Teleport | 📝 未來——push-only log export 到 ELK/SIEM 時的架構參考 | future |
| 10 | **雙軌格式**（compact binary + standard replayable） | ContainerSSH、Teleport | ✅ **已有**——event envelope + .cast 播放格式 | — |

### 9.7 確認的差異化優勢

經深入研究 6+ 工具後確認：

1. **終端全文搜尋**：生態中只有 asciinema-server 和 RedLog 做到。tlog / Teleport / ContainerSSH / CyberArk 都確認**沒有**這個能力。Teleport 社群明確表示這是需求（#11694），至今未實作。
2. **被動 OS-level 擷取 + cross-tool**：所有 session recording 工具都綁定特定 protocol（SSH/RDP/container），沒有任何工具做「操作者桌面上所有活動」的被動擷取。
3. **Shell 語意分離**：tlog 完全不分 command/prompt/output（raw byte stream）；Teleport 靠 eBPF 補充（需 Linux kernel ≥5.8）。RedLog 透過 shell hooks 在 command 層面已做到語意分離，不依賴 kernel 功能，跨平台。
4. **Perceptual screenshot dedup**：dHash 相似度過濾是 session recording 工具完全沒有的維度（它們只錄終端，不截圖）。
