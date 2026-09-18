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
