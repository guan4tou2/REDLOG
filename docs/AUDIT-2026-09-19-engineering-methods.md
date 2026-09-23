# RedLog 工程方法檢查：TDD、DDD、SDD 與交付流程

審查日期：2026-09-19  
核對版本：`d5d9b46`（`search: paginate SearchPanel with QueryPage + FTS5 cursor`）  
範圍：規格、領域模型、模組設計、測試、提交紀錄與目前驗證狀態  
本文將 SDD 解讀為 Spec-Driven Development／Software Design Documents；RedLog 兩種形式都有使用。

## 結論

RedLog 已具備成熟工程方法的主要材料，但還沒有形成一條可靠、可持續的單一流程。

| 方法 | 現況判斷 | 主要優點 | 主要缺口 |
|---|---|---|---|
| SDD | 強，但有規格漂移 | PRD、design、scenario、property、acceptance criteria 完整 | spec 狀態未隨實作更新，Architecture 過期，文件間有互相矛盾 |
| TDD | 測試能力強，test-first 紀律不一致 | 161 個 Vitest 檔案、23 個 E2E spec；純函式與真 SQLite 測試品質佳 | Git 歷史不能證明普遍 red-first；有 coverage-after；目前 typecheck 未過 |
| DDD | 已建立語言與 invariants，仍在成形 | 有 glossary、bounded contexts、canonical Target／Scope／Export 定義 | code layout 仍以技術層分區；幾個核心詞與實作不一致 |
| 模組設計 | 部分已有深 module | `scope-evaluator`、`query-page`、DB façade 提供集中規則 | 巨型 module 仍多，UI／IPC／export contract 重複，跨層語意容易漂移 |
| ADR | 幾乎未形成 | 部分 design 文件記錄了理由 | 不易逆轉的決策沒有精簡的狀態與取捨紀錄 |

現階段不需要再導入新的流程框架。應把現有 PRD → domain spec → test → implementation → verification 串成一條可追蹤的交付鏈，並停止用過期文件宣稱 current state。

---

## 1. SDD：規格驅動程度

### 已經做得好的部分

RedLog 的規格不只是功能清單。以下文件包含可驗證行為：

- `docs/archive/PRD-COMPLETION.md`：優先級、大小、相依、驗收與 Definition of Done。
- `docs/domain/SPEC-*.md`：Given/When/Then scenarios、invariant、property、acceptance criteria。
- `docs/archive/DEV-REQUIREMENTS-capture-onboarding.md`：從 model test 到 UI integration 的完整示例。
- `docs/TESTING.md`：設定值、可觀察行為與 proof test 的對照矩陣。
- `docs/UIUX-STANDARD.md`：互動規則、驗收條件與已知差距。

`SPEC-scope-evaluation.md` 特別接近有效的 executable specification：它定義 pattern 類型、precedence、正反例、property，並對應 canonical evaluator 與 232 個相關測試。

### 現存問題：規格狀態失真

四份 domain spec 仍宣稱功能「目前壞掉」：

- `SPEC-search-query-semantics.md` 仍寫 time filter 在 LIMIT 後執行；實際已由 `f889365` 修正。
- `SPEC-export-event-selection.md` 仍寫 scope export 漏掉 logged tier；實際已由 `1c77254` 修正。
- `SPEC-target-identity.md` 仍寫 aggregate 使用 `detectedTarget`；實際已由 `21f9e05` 修正。
- `SPEC-scope-evaluation.md` 仍以「四份 matcher 且語意不同」描述 current state；實際已由 `6a17103` 統一。

這不是排版問題。當規格同時扮演工作清單、設計依據和 current-state 文件，狀態過期會讓後續開發者不知道該相信 spec 還是 code。

### 現存問題：Architecture 文件過期

`docs/ARCHITECTURE.md` 標示 current as of `v0.9.3`，並描述 React 18；目前 package 為 `v0.15.1`、React 19，且 main、IPC、DB query、tailer、plugin 結構已多次重構。

Architecture 可以保留概念圖，但不能再標示為 current。至少應區分：

- Current architecture map；
- Historical design rationale；
- Proposed architecture。

### SDD 判斷

RedLog 實際採用的是「spec-assisted development」，尚未穩定做到「spec is the current executable contract」。規格品質高，治理與生命週期較弱。

---

## 2. TDD：測試先行與測試品質

### 測試資產

目前共有：

- 161 個 Vitest test files；
- 23 個 Playwright E2E spec files；
- 純 domain logic、SQLite integration、React render、source policy 與 Electron journey 等多層測試。

本次實際執行：

```text
scope evaluator + query pagination + search/target/screenshot pagination
6 files passed, 384 tests passed
```

完整 Vitest：

```text
159 files passed, 2 files failed
1979 tests passed, 1 failed, 11 skipped
```

其中 `api-server.test.ts` 因沙箱禁止寫入 `~/.redlog/api-token` 而失敗；`per-project-token.test.ts` 的 global token assertion 也受同一全域路徑／共享狀態影響。這兩項需要在可控制 homedir 的環境重跑，不能從本次結果直接判定產品回歸。

### 好的測試模式

1. **純 domain function**：`scope-evaluator.ts` 將規則集中在小 interface，測試覆蓋 normalization、precedence、CIDR 與 malformed input。
2. **真實 persistence integration**：`query-page-sqlite.test.ts` 使用 dual-tier SQLite 驗證 cursor，而不是只 mock SQL。
3. **Property／matrix 思考**：Scope、network verdict、retention 等以完整行為矩陣測試，適合安全與證據產品。
4. **UI model 與 rendering 分離**：Capture readiness 的文件示例先固定純 model，再驗證 React 呈現。

### 不能稱為全面 TDD 的原因

Git 歷史只能看到最終提交，無法證明同一 commit 內是否先寫 failing test。近期情況包括：

- `0cc9252` 同時加入 QueryPage 實作與 277 行測試，可能是 TDD 後 squash，也可能是 implementation-first，僅由 commit 無法判定。
- `3b9bba6` 在 primitive 實作後才增加真 SQLite integration test，明確屬於 coverage strengthening，不是該層的 red-first。
- `82183f1`、`d5d9b46` 都把功能與大批測試放在同一 commit，結果可審查，但 red state 沒有可追蹤證據。

TDD 不要求每個 commit 都保留紅色狀態；真正缺少的是 PR／CI 中「哪個 acceptance test 先失敗、為何失敗、最後由哪個變更轉綠」的簡短證據。

### 測試組合的風險

- `design-rules`、`settings-ia`、`export-single-control` 等測試直接讀 source text。它們適合守結構政策，但重構時容易因文字形狀而失敗，不能代替 observable behavior test。
- 完整測試會碰 `~/.redlog`，表示 test isolation 仍不完整。測試應注入 app data root／homedir adapter，避免依賴操作者真實環境。
- Vitest 5 已提示 `test.poolOptions` 被移除，測試設定需更新。
- 目前 `npm run typecheck` 失敗，表示測試綠燈不能作為整體版本可交付的充分條件。

### 目前 typecheck 錯誤類型

- Bundle manifest interface 未包含 implementation 已輸出的欄位。
- IPC 拆分後仍從 `project-manager` 匯入不存在的成員。
- `HttpDetail` 使用未定義的 `formatBytes`，且 default/named export 不一致。
- MarkerDetail 可選值與必填 prop 不一致。
- Scope config type 未包含 `personalDomains`。

這些錯誤多半是近期重構後 interface 沒同步，正好說明 module interface 與 implementation 尚未由 CI gate 鎖住。

---

## 3. DDD：領域模型與 ubiquitous language

### 已建立的領域骨架

`docs/domain/glossary.md` 已定義：

- Event、Chained Event、Logged Event、Evidence；
- Target、Observation、Scope、Violation；
- Activity、Cause、Engagement、Recording；
- Export Selection、Sanitization、Personal Domain、Do-Not-Export。

它也提出五個 bounded contexts：Capture、Evidence、Engagement、Investigation、Handoff，並列出 invariants。這比以 renderer／main／SQLite 作為產品語言成熟許多。

近期實作也開始把 invariants 變成 canonical modules：

- `scope-evaluator.ts`：Scope verdict 的 single source of truth。
- `query-page.ts`：dual-tier event ordering 與 cursor contract。
- `db/events.ts`：對 callers 隱藏 event-types/write/query/aggregate 的 façade。

這些 module 有小 interface、較深 implementation，而且 callers 與 tests 走同一 seam，方向正確。

### 領域詞與實作不一致

#### Marker 與 Bookmark 被混為同一概念

Glossary 將 Marker 定義為 investigation note／bookmark，並說永遠 chained。實作中的 Bookmark 卻是獨立 `bookmarks` table，可修改、刪除、retention prune，不在 evidence chain；Marker 才是 chained Event。

應明確拆成：

- **Marker**：不可變的 chained investigation Event；修正以 amendment Event 表達。
- **Bookmark**：可編輯、可刪除的私人工作筆記，不是 Evidence，也不進 evidence bundle。

#### Sanitization 定義混合了三種政策

Glossary 說 Sanitization 是「out-of-scope event 的 operator PII 移除」。實作實際分成：

- layer-4 sanitized field replacement；
- out-of-scope captured content masking；
- sharing 模式的 metadata／operator PII masking；
- Personal Domain／Do-Not-Export 的整筆排除。

這些有不同 trigger、不同輸出與不同稽核含義，不能共用一個模糊詞。

#### Export 格式宣告包含 CSV，但目前沒有 CSV export

Glossary 將 Export 寫成 NDJSON／CSV／Evidence Bundle；目前程式有 JSON、NDJSON、HAR、walkthrough、scope slice、timeline slice 與 bundle，未找到 CSV implementation。Glossary 應描述 domain 概念，不應列不存在或易變的格式；格式清單移到 user/API 文件較合適。

### Bounded context 尚未落到 code ownership

目前 source 仍主要依技術層分為 `core`、`main`、`preload`、`renderer`。這對 Electron 合理，但 domain context 的 policy 容易跨層重複。例如 Export Selection 同時分布於 renderer ExportMenu、IPC、DB query、redaction 和 bundle implementation。

不建議為了 DDD 大搬目錄。更實際的方式是先建立少量跨層 vertical module interface，例如 `ExportPlan`、`EventFilter`、`ScopeDecision`，讓技術層都依賴同一 domain contract。

### DDD 判斷

RedLog 已有 domain language 和 invariants，屬於正在形成的 DDD；尚未達到 bounded context 能約束 code、資料與 interface 的程度。

---

## 4. Module 設計與 seam

### 已具深度的 module

| Module | Interface 提供的 leverage |
|---|---|
| Scope evaluator | 一次解決 normalization、exact/wildcard/CIDR、exclude precedence 與 verdict |
| QueryPage | 統一 dual-tier order、opaque cursor、LIMIT+1 與 hasMore |
| DB event façade | Callers 不必知道 event write/query/aggregate 的內部分檔 |
| Tailer adapter | 多種 AI transcript parser 共用 host 的 persistence、dedup、redaction 與 lifecycle |

### 仍偏淺或分散的 seam

- ExportMenu、preview IPC、各格式 handler 與 bundle options 沒有共同 `ExportPlan`，caller 必須知道各格式差異。
- FilterContext 只有 UI state，沒有成為 DB query／export 的共同 interface。
- Capture health 由多個 producer 自行回報，錯誤與 gap 的 lifecycle 尚未形成一致 domain contract。
- Timeline 仍有 2,678 行；main index 1,655 行；tailer host 1,398 行。近期已拆出部分純函式，但 orchestrator 仍承擔大量 interface knowledge。

刪除測試可以看出差別：刪除 `scope-evaluator` 會讓匹配複雜度重新散到多個 caller，這是 deep module；刪除某些只轉傳 IPC 參數的 wrapper，複雜度幾乎不變，屬於 shallow module。

---

## 5. 建議的實作流程

不新增 Scrum 儀式或大型文件。每個有行為影響的變更走以下六步：

1. **Domain check**：確認 canonical 名詞與 invariant；若詞義衝突，先更新 glossary。
2. **Spec**：用 3–7 個 concrete scenarios 定義輸入、輸出、錯誤與 completeness；指定 spec owner 與 status。
3. **Seam**：先決定哪個 module interface 承擔規則，避免在 renderer／IPC／DB 各做一次。
4. **RED**：加入至少一個會因缺少目標行為而失敗的 observable test，PR 描述記錄失敗原因。
5. **GREEN／refactor**：最小實作轉綠，再移除重複 policy；source-shape test 只守必要的結構規則。
6. **Verify／close spec**：targeted tests、typecheck、build、必要 E2E；將 spec status 更新為 Verified，附 commit 與 proof tests。

### 建議統一的 spec status

```text
Proposed → Accepted → Implementing → Implemented → Verified
                                      ↘ Superseded
```

每份 spec header 最少包含：

```yaml
status: Verified
implemented_by: f889365
proof:
  - test/search-pagination.test.ts
verified_on: 2026-09-19
```

`Implemented` 只表示 code 已存在；`Verified` 才表示 acceptance criteria 在當前版本通過。這能避免「文件寫已完成，但實際沒有 module」或「功能已修，spec 仍寫 broken」。

### ADR 使用條件

只在以下三項同時成立時寫 ADR：難以逆轉、沒有背景會讓人困惑、確實比較過替代方案。RedLog 適合補 ADR 的主題包括：

- chained／logged dual-tier 的證據與效能取捨；
- 原始 Evidence 與 export copy 分離；
- Personal Domain 整筆排除，而 out-of-scope 預設遮蔽；
- AI transcript sidecar 與 derived Event 的雙層保存。

一般 UI 細節、單一 bug fix 或易於逆轉的 refactor 不需要 ADR。

---

## 6. 建議立即處理

### P0：恢復交付 gate

先修目前 typecheck errors，CI 必須要求：

```text
typecheck → targeted/domain tests → full Vitest → build → required E2E
```

任何一關失敗都不能用「局部測試通過」宣稱版本完成。

### P1：清理 current-state 文件

- 更新四份已實作 domain spec 的 status 與 proof。
- 更新 Architecture 的版本與 React／module map，或移除 current 宣告。
- 修正 Marker／Bookmark、Sanitization 與 Export glossary。

### P1：把本輪 UI audit 轉成 domain contract

先定義 `EventFilter` 與 `ExportPlan`，再修 Search／Transcript／HTTP／Timeline 與 preview／execute。這比逐頁補 if statement 更符合 SDD、DDD 與可測試 module 設計。

### P2：測試隔離

將 `~/.redlog`、token path、project root、clock 與 filesystem root 變成可注入 adapter；測試使用獨立 temp root。這會消除目前 full suite 對真實 home 與沙箱權限的依賴。

## 最終判斷

RedLog 不缺規格、不缺測試，也不缺領域思考。真正缺的是三者之間可追蹤的一致性：

```text
Domain invariant
      ↓
Accepted spec
      ↓
One module interface
      ↓
Failing observable test
      ↓
Implementation
      ↓
Verified status + current architecture
```

把這條鏈補齊後，現有工程資產已足以支撐穩定開發；沒有必要再疊加新的方法論名稱或更多平行文件。

---

## 7. 如果導入 GitHub Spec Kit

### 判斷

適合，但應採 brownfield 增量導入，不應全面重寫現有文件。

Spec Kit 官方核心流程是：

```text
Constitution（每個專案一次）
→ Specify
→ Plan
→ Tasks
→ Implement
→ Converge
```

對高風險功能可加入 Clarify、Checklist 與 Analyze。Converge 會對照 spec、plan、tasks 與 implementation，發現缺口時補回 tasks；這正好能改善 RedLog 現在「功能已修、spec 還寫 broken」的問題。

官方文件也提醒既有專案需要自行選擇 spec persistence model。Spec Kit 不替團隊決定既有 spec 如何演進，因此 RedLog 仍需明確規定哪些文件是 living contract、哪些只是 feature history。

官方參考：

- [Spec Kit](https://github.github.com/spec-kit/)
- [Agentic SDD](https://github.github.com/spec-kit/reference/agentic-sdd.html)
- [Evolving Specs in Existing Projects](https://github.github.com/spec-kit/guides/evolving-specs.html)

### RedLog 建議的文件分工

```text
.specify/memory/constitution.md   不可違反的工程與證據原則
docs/domain/glossary.md           living ubiquitous language
docs/domain/SPEC-*.md             living domain contracts / invariants
specs/NNN-feature/spec.md         單次功能的 what / why / scenarios
specs/NNN-feature/plan.md         技術方案與 module seam
specs/NNN-feature/tasks.md        有順序、可驗證的實作工作
specs/NNN-feature/checklists/     需求品質與交付 gate
docs/adr/                         少數難以逆轉的架構決策
```

不要將 glossary、domain invariants、PRD 和每個 feature spec 複製成四份內容。Feature spec 應連結 canonical domain contract；若功能改變 invariant，task 必須包含更新對應 domain spec。

### 建議的 Constitution

RedLog constitution 應短而可執行，至少包含：

1. **Evidence truthfulness**：未知、缺失、截斷、查詢失敗不得顯示成成功、完整或零結果。
2. **Immutable source**：原始 Event／Evidence 不因 UI、遮蔽或交付而被改寫；交付只產生衍生 copy。
3. **Canonical semantics**：Target、Scope、Event ordering、Export Selection 各自只有一個 canonical module。
4. **Project isolation**：事件、spool、terminal、AI session 和附件必須固定歸屬 Engagement。
5. **Preview equals output**：匯出預覽、實際 selection 與 manifest 使用同一份 ExportPlan。
6. **Testable module seam**：行為規則先放進可測的深 module，renderer／IPC 不重做 policy。
7. **Verification gate**：typecheck、targeted tests、full suite、build 與必要 E2E 完成後才能標 Verified。
8. **Scope restraint**：只做擷取、保存、查找與交付；案件管理、SIEM 與 agent orchestration 需另立產品決策。

不要把「使用 React」「檔案要有註解」等易變實作細節寫進 constitution；那些放在 plan 或一般開發規範。

### Spec Kit 不會自動提供的 TDD

Spec Kit 將需求拆成 tasks，但不保證測試真的先失敗。RedLog 應在 constitution／task template 加入：

```text
每個 observable behavior task：
1. 新增會因缺少該行為而失敗的 test
2. 記錄 RED 的失敗原因
3. 最小 implementation 轉 GREEN
4. refactor 後重跑 targeted test
5. 完成整體 verification gate
```

Tasks 不需要強迫拆成「寫測試」與「寫程式」兩張互不相關的票；一個 behavior task 內保留 RED → GREEN 證據更容易審查。

### 建議的導入試點

先用本次仍待處理的「統一 EventFilter 與 ExportPlan」當第一個 Spec Kit feature，而不是從整個 RedLog 重建規格。

```text
specs/001-consistent-filter-export/
├── spec.md
├── plan.md
├── tasks.md
└── checklists/
    ├── requirements.md
    └── evidence-integrity.md
```

`spec.md` 應只定義可觀察結果：

- 同一 filter 在 Search、Transcript、HTTP、Timeline 的語意一致；
- 不適用條件必須明示；
- preview 與 output count 一致；
- 查詢失敗不能顯示為零結果；
- export 執行中資料變動時採 snapshot 或明示 stale。

`plan.md` 再決定：

- `EventFilter` domain interface；
- `ExportRequest`／`ExportPlan` interface；
- renderer → preload → IPC → query 的參數流；
- snapshot、pagination、dual-tier ordering；
- 對既有 JSON／NDJSON／HAR／bundle 的 migration。

`tasks.md` 依 dependency 排序：domain contract → failing tests → backend selection → IPC types → renderer wiring → preview/manifest → E2E → spec status update。

### 流程分級，避免過度設計

| 變更類型 | 建議流程 |
|---|---|
| 小型文案、單一明確 bug | Bug-fix 流程：assess → fix → verify；不建立完整 feature spec |
| 單 module、低歧義功能 | Specify → Plan → Tasks → Implement → Converge |
| 跨 renderer／IPC／DB、證據或隱私功能 | Constitution check → Specify → Clarify → Plan → Checklist → Tasks → Analyze → Implement → Converge |
| Domain invariant 變更 | 完整流程 + 更新 glossary/domain spec；必要時 ADR |

### 導入前要先處理

1. 先修目前 typecheck，避免 Spec Kit 將既有紅燈誤歸因於新 feature。
2. 將四份過期 domain spec 更新為 Verified，建立可信 baseline。
3. 修正 Marker／Bookmark、Sanitization 等 glossary 衝突。
4. 決定 feature spec 採 flow-forward，而 `docs/domain` 採 living contract。
5. 初始化前先提交或備份目前工作區；官方 existing-project 指南說明 `init --here` 會加入／更新 Spec Kit infrastructure，應先檢視 diff。

### 最終建議

Spec Kit 對 RedLog 的價值不是產生更多 Markdown，而是提供固定的 artifact chain 與 convergence gate。若 constitution、domain contract 與 CI gate 沒有接進去，只執行 Specify → Plan → Tasks，反而會加劇目前的文件重複。

建議採用，但先以一個跨層 feature 試點；試點完成後檢查三件事：規格是否仍可信、實作是否更少重複 policy、驗證是否真的阻止 typecheck／E2E 未過卻標完成。三項成立再擴大使用。
