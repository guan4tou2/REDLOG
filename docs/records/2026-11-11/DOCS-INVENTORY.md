# 文件盤點（2026-11-11）

> 日期紀錄：`main@9f60882d` 整理前的 `docs/` 與根目錄 Markdown。整理後的規則見 [文件入口](../../README.md)，現況見 [CURRENT-STATUS](../../CURRENT-STATUS.md)，下一步見 [WORK-PLAN](../../WORK-PLAN.md)。

- 行數與「最後提交」取自整理前的檔案（`git log -1 --format=%cs`）。
- 「引用者」是整理前全 repo 對檔名的 grep 計數（排除 `node_modules`、`out`、`.git`；比對時檔名前不得緊接英數字或 `-`、`_`），按頂層目錄分組；`README.md` 同名太多，不計。
- 「時效」只有標「抽查」或「本次」的列在這次對照過程式；其餘是文件自述或其日期，未重新核對。
- 「去處」是 2026-11-11 `git mv` 後的位置。

| 原路徑 | 行數 | 最後提交 | 類型 | 時效 | 引用者 | 去處 |
|---|---|---|---|---|---|---|
| AGENTS.md | 77 | 2026-11-07 | reference（agent 規則） | current | specs 3、CHANGELOG.md 1、CLAUDE.md 1、test 1、docs 1、e2e 1 | 原位 |
| CHANGELOG.md | 5836 | 2026-11-04 | release note（累積） | current；不隨搬移改寫 | specs 4、docs 4、README.md 1 | 原位 |
| CLAUDE.md | 304 | 2026-11-07 | reference（工作規則） | current | docs 9、specs 6、e2e 2、AGENTS.md 1、test 1、.claude 1 | 原位 |
| README.md | 523 | 2026-11-10 | manual（專案入口） | current；快捷鍵表（Cmd+1..8、Cmd+/ 為搜尋）與 `lib/shortcuts.ts` 不一致，外掛「isolated process」敘述與 Spec 027 及 `src/core/plugins/` 不一致，VPS 敘述未逐項核對；由另一 PR 處理 | （索引頁，略） | 原位 |
| docs/ALERT-ROLES.md | 726 | 2026-09-21 | standard | current；未重新核對 | docs 7、specs 3、src 3、CHANGELOG.md 1 | 原位 |
| docs/ARCHITECTURE.md | 215 | 2026-10-30 | reference（架構） | current；本次核對路徑與頂層區域並修正 | docs 5、specs 2、CHANGELOG.md 1、README.md 1、test 1、src 1 | 原位 |
| docs/AUDIT-2026-08-08.md | 411 | 2026-08-10 | audit | dated snapshot（v0.9.3） | docs 3、CHANGELOG.md 1、e2e 1 | `docs/records/2026-08-08/AUDIT-2026-08-08.md` |
| docs/AUDIT-2026-09-18-RESPONSE.md | 186 | 2026-09-18 | audit | dated snapshot | docs 1 | `docs/records/2026-09-18/AUDIT-2026-09-18-RESPONSE.md` |
| docs/AUDIT-2026-09-18-app-ai-log.md | 165 | 2026-09-22 | audit | dated snapshot | docs 2 | `docs/records/2026-09-18/AUDIT-2026-09-18-app-ai-log.md` |
| docs/AUDIT-2026-09-19-current-findings.md | 240 | 2026-09-22 | audit | dated snapshot（`82183f1`） | docs 1 | `docs/records/2026-09-19/AUDIT-2026-09-19-current-findings.md` |
| docs/AUDIT-2026-09-19-engineering-methods.md | 424 | 2026-09-23 | audit | dated snapshot（`d5d9b46`） | docs 1 | `docs/records/2026-09-19/AUDIT-2026-09-19-engineering-methods.md` |
| docs/CURRENT-STATUS.md | 17 | 2026-10-30 | status | 當時停在 2026-10-30；本次更新 | docs 3 | 原位 |
| docs/DESIGN-E1-target-extractor-plugins.md | 93 | 2026-09-23 | design-current | current（已實作）；抽查 | plugins 1、src 1 | `docs/design/DESIGN-E1-target-extractor-plugins.md` |
| docs/DESIGN-OPEN-ITEMS.md | 227 | 2026-10-30 | design-historical | superseded by WORK-PLAN 與 specs（自述 backlog 已清空） | docs 3、src 2、test 1 | `docs/archive/DESIGN-OPEN-ITEMS.md` |
| docs/DESIGN-PRINCIPLES.md | 197 | 2026-09-29 | design-current | current；§1 superseded by DESIGN-core-and-capture | docs 10、AGENTS.md 1 | `docs/design/DESIGN-PRINCIPLES.md` |
| docs/DESIGN-capture-trust.md | 257 | 2026-10-24 | design-current | current §1–§11；§12 dated snapshot | docs 1 | `docs/design/DESIGN-capture-trust.md` |
| docs/DESIGN-core-and-capture.md | 458 | 2026-10-05 | design-current | current；未重新核對（另一 PR 修改中） | src 16、test 9、docs 7、specs 2、e2e 2、hooks 1 | `docs/design/DESIGN-core-and-capture.md` |
| docs/DESIGN-logged-tier-retention.md | 825 | 2026-09-23 | design-current | current（已實作；自述 Status: proposed 已過時）；抽查 | src 4、CHANGELOG.md 1、test 1 | `docs/design/DESIGN-logged-tier-retention.md` |
| docs/DESIGN-plugin-kernel.md | 172 | 2026-09-06 | design-current | current（方向）；未重新核對 | src 7、docs 4、test 2、specs 1、scripts 1 | `docs/design/DESIGN-plugin-kernel.md` |
| docs/DESIGN-project-runtime.md | 191 | 2026-11-01 | design-current | current §1–§3；§4 dated snapshot | src 3、test 2、docs 1 | `docs/design/DESIGN-project-runtime.md` |
| docs/DESIGN-traffic-attribution.md | 136 | 2026-09-07 | design-current | current；抽查 | docs 3、test 2、plugins 2、src 2、hooks 1 | `docs/design/DESIGN-traffic-attribution.md` |
| docs/DESIGN-traffic-capture.md | 372 | 2026-09-26 | design-current | current；抽查 | docs 2 | `docs/design/DESIGN-traffic-capture.md` |
| docs/DESIGN-two-tier-chain.md | 869 | 2026-10-01 | design-current | current（已實作；自述 Status: proposed 已過時）；抽查 | test 4、src 4、CHANGELOG.md 1、docs 1 | `docs/design/DESIGN-two-tier-chain.md` |
| docs/INTERNAL-TESTING.md | 54 | 2026-11-01 | manual | current；未重新核對 | docs 4 | 原位 |
| docs/ISSUE-SPEC-REVIEW.md | 15 | 2026-11-05 | dated record（issue／spec 檢查） | dated snapshot（`f51037e0`） | docs 1 | `docs/records/2026-11-04/ISSUE-SPEC-REVIEW.md` |
| docs/LAYOUT-RELIABILITY.md | 97 | 2026-11-10 | standard | current；未重新核對 | specs 2、docs 1 | 原位 |
| docs/PACKAGED-SMOKE.md | 412 | 2026-10-31 | reference（測試） | current；未重新核對 | docs 9、specs 2、CHANGELOG.md 1 | 原位 |
| docs/PERF-AUDIT-2026-11.md | 534 | 2026-11-02 | audit（效能量測） | dated snapshot（`07a32ee4`，2026-11-01） | test 1、specs 1、src 1 | `docs/records/2026-11-01/PERF-AUDIT-2026-11.md` |
| docs/PLUGIN-MANAGEMENT-SPEC.md | 76 | 2026-11-05 | plan（提案） | dated snapshot；由 Spec 065–067 承接 | docs 2 | `docs/records/2026-11-04/PLUGIN-MANAGEMENT-SPEC.md` |
| docs/PRODUCT-POSITIONING.md | 197 | 2026-10-26 | reference（定位） | current；未重新核對 | docs 9 | 原位 |
| docs/PROJECT-STARTUP-IMPLEMENTATION-PLAN.md | 39 | 2026-11-05 | plan | dated snapshot（2026-11-04） | docs 2 | `docs/records/2026-11-04/PROJECT-STARTUP-IMPLEMENTATION-PLAN.md` |
| docs/PROJECT-STARTUP-VERIFICATION-2026-11-04.md | 34 | 2026-11-05 | dated record（驗證） | dated snapshot | docs 2 | `docs/records/2026-11-04/PROJECT-STARTUP-VERIFICATION-2026-11-04.md` |
| docs/README.md | 52 | 2026-11-07 | reference（索引） | current；本次改寫 | （索引頁，略） | 原位 |
| docs/RELEASE-SMOKE-TEST.md | 81 | 2026-10-24 | reference（發布） | current；未重新核對 | specs 7、docs 3、CHANGELOG.md 1、.specify 1 | 原位 |
| docs/RELEASE-v0.18.1.md | 32 | 2026-10-16 | release note | 該版發布當時 | 無 | 原位（`release.yml` 以此路徑作 release body） |
| docs/RELEASE-v0.18.2.md | 36 | 2026-10-16 | release note | 該版發布當時 | 無 | 原位（`release.yml` 以此路徑作 release body） |
| docs/RELEASE-v0.18.3.md | 38 | 2026-10-16 | release note | 該版發布當時 | 無 | 原位（`release.yml` 以此路徑作 release body） |
| docs/RELEASE-v0.18.4.md | 32 | 2026-10-29 | release note | 該版發布當時 | docs 2 | 原位（`release.yml` 以此路徑作 release body） |
| docs/RELEASE-v0.18.5.md | 44 | 2026-10-31 | release note | 該版發布當時 | 無 | 原位（`release.yml` 以此路徑作 release body） |
| docs/RELEASE-v0.18.6.md | 50 | 2026-11-01 | release note | 該版發布當時 | 無 | 原位（`release.yml` 以此路徑作 release body） |
| docs/RELEASE_CHECKLIST.md | 44 | 2026-10-16 | reference（發布） | current；未重新核對 | docs 3、CHANGELOG.md 1 | 原位 |
| docs/RESEARCH-onboarding-references.md | 140 | 2026-09-30 | research | 研究筆記（2026-09-29） | 無 | `docs/research/RESEARCH-onboarding-references.md` |
| docs/RESEARCH-tool-design-analysis.md | 626 | 2026-09-18 | research | 研究筆記（2026-09-18） | docs 1 | `docs/research/RESEARCH-tool-design-analysis.md` |
| docs/TESTING.md | 240 | 2026-11-10 | reference（測試） | current；未重新核對 | specs 18、docs 7、test 6、src 5、e2e 1 | 原位 |
| docs/TOKEN-SAVING-TOOLS.md | 65 | 2026-11-07 | reference（agent 工具規則） | current；評估日期 2026-11-07 | CLAUDE.md 1 | 原位 |
| docs/UIUX-CAPTURE-FIX-VERIFICATION.md | 20 | 2026-11-05 | dated record（驗證） | dated snapshot（2026-11-04） | docs 1 | `docs/records/2026-11-04/UIUX-CAPTURE-FIX-VERIFICATION.md` |
| docs/UIUX-CONTROLS-AND-COPY.md | 254 | 2026-11-07 | standard | superseded by UIUX-STANDARD §25（自述）；因 src 註解與 agent 指示引用而留在根目錄 | src 4、docs 1 | 原位 |
| docs/UIUX-DESIGN-IMPLEMENTATION-MATRIX.md | 112 | 2026-11-07 | status（差異矩陣） | dated snapshot（`9ca36509`）；「設定五組」與程式不符 | 無 | `docs/records/2026-11-07/UIUX-DESIGN-IMPLEMENTATION-MATRIX.md` |
| docs/UIUX-FLOW-IMPROVEMENT-ANALYSIS.md | 108 | 2026-11-05 | plan（分析） | dated snapshot（`f51037e0`） | docs 1 | `docs/records/2026-11-04/UIUX-FLOW-IMPROVEMENT-ANALYSIS.md` |
| docs/UIUX-FORENSIC-EDITORIAL.md | 158 | 2026-11-07 | design-current | draft（自述）；「Settings 五分類」與程式不符 | specs 3、docs 3 | `docs/design/UIUX-FORENSIC-EDITORIAL.md` |
| docs/UIUX-RECHECK-2026-11-04.md | 33 | 2026-11-07 | dated record（重新核對） | dated snapshot（`f51037e0`） | docs 1 | `docs/records/2026-11-04/UIUX-RECHECK-2026-11-04.md` |
| docs/UIUX-REMAINING-IMPLEMENTATION-PLAN.md | 101 | 2026-11-05 | plan | dated snapshot；未完成項併入 WORK-PLAN | docs 2 | `docs/records/2026-11-04/UIUX-REMAINING-IMPLEMENTATION-PLAN.md` |
| docs/UIUX-STANDARD.md | 728 | 2026-11-10 | standard | current；UX-006 與建立專案的現有能力不一致，由另一 PR 處理 | src 24、specs 14、docs 12、test 10、.github 4、.claude 2、AGENTS.md 1、CLAUDE.md 1、design 1、tools 1、scripts 1 | 原位 |
| docs/UIUX-SYNC-STATUS.md | 34 | 2026-11-05 | status | dated snapshot（`eaa40e46`，2026-11-05） | docs 9 | `docs/records/2026-11-05/UIUX-SYNC-STATUS.md` |
| docs/USER-GUIDE.md | 277 | 2026-11-07 | manual | current；側欄／快捷鍵表與程式不一致，由另一 PR 處理 | docs 2、README.md 1、specs 1 | 原位 |
| docs/UX-AUDIT-2026-08.md | 176 | 2026-08-10 | audit | dated snapshot（v0.11.5） | docs 7 | `docs/records/2026-08-10/UX-AUDIT-2026-08.md` |
| docs/WINDOWS_COMPAT_AUDIT.md | 337 | 2026-08-18 | audit | dated snapshot（2026-08-01，2026-08-18 補記） | src 4、docs 3、CHANGELOG.md 1 | `docs/records/2026-08-01/WINDOWS_COMPAT_AUDIT.md` |
| docs/WORK-PLAN.md | 110 | 2026-11-07 | plan | 2026-10-30；本次補記 | docs 7、specs 5、README.md 1 | 原位 |
| docs/agent-integration.md | 380 | 2026-11-10 | reference | current；未重新核對 | docs 7、specs 3、README.md 1 | 原位 |
| docs/agent-routing.md | 53 | 2026-11-03 | reference（agent 分工） | current；未重新核對 | 無 | 原位 |
| docs/api-reference.md | 344 | 2026-09-29 | reference | current；未重新核對 | specs 3、docs 1 | 原位 |
| docs/archive/CAPTURE-SOURCE-TAXONOMY.md | 193 | 2026-09-06 | design-historical | 已封存（見 archive 索引） | docs 7 | 原位 |
| docs/archive/CONTROL-PLANE-FACES.md | 95 | 2026-09-06 | design-historical | 已封存（見 archive 索引） | docs 3 | 原位 |
| docs/archive/DECOMPOSITION-BACKLOG.md | 160 | 2026-09-06 | design-historical | 已封存（見 archive 索引） | docs 3 | 原位 |
| docs/archive/DECOMPOSITION-METHOD.md | 88 | 2026-09-06 | design-historical | 已封存（見 archive 索引） | docs 9 | 原位 |
| docs/archive/DELIVERY-TARGETS.md | 96 | 2026-09-06 | design-historical | 已封存（見 archive 索引） | docs 3 | 原位 |
| docs/archive/DESIGN-SYSTEM-REFACTOR.md | 218 | 2026-09-23 | design-historical | 已封存（見 archive 索引） | docs 1 | 原位 |
| docs/archive/DESIGN-TIMELINE-INTERACTION.md | 213 | 2026-09-23 | design-historical | 已封存（見 archive 索引） | docs 1 | 原位 |
| docs/archive/DETECTOR-ROLES.md | 142 | 2026-09-06 | design-historical | 已封存（見 archive 索引） | docs 4 | 原位 |
| docs/archive/DEV-REQUIREMENTS-capture-onboarding.md | 160 | 2026-09-23 | design-historical | 已封存（見 archive 索引） | docs 6 | 原位 |
| docs/archive/EVENT-TYPE-VOCABULARY.md | 101 | 2026-09-06 | design-historical | 已封存（見 archive 索引） | docs 4 | 原位 |
| docs/archive/HANDOVER-2026-09.md | 205 | 2026-09-23 | design-historical | 已封存（見 archive 索引） | docs 4 | 原位 |
| docs/archive/OFF-CHAIN-CONTENT-STORES.md | 105 | 2026-09-06 | design-historical | 已封存（見 archive 索引） | docs 2 | 原位 |
| docs/archive/PLUGIN-ROLES.md | 266 | 2026-09-06 | design-historical | 已封存（見 archive 索引） | docs 5 | 原位 |
| docs/archive/PRD-COMPLETION.md | 190 | 2026-09-23 | design-historical | 已封存（見 archive 索引） | docs 3 | 原位 |
| docs/archive/README.md | 49 | 2026-10-30 | design-historical | 已封存（見 archive 索引） | （索引頁，略） | 原位 |
| docs/archive/ROADMAP.md | 196 | 2026-09-23 | design-historical | 已封存（見 archive 索引） | docs 9、specs 2、CHANGELOG.md 1 | 原位 |
| docs/archive/SPEC-AI-ERA-PLUGINS.md | 139 | 2026-09-06 | design-historical | 已封存（見 archive 索引） | docs 2 | 原位 |
| docs/archive/SPEC-IO-SIDECAR.md | 163 | 2026-09-06 | design-historical | 已封存（見 archive 索引） | docs 3 | 原位 |
| docs/archive/SPEC-SCOPE-AWARE-LIFECYCLE.md | 217 | 2026-09-06 | design-historical | 已封存（見 archive 索引） | docs 10 | 原位 |
| docs/archive/SPEC-TIMELINE-AXIS.md | 163 | 2026-09-06 | design-historical | 已封存（見 archive 索引） | docs 3 | 原位 |
| docs/archive/TEST-MATRIX-2026-10-16.md | 829 | 2026-10-16 | design-historical | 已封存（見 archive 索引） | docs 2 | 原位 |
| docs/archive/TIMELINE-ELEMENTS.md | 120 | 2026-09-06 | design-historical | 已封存（見 archive 索引） | docs 4 | 原位 |
| docs/archive/UX-BACKLOG-TICKETS.md | 268 | 2026-09-23 | design-historical | 已封存（見 archive 索引） | docs 6 | 原位 |
| docs/archive/UX-TIMELINE-2026-08.md | 122 | 2026-09-23 | design-historical | 已封存（見 archive 索引） | docs 6 | 原位 |
| docs/archive/timeline-io-visibility.md | 223 | 2026-09-23 | design-historical | 已封存（見 archive 索引） | docs 3、CHANGELOG.md 1、specs 1 | 原位 |
| docs/audit-trail.md | 186 | 2026-09-29 | reference | current；未重新核對 | docs 10、CHANGELOG.md 1、README.md 1 | 原位 |
| docs/design-project-sync.md | 346 | 2026-09-23 | reference（設計同步） | current；同步日期見原文 | docs 4、design 1 | 原位 |
| docs/domain/INVENTORY-query-completeness.md | 290 | 2026-09-24 | reference（領域契約） | current（constitution 指定）；未重新核對 | specs 5 | 原位 |
| docs/domain/SPEC-capture-source-lifecycle.md | 257 | 2026-10-26 | reference（領域契約） | current（constitution 指定）；未重新核對 | specs 10、docs 4、.specify 1 | 原位 |
| docs/domain/SPEC-export-event-selection.md | 196 | 2026-10-25 | reference（領域契約） | current（constitution 指定）；未重新核對 | specs 18、docs 3、src 1 | 原位 |
| docs/domain/SPEC-scope-evaluation.md | 175 | 2026-09-24 | reference（領域契約） | current（constitution 指定）；未重新核對 | specs 4、docs 2 | 原位 |
| docs/domain/SPEC-search-query-semantics.md | 289 | 2026-10-28 | reference（領域契約） | current（constitution 指定）；未重新核對 | specs 9、docs 4、src 1 | 原位 |
| docs/domain/SPEC-target-identity.md | 151 | 2026-10-05 | reference（領域契約） | current（constitution 指定）；未重新核對 | specs 11、docs 3、src 1 | 原位 |
| docs/domain/glossary.md | 66 | 2026-10-26 | reference（領域契約） | current（constitution 指定）；未重新核對 | specs 9、docs 4、.specify 1 | 原位 |
| docs/event-schema.md | 417 | 2026-11-01 | reference | current；未重新核對 | docs 10、CHANGELOG.md 1、README.md 1、specs 1 | 原位 |
| docs/external-session-recording.md | 36 | 2026-10-24 | manual | current；未重新核對 | docs 2、README.md 1 | 原位 |
| docs/plugin-development.md | 477 | 2026-11-10 | reference | current；外掛隔離敘述待另一 PR | docs 8、specs 2、CHANGELOG.md 1、README.md 1、src 1 | 原位 |
| docs/records/2026-10-29/ACCEPTANCE-326-345-2026-10-29.md | 61 | 2026-10-30 | dated record | dated snapshot | docs 3 | 原位 |
| docs/records/2026-10-29/ACCEPTANCE-RUN-2026-10-29.md | 118 | 2026-10-30 | dated record | dated snapshot | docs 1 | 原位 |
| docs/records/2026-10-29/ISSUE-CONVERGENCE-2026-10-29.md | 961 | 2026-10-30 | dated record | dated snapshot | docs 3 | 原位 |
| docs/records/2026-10-29/REVIEW-2026-10-29.md | 158 | 2026-10-30 | dated record | dated snapshot | docs 2 | 原位 |
| docs/records/2026-10-29/REVIEW-FOLLOWUP-2026-10-29.md | 69 | 2026-10-30 | dated record | dated snapshot | docs 3、specs 1 | 原位 |
| docs/records/2026-10-29/TRACEABILITY-2026-10-29.md | 55 | 2026-10-30 | dated record | dated snapshot | docs 1 | 原位 |
| docs/records/2026-10-29/UIUX-COMPLETION-2026-10-29.md | 83 | 2026-10-30 | dated record | dated snapshot | docs 7、specs 2 | 原位 |
| docs/records/2026-10-29/UIUX-NATIVE-ACCEPTANCE-ISSUE-DRAFT.md | 25 | 2026-10-30 | dated record | dated snapshot | docs 1 | 原位 |
| docs/records/2026-10-29/UIUX-PROPOSAL-2026-10-29.md | 513 | 2026-11-07 | dated record | dated snapshot | docs 2 | 原位 |
| docs/records/2026-11-09/CAST-CONTENT-VERIFICATION.md | 13 | 2026-11-09 | dated record | dated snapshot | docs 1 | 原位 |
| docs/records/2026-11-09/DASHBOARD-STITCH.md | 9 | 2026-11-09 | dated record | dated snapshot | 無 | 原位 |
| docs/records/2026-11-09/EXPORT-TIMELINE-VERIFICATION.md | 13 | 2026-11-09 | dated record | dated snapshot | 無 | 原位 |
| docs/records/2026-11-09/MACOS-TEST-CLOSEOUT.md | 67 | 2026-11-09 | dated record | dated snapshot | specs 1 | 原位 |
| docs/records/2026-11-09/REVIEW-CLOSEOUT.md | 43 | 2026-11-09 | dated record | dated snapshot | 無 | 原位 |
| docs/records/2026-11-09/STATE-RECOVERY-VERIFICATION.md | 20 | 2026-11-09 | dated record | dated snapshot | 無 | 原位 |
| docs/records/2026-11-09/UI-STYLE-CONSISTENCY.md | 50 | 2026-11-09 | dated record | dated snapshot | 無 | 原位 |
| docs/records/2026-11-10/MACOS-WORKFLOW-CLOSEOUT.md | 93 | 2026-11-10 | dated record | dated snapshot | specs 2 | 原位 |
| docs/records/README.md | 25 | 2026-10-30 | reference（索引） | current；本次補列 | （索引頁，略） | 原位 |
| docs/redaction-design.md | 107 | 2026-07-30 | design-current | current（已實作；開頭「currently capture-time destructive」已過時）；抽查 | docs 8、src 5、cli 1 | 原位 |
| docs/releasing.md | 78 | 2026-11-03 | reference（發布） | current；未重新核對（另一 PR 修改中） | docs 1 | 原位 |
| docs/skills/redlog-pentest.md | 192 | 2026-10-05 | reference（agent skill） | current；`test/agent-tool-surface.test.ts` 讀取 | specs 3、docs 3、README.md 1、test 1 | 原位 |
| docs/windows-development.md | 30 | 2026-10-26 | manual | current；未重新核對 | docs 2 | 原位 |
| docs/windows-setup.md | 59 | 2026-11-04 | manual | current；未重新核對 | docs 3、CHANGELOG.md 1、README.md 1、e2e 1、src 1 | 原位 |

新增（不在上表）：`docs/design/UIUX-STITCH-DESIGN.md`，作者本機的 Stitch 整合設計契約原稿（2026-11-06），只修正其中指向已搬移文件的路徑；本盤點自身 `docs/records/2026-11-11/DOCS-INVENTORY.md`。
