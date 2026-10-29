# Spec 索引

更新：2026-10-30；基準 `ae0544b5`。每個編號保留原目錄、tasks ID 與驗收歷史；本次不改 feature 狀態、不重新編號，也不以此索引代勾 tasks。

下一批與依賴見 [工作計畫](../docs/WORK-PLAN.md)；領域語意見 [domain](../docs/domain/glossary.md)。

## 狀態如何讀

目前 64 份：Verified 44、Implemented 5、Draft 13、Withdrawn 2。這是 spec.md 的宣告統計，不是重新驗證全部產品。

- `spec.md`：需求與正式狀態；`plan.md`：實作安排；`tasks.md`：執行項；`verification.md`／acceptance：測試及原生證據。部分舊 Draft 沒有完整 plan／tasks，先按現況補足而非增加平行 spec。
- Implemented 表示不能當成未實作重做；Draft 可包含已合併的局部實作。unchecked 代表整項尚未完成，不代表其中每個子步驟都沒有程式碼。
- Verified 的適用版本、平台與限制以該 verification 為準，不移植到新 build 或新平台；Withdrawn 不列待辦。
- 更新狀態須依專案 gate 及實際證據，僅有 CI 綠燈、文件整理或相關 issue 合併都不足以代替完整驗收。

## 當前與待對帳（047–064）

| Spec | 正式狀態 | 剩餘工作／接續方式 |
|---|---|---|
| [047 Capture Setup Wizard](047-capture-setup-wizard/spec.md) | Implemented | 主要實作存在；T010 Windows／WSL clean-host 原生驗收未完成。 |
| [048 Pane Target Derivation](048-pane-target-derivation/spec.md) | Draft | 舊 target 推導設計；先與 064 投影、target identity 對帳。 |
| [049 Capture Settings Information Architecture](049-capture-settings-ia/spec.md) | Draft | 設定分類已部分由 062／064 T024 承接；逐需求核對。 |
| [050 Per-Agent Capture Members](050-per-agent-capture-members/spec.md) | Implemented | 程式存在；未標 Verified，不能等同完整原生驗收。 |
| [051 Settings Scope Axis](051-settings-scope-axis/spec.md) | Draft | 機器／專案 scope axis 設計；核對現有儲存歸屬與 064 設定。 |
| [052 Terminal Auto-Capture](052-terminal-auto-capture/spec.md) | Draft | 自動擷取已有實作；T044 Kali shell upgrade、T045 首次設定／100 指令量測未齊。 |
| [053 Causal Graph View](053-causal-graph-view/spec.md) | Implemented | 可信 causal graph 已存在；不再恢復 host 聚合 API。 |
| [054 What Belongs in the Inspector's Header](054-inspector-header-scopes/spec.md) | Draft | Inspector 控制範圍設計；與 064 閱讀／導覽 parity 對帳。 |
| [055 Terminal Session Rotation Across a Project Switch](055-terminal-session-rotation/spec.md) | Implemented | 跨專案 terminal session rotation 已存在；保留原正式狀態。 |
| [056 Export the complete filtered evidence selection](056-filtered-evidence-export/spec.md) | Implemented | 完整 filtered export 已存在；T015 安裝包驗收仍開啟。 |
| [057 IP Verdict Display That Keeps the Policy's Distinctions](057-ip-verdict-display/spec.md) | Draft | IP verdict 區分提案；逐需求核對目前 alert/runtime/UI，不憑舊缺陷重做。 |
| [058 AI Session Folding](058-ai-session-folding/spec.md) | Draft | AI session folding 舊任務仍開啟；與 064 canonical projection／Transcript 核對後只補差額。 |
| [059 Recording-first setup](059-recording-first-setup/spec.md) | Draft | 外部終端與 HTTPS 設定切片；部分由 062／064 承接，保留契約。 |
| [060 低摩擦擷取設定與完整性呈現](060-capture-onboarding-clarity/spec.md) | Draft | 接入／完整性規格；部分由 062／064 承接，不建立另一套 wizard。 |
| [061 不中斷擷取的應用程式更新](061-capture-safe-updates/spec.md) | Draft | 安全更新有部分程式實作；未勾任務須核對，實際 defer／restart 驗收未齊。 |
| [062 紀錄工作流程與操作入口整合](062-recording-workflow-consolidation/spec.md) | Draft | 主工作流收斂；T008–013、T085／087–092 為剩餘驗收／視覺批次，含部分已實作。 |
| [063 Long recording preservation](063-long-recording-segments/spec.md) | Draft | 分段及匯出已有 Mac 證據；先對帳 T002–007 與 064 T007，不重做 rotation。 |
| [064 紀錄優先的工作區與操作流程](064-recording-first-workspace/spec.md) | Draft | 當前工作區整合；S1→S2→S3→S4，部分落地，跨閱讀面／導覽／平台 gate 尚未完成。 |


## 交付版本、驗收與主要追蹤

此表不從 spec 文件最近修改時間猜測「已實作版本」。未歸一的版本標為未彙整；具體候選以原 verification 為準。未經逐項對應，不宣告正式 Superseded。

| Spec | 已實作版本／候選 | 驗收與主要 Issue | 證據／承接關係 |
|---|---|---|---|
| 047 | 未彙整；依原紀錄，不推定未實作 | PARTIAL／NOT RUN：完整平台 gate 未齊；#226／434 | [verification](047-capture-setup-wizard/verification.md)；保留原契約 |
| 048 | 未彙整；依原紀錄，不推定未實作 | 待逐需求對帳；不新增 PASS；#317 | [spec](048-pane-target-derivation/spec.md)；062／064 部分承接；未正式取代 |
| 049 | 未彙整；依原紀錄，不推定未實作 | 待逐需求對帳；不新增 PASS；#435／298 | [spec](049-capture-settings-ia/spec.md)；062／064 部分承接；未正式取代 |
| 050 | 未彙整；依原紀錄，不推定未實作 | 待逐需求對帳；不新增 PASS；#435 | [spec](050-per-agent-capture-members/spec.md)；保留原契約 |
| 051 | 未彙整；依原紀錄，不推定未實作 | 待逐需求對帳；不新增 PASS；#435 | [spec](051-settings-scope-axis/spec.md)；062／064 部分承接；未正式取代 |
| 052 | 未彙整；依原紀錄，不推定未實作 | PARTIAL／NOT RUN：完整平台 gate 未齊；#288／296／226 | [verification](052-terminal-auto-capture/verification.md)；保留原契約 |
| 053 | 未彙整；依原紀錄，不推定未實作 | 待逐需求對帳；不新增 PASS；#317 | [spec](053-causal-graph-view/spec.md)；保留原契約 |
| 054 | 未彙整；依原紀錄，不推定未實作 | 待逐需求對帳；不新增 PASS；#317 | [spec](054-inspector-header-scopes/spec.md)；062／064 部分承接；未正式取代 |
| 055 | 未彙整；依原紀錄，不推定未實作 | 待逐需求對帳；不新增 PASS；#291 | [verification](055-terminal-session-rotation/verification.md)；保留原契約 |
| 056 | 未彙整；依原紀錄，不推定未實作 | PARTIAL／NOT RUN：完整平台 gate 未齊；#436／226 | [verification](056-filtered-evidence-export/verification.md)；保留原契約 |
| 057 | 未彙整；依原紀錄，不推定未實作 | 待逐需求對帳；不新增 PASS；#317 | [spec](057-ip-verdict-display/spec.md)；062／064 部分承接；未正式取代 |
| 058 | 未彙整；依原紀錄，不推定未實作 | 待逐需求對帳；不新增 PASS；#317 | [spec](058-ai-session-folding/spec.md)；062／064 部分承接；未正式取代 |
| 059 | 未彙整；依原紀錄，不推定未實作 | PARTIAL／NOT RUN：完整平台 gate 未齊；#434／289 | [verification](059-recording-first-setup/verification.md)；062／064 部分承接；未正式取代 |
| 060 | 未彙整；依原紀錄，不推定未實作 | PARTIAL／NOT RUN：完整平台 gate 未齊；#434／289／435 | [spec](060-capture-onboarding-clarity/spec.md)；062／064 部分承接；未正式取代 |
| 061 | 未彙整；依原紀錄，不推定未實作 | PARTIAL／NOT RUN：完整平台 gate 未齊；#317（062 T012） | [spec](061-capture-safe-updates/spec.md)；保留原契約 |
| 062 | 局部切片已到 ae0544b5；原生候選另綁版本 | PARTIAL／NOT RUN：完整平台 gate 未齊；#317／298／434／435／436 | [verification](062-recording-workflow-consolidation/verification.md)；保留原契約 |
| 063 | 局部切片已到 ae0544b5；原生候選另綁版本 | PARTIAL／NOT RUN：完整平台 gate 未齊；#290／291／296 | [verification](063-long-recording-segments/verification.md)；保留原契約 |
| 064 | 局部切片已到 ae0544b5；原生候選另綁版本 | PARTIAL／NOT RUN：完整平台 gate 未齊；#317／291／436／457 | [verification](064-recording-first-workspace/verification.md)；保留原契約 |

001–046 的已交付版本與驗收依各 feature 原 verification（索引正式狀態表），不從後來的 code snapshot 批次回填。

## 早期規格（001–046）

以下已 Verified 或 Withdrawn，保留原 verification；後續缺陷回原契約修復，不把所有舊規格重新排程。020 report mode、041 session target binding 已撤回，分別不是待做功能；041 的後續設計見 048。

| Spec | 正式狀態 |
|---|---|
| [001 Trustworthy Export Preview and Execution](001-export-plan-consistency/spec.md) | Verified |
| [002 Scope and Spool Isolation](002-scope-and-spool-isolation/spec.md) | Verified |
| [003 Canonical In-Process Event Ingest](003-canonical-event-ingest/spec.md) | Verified |
| [004 Usable External-Shell Output Capture](004-external-shell-output/spec.md) | Verified |
| [005 Shell Adapter Boundaries](005-shell-adapter-boundaries/spec.md) | Verified |
| [006 Pre-release Contract Reset](006-pre-release-contract-reset/spec.md) | Verified |
| [007 Shared Event Filter](007-shared-event-filter/spec.md) | Verified |
| [008 Search Result Integrity](008-search-result-integrity/spec.md) | Verified |
| [009 Transcript Completeness](009-transcript-completeness/spec.md) | Verified |
| [010 HTTP Flow Query](010-http-flow-query/spec.md) | Verified |
| [011 Loot Projection Completeness](011-loot-projection-completeness/spec.md) | Verified |
| [012 Terminal Resize Fidelity](012-terminal-resize-fidelity/spec.md) | Verified |
| [013 HTTP Body Search](013-http-body-search/spec.md) | Verified |
| [014 Event Causal Chain](014-event-causal-chain/spec.md) | Verified |
| [015 Active Target Context](015-active-target-context/spec.md) | Verified |
| [016 Command Artifact Linking](016-command-artifact-linking/spec.md) | Verified |
| [017 Shared Event Query Language](017-shared-event-query-language/spec.md) | Verified |
| [018 Search on the Shared Query Contract](018-search-query-migration/spec.md) | Verified |
| [019 Managed HTTP Capture](019-managed-http-capture/spec.md) | Verified |
| [020 Report Mode (withdrawn)](020-report-mode/spec.md) | Withdrawn |
| [021 Personal Traffic Visibility](021-personal-traffic-visibility/spec.md) | Verified |
| [022 Explicit External Session Recording](022-external-session-recorder/spec.md) | Verified |
| [023 One Scope Classifier](023-one-scope-classifier/spec.md) | Verified |
| [024 Alerts Without Correlation](024-alert-without-correlation/spec.md) | Verified |
| [025 One Secret Pattern Table](025-one-secret-pattern-table/spec.md) | Verified |
| [026 Every Search on the Query Contract](026-every-search-on-the-contract/spec.md) | Verified |
| [027 Remove the Plugin Code Host](027-remove-plugin-code-host/spec.md) | Verified |
| [028 One Retention Model](028-one-retention-model/spec.md) | Verified |
| [029 Tailer Naming](029-tailer-naming/spec.md) | Verified |
| [030 Architecture Gate — Every Export Reachable](030-architecture-gate/spec.md) | Verified |
| [031 Loot Detection Correctness](031-loot-correctness/spec.md) | Verified |
| [032 Loot Rule Switches](032-loot-rule-switches/spec.md) | Verified |
| [033 Loot Rule Time Bound](033-loot-regex-time-bound/spec.md) | Verified |
| [034 Settings Search, Type Names, Clock Meaning](034-operator-words/spec.md) | Verified |
| [035 Capture Packs — Essential Capture Built In, the Rest as Packs](035-capture-packs/spec.md) | Verified |
| [036 Install and Upgrade Readiness](036-install-and-upgrade-readiness/spec.md) | Verified |
| [037 First-Engagement Onboarding](037-first-engagement-onboarding/spec.md) | Verified |
| [038 Timeline on the Shared Filter](038-timeline-shared-filter/spec.md) | Verified |
| [039 Capture Verification Contract](039-capture-verification/spec.md) | Verified |
| [040 Export Attachment Selection](040-export-attachment-selection/spec.md) | Verified |
| [041 Session Target Binding (withdrawn)](041-session-target-binding/spec.md) | Withdrawn |
| [042 Shell Output Canary](042-shell-output-canary/spec.md) | Verified |
| [043 Local Evidence Files](043-local-evidence-files/spec.md) | Verified |
| [044 Transcript Step Picks](044-transcript-step-picks/spec.md) | Verified |
| [045 Capture Browser Silence](045-capture-browser-silence/spec.md) | Verified |
| [046 UI/UX Audit Remediation](046-uiux-audit-remediation/spec.md) | Verified |

## 檔案放置

- feature 目錄固定 `NNN-slug/`，不移到新分類資料夾；編號與腳本／Git 歷史保持穩定。
- 單一 feature 的合約、checklist、實測與 evidence 留在該目錄；跨 feature 的當次紀錄放 [docs/records](../docs/records/README.md)。
- 既有 spec 已能承接的差額追加原 tasks／verification，不因每次審查另建編號。
- 本索引只管導覽與正式狀態快照；執行明細以各目錄為準。狀態變更時同步此表，不在本表再抄一份所有 task checkboxes。
