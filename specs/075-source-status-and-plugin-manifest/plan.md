# Implementation Plan: 來源描述、單一狀態模型與外掛 manifest v2

**Branch**: `spec/072-075-contracts` | **Date**: 2026-11-12 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from `/specs/075-source-status-and-plugin-manifest/spec.md`

## Summary

今天「這個來源能不能記、有沒有在記、該做什麼」沒有擁有者：main 送出一包原始欄位（`CaptureHealth`，`capture-health.ts:134-184`），每個畫面各自拼出答案。外掛同樣沒有擁有者：三份 manifest schema、五台互相重疊的狀態機，宣告了的欄位大多沒人讀。

本計畫做三件事，每件都有一個擁有者模組與一道 gate：

1. **描述**：每個來源一份 `SourceDescriptor`。內建來源寫在核心的一張表（不變成外掛），外掛 Source 由 manifest v2 產生。
2. **狀態**：一個純函式把具名事實算成八個字之一，另一個純函式算四個整體字之一。main 送出的是答案；畫面只渲染。今天的 20 處獨立判斷與 2 組「來源 → 設定頁」對照依序折入，數量只降不升，由 ratchet 鎖住。
3. **外掛契約**：一份有版本的 JSON Schema、兩種 kind、每個欄位登記讀者、內容雜湊涵蓋每個檔案；v1 照讀，擷取不中斷。

## Technical Context

**Language/Version**：TypeScript（core、main、renderer）；JSON Schema draft 2020-12（manifest）；Node（`redlog-cli`）。

**Primary Dependencies**：不新增執行期套件。JSON Schema 驗證以手寫的最小驗證器實作，或在 devDependencies 加 `ajv` 只用於測試與 `plugin check`（D7 決定前者為預設；見 Complexity Tracking）。

**Storage**：無新的資料表，無新的機器層檔案。讀 Spec 071 的 `ingest_instances` 與憑證登記、Spec 073 的安裝帳本與同意紀錄、既有的 `~/.redlog/tool-detection/shell:*.json` 與 `~/.redlog/plugins/{trust,state}.json`。

**Testing**：Vitest（決策表、property、render、靜態 gate）；Playwright e2e 只在 ubuntu；真機另列。

**Target Platform**：macOS、Linux、Windows（PowerShell、Git Bash、WSL）。

**Performance Goals**：一次狀態計算（不含事實收集）在 50 個來源時 < 1 ms；事實收集維持今天的探針數或更少（今天 11 個探針加 hooks 偵測，`capture-health.ts:386-392`）；每事件 Processor 時限 250 ms（使用者規則合計）。

**Constraints**：不新增頁面；不改事件的雜湊、簽章或鏈結；不改寫既有列；內建來源不改成外掛；不引入相依注入容器或全域狀態庫；元件不在元件內宣告。

**Scale/Scope**：約 15 個內建來源、每台機器數個外掛 Source；renderer 約 15 個檔案受影響（04-F1 的估計，T005 重新計數）。

## Constitution Check

| 原則 | 判定 |
|---|---|
| II Surface Truthfulness | 「沒有事件」與「記不到」分開（待命與無可用來源）；證明只是理由；每個 surface 讀同一份答案。通過 |
| III Canonical Semantics | 一個描述表、一個狀態函式、一個整體函式、一份詞表、一份 manifest schema。通過 |
| VI Explicit Failure | 事實缺席等於 unknown，不沿用上一個值；失敗必須有主動證據與理由碼。通過 |
| VII Provenance | Processor 的推導帶規則集版本與雜湊（需 071 接受一個鍵）。通過，依賴 071 |
| VIII Test-First | 第一階段只加 gate 與特徵化測試；每個行為改變先 RED。須執行 |
| IX Restraint | 新增 `src/core/sources/` 三個小檔，取代 20 處判斷與 3 份 manifest schema；不建框架、不搬 `src/core`、不把內建來源變外掛。通過 |
| Workflow | 涉及證據歸屬與跨層契約（API 欄位、manifest 公開契約），實作前執行 Clarify、Checklist、Analyze（T001） |

## 現況（程式碼確認，2026-11-12，`origin/main@56c9fe6c`）

- **來源狀態**：`SourceState = 'ready'|'unset'|'off'|'error'`（`capture-health.ts:44`）。`stateFrom`（`:415-436`）：`enabled===false → off`；有事件 → `ready`；`installed===false → unset`；其他一律 `ready`。之後的覆寫：擷取錯誤（`:649-668`）、AI 目錄或整合問題（`:696-698`）、內建 pane 錄製失敗（`:748-752`）、前置缺項（`:758-763`）、外掛 producer（`:802`，`running || last!==null ? ready : off`）。
- **整體**：`:844-858`。chain 抽樣失敗或 DB 寫入失敗 → `dark`；`!anyWired && !everFed` → `dark`；來源錯誤、proxy 失敗、producer 停送 → `partial`；其餘 `healthy`。`anyWired`（`:815-817`）要求某來源 `installed===true`，是機器事實。
- **存活**：外掛 producer 的「在跑」由 chained 的 `system.producer_heartbeat` 列推出（`:793-798`，60 秒窗口 `:334`）。
- **前置條件**：至少 6 份：`hooks-manager.ts:181,194`（`requiresAll`）與 `:595-614`（`checkAvailable` 的特例分支）；`runtime-preflight.ts:96`（`neededFor`）；`terminalActivation.ts:18`（`DEPENDENCIES`）；`CapturePreparation.tsx:13-18`（`preparationChecks`）；`main/services/capture-prerequisites.ts:21-77`（screenshot 與連線監控）；`ExternalCaptureGroup.tsx:108`（從描述文字以 regex 撈依賴）。
- **「哪些 shell 能接」**：`terminalActivation.ts:59`（`HOST_ADAPTERS`）、`runtime-preflight.ts:46`（`SHELL_HOOKS`）、`shell-flavour.ts:15,39`（`POSIX_SHELLS`、`shellAdapterFilename`）、`hooks-manager.ts:174`（`STARTER_PACK_FALLBACK`）與 `plugins/starter-pack/plugin.json`（`builtinProducers`：shell-zsh、shell-bash、mitmproxy、shell-powershell、shell-wsl）、`hooks-manager.ts:599-614`、`shell-catalog.ts:52`（`POSIX_SHELL_PATHS`）、`hookPlatform.ts:10-11`；`wsl-manager.ts:288`（09-F3 所列，本次未開檔）。
- **外掛 manifest**：generic schema `types.ts:202-225`、驗證 `manifest.ts:191-276`；`kind`、`capabilities`、`signature`、`publisher`、`schemaVersion`、頂層 `emits`／`health` 被解析（`:259-274`）但沒有讀者（以 `grep` 對 `src/` 確認；`capabilities` 只被 trust 的 grant 記錄與比對，`trust.ts:15,47-58`，不限制任何行為）。producer schema `hooks-manager.ts:14-32`；官方 AI 的 `redlogAgent`（`official-agents.ts:48-83`）。
- **內容雜湊**：`computeContentHash`（`manifest.ts:294-310`）只涵蓋正規化 manifest 與 `hookFile`／`tailers`（`collectFileRefs`，`:279-287`），不涵蓋 hook 呼叫的同目錄檔。
- **id 覆蓋**：`loader.ts:96-107`，使用者外掛同 id 勝過 bundled。
- **pack**：`isPackAvailable` 要求 bundled 外掛 `active`（`capture-packs.ts:34-37`）；`CapturePackGroup.tsx:110-112` 有「修復」鈕直接改外掛狀態。
- **官方 AI 狀態**：`not-installed|installed|update-available|conflict|error`（`official-agents.ts:17`）；更新後 bytes 不同即 `update-available`（`:155`）。
- **進行中的分支**（工作樹 `work/1112-plugsafe`，未合併）：`statusFor` 產生 `hash-changed`；`contentStillApproved(p)` 在顯示步驟前重算雜湊；使用者外掛宣告 bundled id 時以 `<folder>@user` 列為錯誤；使用者外掛的 `manualSteps` 帶指令即需核准；`CaptureContribution.requiresAll`。

## 模組邊界

### 擁有者與介面

```ts
// src/core/sources/vocabulary.ts — 純資料；renderer、CLI、core 都可匯入
export const SOURCE_STATES = ['unknown','failed','off','unavailable','not-set-up','stopped','ready','recording'] as const
export const OVERALL_STATES = ['attention','recording','waiting','none'] as const
export const REASON_CODES = [/* 見「理由與動作」，封閉 */] as const
export const ACTION_CODES = ['open-owner','fix-prerequisite','prepare','retry','open-terminal'] as const
export type SourceStateCode = typeof SOURCE_STATES[number]   // 同理 OverallCode、ReasonCode、ActionCode

// src/core/sources/descriptor.ts — 描述的型別與內建表；不做 IO
export interface Prerequisite {
  id: string
  kind: 'binary' | 'permission' | 'platform' | 'file'
  anyOf?: string[]; allOf?: string[]                // binary
  permission?: 'screen-recording' | 'socket-table' | 'execution-policy'
  platforms?: Array<'darwin'|'linux'|'win32'>
  path?: string                                     // file
}
export interface OwnerAnchor { page: SettingsPageId; row: string }   // 由 descriptor 決定，外掛不能宣告
export interface SourceDescriptor {
  id: string
  label: { i18nKey: string } | { text: string }     // 外掛：manifest 的 label（短、單行）
  kind: 'shell-adapter'|'builtin-terminal'|'managed-service'|'in-process'|'resident'|'external-producer'
  emits: readonly KindId[]                         // Spec 072 的 KindId，例如 'scanner:packet_flow'
  scope: 'machine' | 'project'
  setup: { by: 'none'|'redlog'|'operator'; owner: OwnerAnchor; projectOptIn: boolean }
  prerequisites: readonly Prerequisite[]
  liveness: 'hello'|'alive'|'process'|'pane'|'none'
  verification: 'first-event'|'hello'|'http-clients'
  startedBy: 'always'|'redlog'|'operator'
  privilegedSteps?: readonly PrivilegedStep[]
  core: boolean
  shell?: { name: 'zsh'|'bash'|'powershell'; platforms: readonly string[]; adapter: string }  // shell-adapter 才有
  adapter?: { readRoots: readonly string[]; digest: string }   // 官方 AI（in-process）才有；073 的 adapterDeclaration 讀它
}
export const BUILTIN_SOURCES: readonly SourceDescriptor[]
export function descriptorFromManifest(m: ManifestV2Source, origin: 'bundled'|'user'): SourceDescriptor
export function descriptorsFor(plugins: readonly LoadedPlugin[], platform: NodeJS.Platform): SourceDescriptor[]

// src/core/sources/status.ts — 純函式；只匯入 ./vocabulary 與 ./descriptor 的型別
export interface Fact<T> { value: T; reason: string; since: number | null; message?: string }  // 缺席 = unknown
export interface SourceFacts {
  configured?: Fact<boolean | 'n/a'>
  enabledForProject?: Fact<'on'|'off'|'unset'|'n/a'>
  machineDisabled?: Fact<boolean>
  prerequisites?: Fact<ReadonlyArray<{ id: string; state: 'ok'|'missing'|'unknown'; fix?: Fix }>>
  process?: Fact<'up'|'starting'|'down'|'failed'>
  credential?: Fact<'valid'|'missing'|'revoked'|'n/a'>
  lastHello?: Fact<number | null>; lastAlive?: Fact<number | null>; aliveThisSession?: Fact<boolean>
  firstEventEver?: Fact<number | null>; lastEvent?: Fact<number | null>
  loss?: Fact<{ unintentional: number; intentional: number; pending: number; rejectedAfterDisable: number; unintentionalWindowEnd: number | null }>
  quarantine?: Fact<{ count: number }>
  legacyDoor?: Fact<boolean>
  captureError?: Fact<{ at: number } | null>
  selfCheck?: Fact<'ok' | 'detached'>
  residue?: Fact<number>
  manifest?: Fact<'valid'|'invalid'|'awaiting-approval'|'reapproval-needed'>
  workdir?: Fact<'valid'|'missing'|'invalid'|'changed'|'n/a'>
  seenOnMachine?: Fact<boolean>
  clients?: Fact<ReadonlyArray<ClientFacts>>        // http-clients 才有
}
export interface ClientFacts { client: string; routed: Fact<boolean>; tlsTrusted: Fact<boolean|'n/a'>; stored: Fact<number | null> }
export interface StatusContext { now: number; startedAt: number; paused: boolean; read: 'ok'|'unknown' }
export interface SourceStatus {
  id: string; state: SourceStateCode; reason: ReasonCode; reasonVars?: Record<string, string|number>
  action?: ActionCode; owner: OwnerAnchor; attention: boolean; since: number | null
  facts: Readonly<SourceFacts>                        // 只供細節列顯示
}
export function deriveSourceStatus(d: SourceDescriptor, f: SourceFacts, ctx: StatusContext): SourceStatus
export function deriveOverall(statuses: readonly SourceStatus[]): { state: OverallCode; attention: number; recording: number }
export const GRACE_MS: { default: 30_000; alive: 60_000 }

// src/core/capture-health.ts — 保留檔名，角色改為事實收集器（唯一做 IO 的地方）
export function collectSourceFacts(now: number): { descriptors: SourceDescriptor[]; facts: Map<string, SourceFacts>; startedAt: Map<string, number>; integrity: IntegrityStatus; paused: boolean; read: 'ok'|'unknown' }
export function getCaptureStatus(now?: number): CaptureStatusPayload
export interface CaptureStatusPayload { v: 2; overall: OverallCode; attention: number; statuses: SourceStatus[]; integrity: IntegrityStatus; paused: boolean; checkedAt: number }
// getCaptureHealth() 改為由 payload 產生舊形狀的轉接層，只供 /api/status 的 deprecated 欄位（一個 minor 版本）

// src/core/plugins/manifest-v2.ts — 唯一的 manifest 解析入口（v1 與 v2）
export function parseManifest(raw: unknown, dir: string): { ok: true; manifest: InternalManifest; version: 1|2; warnings: string[] } | { ok: false; error: string; pointer: string }
export function contentHash(m: InternalManifest, dir: string): string            // v2：每個檔案；v1：沿用今天的算法
// plugins/plugin.schema.json — 唯一的 schema
// src/core/plugins/manifest-consumers.ts — FIELD_CONSUMERS: Record<JSONPointer, `${file}:${symbol}`>

// src/renderer/src/lib/sourceStatusView.ts — renderer 唯一可讀 facts 的地方
export function stateKey(s: SourceStateCode): string; export function overallKey(o: OverallCode): string
export function tone(s: SourceStatus): 'danger'|'warn'|'safe'|'neutral'
export function reasonText(t: Translate, s: SourceStatus): string
export function ownerTarget(o: OwnerAnchor): string          // 取代 settingsTarget 的來源對照
export function detailLines(t: Translate, s: SourceStatus): string[]   // 細節列：最近一筆、缺口、隔離、client 清單
```

### 擁有的東西

| 模組 | 擁有 |
|---|---|
| `sources/vocabulary.ts` | 8＋4 個狀態碼、理由碼、動作碼（封閉） |
| `sources/descriptor.ts` | 內建來源描述表；描述的形狀；manifest → 描述的對映 |
| `sources/status.ts` | 決策表、整體函式、寬限期常數、`isAttention` |
| `capture-health.ts` | 事實收集（探針、存活、帳本、前置、外掛載入結果的讀取）與快取（750 ms、事件清除，沿用 `:391-413`） |
| `plugins/manifest-v2.ts`、`plugin.schema.json`、`manifest-consumers.ts` | manifest 的唯一定義、解析、雜湊與欄位讀者登記 |
| `renderer/lib/sourceStatusView.ts` | 狀態碼 → i18n key、色調、理由文字、owner 連結 |

### 匯入規則（G0 邊界測試）

- `sources/status.ts`、`sources/vocabulary.ts`：不得匯入 `node:*`、`electron`、`./db/*`、`../main/*`、任何有副作用的模組；`status.ts` 只匯入 `./vocabulary` 與 `./descriptor`（`import type` 以外的匯入只允許 `./vocabulary`）。
- `sources/descriptor.ts`：只匯入 `./vocabulary` 與 `../plugins/manifest-v2` 的型別。
- 誰可以匯入 `status.ts`：只有 `capture-health.ts` 與測試。renderer 與 CLI 不得匯入 `status.ts`（它們不算，只讀）。
- 誰可以匯入 `vocabulary.ts`：任何層（比照 `scope-vocabulary`）。
- renderer 中只有 `lib/sourceStatusView.ts` 可以讀 `.facts`。
- `plugins/manifest-v2.ts` 是唯一呼叫 JSON 解析 `plugin.json` 的地方：`hooks-manager.ts` 的 `loadStarterPack`（`:237-268`）與 `official-agents.ts` 的 manifest 讀取（`:48-83`）刪除或改為呼叫它。

## 要取代的判斷（file:line，折入順序）

整體（7 份）：

| # | 位置 | 內容 | 折入 |
|---|---|---|---|
| J1 | `capture-health.ts:813-858` | `everFed`／`anyWired`／`producerStalled`／verdict | Phase 2：由 `deriveOverall` 取代，舊欄位轉接 |
| J5 | `lib/captureIssue.ts:15-37` | `captureIssueView` 與 `sourceTarget` 對照 | Phase 3 第 1 步 |
| J3 | `StatusBar.tsx:137-162`、`:260-306` | issue、toast、dot、label、tooltip | Phase 3 第 2 步 |
| J4 | `RecordingWorkspace.tsx:33-48` | `error && !informational` 的失敗集合 | Phase 3 第 3 步 |
| J6 | `cli/redlog-cli.js:320-327` | `dark/partial` → `RECORDING NOTHING`／`wired but idle` | Phase 3 第 4 步 |
| J2 | `CaptureHealth.tsx:415-472` | `dark`／`partial`（含 rogue、`http==='failed'`）、`coreGap`、`healthyGap`、headline、badge、summary | Phase 4 第 1 步 |
| J7 | `lib/coreCapture.ts:22-28`，`FirstRunView.tsx:184` | `coreCaptureReady` | Phase 6 |

來源（13 份）：

| # | 位置 | 內容 | 折入 |
|---|---|---|---|
| S1 | `capture-health.ts:415-436,649-668,696-698,748-763,802` | `stateFrom` 與覆寫 | Phase 2（成為事實） |
| S12 | `core/capture-contract.ts:13-27` | `captureFacts`（半步） | Phase 6 最後刪除 |
| S10 | `CaptureHealth.tsx:279-281,302-305` | `isRogue`、`isProblem`、`isAgentRow` | Phase 4 第 1 步 |
| S2 | `CaptureHealth.tsx:105-121` | `coreCommandState` | Phase 4 第 1 步 |
| S13 | `CaptureHealth.tsx:32-` | `ownShellKey` | Phase 4 第 1 步 |
| S3 | `lib/httpCaptureState.ts:70-101` | `httpCaptureState` 的 8 態 | Phase 4 第 2 步 |
| S11 | `HttpCaptureStep.tsx:255` 與 `CaptureHealth.tsx:143` | 兩份「HTTPS 已驗證」 | Phase 4 第 2 步 |
| S8 | `settings/HooksPanel.tsx:118-131` | 「已安裝／未安裝」 | Phase 5 第 1 步 |
| S5 | `lib/pluginViewModel.ts:289-327` | `officialProjectLevel`、`officialHealth` | Phase 5 第 2 步 |
| S6 | `settings/AgentsPanel.tsx:48-55` | `projectRecording` | Phase 5 第 2 步 |
| S7 | `settings/ExternalCaptureGroup.tsx:93-113` | `stateLabel` 鏈與 regex | Phase 5 第 3 步 |
| S9 | `TerminalView.tsx:649-650` | pane 徽章 `hookOn/hookOff` | Phase 5 第 4 步 |
| S4 | `lib/captureReadiness.ts:138-219` | `statusFor`、`computeCaptureReadiness`、`primaryCaptureAction` | Phase 6 |

「來源在哪裡設定」（2 組、8 處）：`captureIssue.ts:23-27`；`CaptureHealth.tsx:154,172,563,612,665,676,722`。前者在 Phase 3 第 1 步、後者在 Phase 4 第 1 步改讀 `owner`。

前置條件（6 份）與 shell 清單（9 份，見「現況」）在 Phase 1 由描述表取代資料來源，各呼叫點在 Phase 5 改讀描述；`ExternalCaptureGroup.tsx:108` 的 regex 在 Phase 5 第 3 步刪除。

基準：G2 ratchet 從 20（J1–J7、S1–S13）起算，每個折入步驟至少減 1。

## 決策表

記號：`G` = 在寬限期內（`now - startedAt < grace`；`liveness: alive` 為 60 秒，其餘 30 秒）。`relevant` = `d.core ∨ enabledForProject = on`。「窗口」= 60 秒（存活）。取第一個成立的列。

| 列 | 狀態 | 條件 | 理由碼 | 動作 | attention |
|---|---|---|---|---|---|
| U1 | unknown | `ctx.read = unknown` | `unknown` | — | 否 |
| F1 | failed | (`machineDisabled` ∨ `enabledForProject = off`) ∧ (`loss.rejectedAfterDisable > 0` 於停用之後 ∨ (`legacyDoor` ∧ `lastEvent > 停用時刻`) ∨ `lastAlive` 在窗口內) | `writing-while-off` | `open-owner` | 是 |
| F2 | failed | `manifest = invalid` | `manifest-invalid` | `open-owner` | 依 `relevant` |
| F3 | failed | `residue > 0` | `residue` | `open-owner` | 是 |
| F4 | failed | `process = failed`（確定性原因：埠被占用、以錯誤結束） | `port-in-use`／`start-failed` | `retry` | 依 `relevant` |
| F5 | failed | `captureError` 存活 ∧ (`lastEvent` = null ∨ `lastEvent ≤ captureError.at`) ∧ `enabledForProject ≠ off` | `capture-error` | `retry` | 依 `relevant` |
| F6 | failed | `selfCheck = detached` | `detached` | `open-owner` | 依 `relevant` |
| F7 | failed | ¬G ∧ `liveness = alive` ∧ `aliveThisSession` ∧ `lastAlive` 不在窗口內 ∧ `enabledForProject ≠ off` | `not-reporting` | `open-owner` | 依 `relevant` |
| F8 | failed | ¬G ∧ `enabledForProject = on` ∧ `credential ∈ {missing, revoked}` | `credential-invalid` | `open-owner` | 是 |
| F9 | failed | `loss.unintentional > 0` ∧ `loss.unintentionalWindowEnd > lastEvent` | `losing` | `open-owner` | 依 `relevant` |
| O1 | off | `machineDisabled` ∨ `enabledForProject = off` | `switched-off` | — | 否 |
| N1 | unavailable | 任一 `prerequisites[i] = missing` | `missing-prerequisite{name}` | `fix-prerequisite` 或 `prepare` | 若 `enabledForProject = on` |
| N2 | unavailable | 平台不符 | `platform` | — | 否 |
| N3 | unavailable | 整合檔案缺失（官方 adapter 不在 app 本體） | `integration-missing` | — | 若 `enabledForProject = on` |
| S1 | not-set-up | `manifest = awaiting-approval` | `needs-approval` | `open-owner` | 否 |
| S2 | not-set-up | `manifest = reapproval-needed` | `reapproval-needed` | `open-owner` | 否 |
| S3 | not-set-up | `configured = false` | `hook-file-missing{file}`（shell，帳本有紀錄、驗證為 missing／modified）／`hook-not-installed{file}`（shell，帳本無紀錄）／`not-configured` | `open-owner` | 否 |
| S4 | not-set-up | `setup.projectOptIn` ∧ `enabledForProject = unset` | `not-enabled-here` | `open-owner` | 否 |
| S5 | not-set-up | `workdir ∈ {missing, invalid, changed}` | `no-workdir`／`workdir-changed` | `open-owner` | 否 |
| U2 | unknown | `configured`、`enabledForProject`、`prerequisites` 任一缺席或含 unknown | `unknown` | — | 否 |
| T1 | stopped | `liveness = process` ∧ `process ∈ {down, starting}` | `starting`（`starting` 或 G）／`manual-start`（`startedBy = operator`）／`stopped` | `open-owner` | 否 |
| T2 | stopped | `liveness = alive` ∧ `lastAlive` 不在窗口內（含從未存活） | 同上 | `open-owner` | 否 |
| T3 | stopped | G ∧ 存在被寬限期抑制的暫時性失敗（F7、F8 在 G 內的情形） | `starting` | — | 否 |
| R1 | ready | `firstEventEver` = null | 依序取第一個成立：`recording-paused`、`in-use-not-recorded`、`no-client-yet`、`elsewhere-proxy`、`seen-on-machine`、`not-yet-seen`、`awaiting-first-event` | `open-terminal`（只限內建終端機）| 否 |
| C1 | recording | `firstEventEver` ≠ null | 依序：`recording-paused`、`gap{n}`、`quarantined{n}`、`legacy-door`、`tls-untrusted{client}`、`not-delivering`、`output-not-recorded`、`clients{list}`、`recorded` | — | 否 |

補充：

- `isAttention` 只看上表最後一欄；整體依 spec FR-015。
- HTTP（`verification: http-clients`）：`process` 為 proxy；`firstEventEver` 改為「任一 client 的 `stored` 不為 null」；client 層的 TLS 不信任、未經過只產生理由。proxy 為 failed 時，client 事實全部視為 unknown（依賴不傳染）。
- Shell（`shell-adapter`）：`configured` 由安裝帳本與實際讀的檔案決定；`firstEventEver` 改為「本專案收到綁定本專案的 hello」（071 FR-112）；`seenOnMachine` 取 tool-detection 檔。
- 寬限期：`startedAt` = max（app 啟動、專案開啟、`enabledForProject` 變成 `on` 的時刻、`process` 最近一次進入 `starting`）。F1–F6、F9 不受 G 影響。
- `recording-paused`：`ctx.paused` 為真時，R1 與 C1 的理由一律為它；狀態不變。

### 舊欄位對映（`/api/status` 的 deprecated 欄位，一個 minor 版本）

| 新 | 舊 `capture.verdict` | 舊 `sources[].state` |
|---|---|---|
| integrity 失敗（任一） | `dark` | — |
| overall `attention` | `partial` | failed → `error`；unavailable 且 on → `error` |
| overall `none` | `dark` | unavailable、not-set-up → `unset` |
| overall `waiting`、`recording` | `healthy` | ready、recording → `ready`；stopped（operator）→ `off`；stopped（其他）→ `ready`；off → `off`；unknown → `unset` |

## 生命週期對映

| 機器層 | 專案層 | 執行期事實 | 狀態 |
|---|---|---|---|
| `invalid` | — | — | 失敗（`manifest-invalid`） |
| `awaiting-approval` | — | — | 未設定（`needs-approval`） |
| `approved`，雜湊不符 | — | — | 未設定（`reapproval-needed`），憑證撤銷 |
| `disabled` | 任意 | 無存活、無被拒 | 已關閉 |
| `disabled` | 任意 | 有存活或停用後被拒 | 失敗（`writing-while-off`） |
| `approved` | `unset` | — | 未設定（`not-enabled-here`） |
| `approved` | `off` | — | 已關閉 |
| `approved` | `on` | 前置缺 | 無法使用（attention） |
| `approved` | `on` | `startedBy: operator`，沒有存活 | 未啟動（`manual-start`） |
| `approved` | `on` | 存活、本專案無事件 | 待命 |
| `approved` | `on` | 本專案已接受過 | 記錄中 |
| `removed` | — | 帳本有殘留 | 失敗（`residue`） |
| 讀取失敗 | — | — | 無法確認 |

官方 AI（P4）：同意存在專案層，由每個專案第一次啟用時以原生對話框取得（Spec 073 FR-061–063 儲存）；機器層只有「撤回此電腦上全部」的時間戳（073 的 `ai.revokedAt`）；沒有 `installed`／`update-available`／`conflict`。內建來源沒有機器層的 `approved`（視為恆為 approved），但 shell 有 `configured`。

## 點擊與頁面數（從主畫面起算）

| 目標 | 今天 | 目標 | 依據 |
|---|---|---|---|
| Claude Code／Codex 在本專案被記錄 | ≥8 次、2 個設定頁、1 個原生對話框（08 §5 的計數，未重新實跑） | 設定(1) → 擷取控制(1) → 在此專案記錄(1) → 選擇器(1) → 原生同意(1，每個專案第一次，P4／071 O9) = 每個專案 5 次、1 頁 | FR-074 |
| bundled pcap | 設定(1) → 擷取控制(1) → 複製步驟(1) = 3 次＋終端機（無專案範圍、無憑證） | 設定 → 擷取控制 → 在此專案記錄 → 複製步驟 = 4 次＋終端機；多一次換來專案範圍的憑證與真正的停用 | FR-076 |
| 使用者外掛 Source | 核准後沒有任何安裝路徑（08-F3） | 外掛頁核准（2 次＋原生 1 次）＋來源列 2 次 ≈ 5 次 | P3、FR-074 |

T085 以 e2e 腳本實際計數，取代本表的估計。

## 設計決策

### D1 狀態在核心算一次，main 送答案

**決定**：`status.ts` 是純函式，`capture-health.ts` 收集事實並呼叫它；payload 帶答案與唯讀事實。**否決**：(a) renderer 端的共用 view model（`captureHealthStore` 統一了讀，沒統一解讀；CLI 與 API 也需要同一答案）；(b) 依 04 只改型別而不移位置（renderer 仍可能重組事實）。

### D2 `enabledForProject` 三值

`unset` 與 `off` 今天共用 `enabled !== true`，使「從沒打開」與「刻意關掉」同字（04-F4「已關閉」一字三義）。三值讓 O1 與 S4 分開。AI 的 `on` 必須同時滿足 `resolveAgentCapture`（`agent-capture-policy.ts:27-40`）的全部條件，否則依缺的那一項落在 S5 或 N3。

### D3 需要處理的定義與每來源一則 issue

**決定**：見決策表最後一欄。**否決**：(a) 04 的「enabled 且 unavailable」不分來源是否核心——內建來源大多沒有開關，會使所有缺前置的內建來源都進需要處理，與「缺 python3 → 無可用來源、不 toast」矛盾；(b) 單一 `capture` issue（今天 `StatusBar.tsx:147-152`）：兩個來源失敗只顯示一則。

### D4 啟動寬限期

採 Docker start-period 的語意（PRIOR-ART-C §5.1）：寬限期內暫時性失敗不計，確定性失敗照計。30 秒涵蓋 proxy 啟動與第一次 hooks 偵測；心跳來源 60 秒等於一個窗口（今天 15 秒一次心跳，`capture-health.ts:331-334`）。**否決**：以次數門檻（Fluent Bit 式）——RedLog 的失敗事實大多是一次性的狀態，不是比率。

### D5 每個 shell 一個來源

P8 讓每個有 adapter 的 shell 都裝 hook；每個 shell 讀不同的檔、有不同的 hello，所以事實不同。**否決**：一個 `terminal` 列加子事實（今天的形狀）——它正是 `coreCommandState` 取「任一 ready」掩蓋單一 shell 失敗的原因。牆的問題以呈現處理：儀表板只列需要處理或本專案有 hello 的 shell，設定頁收合從沒用過的。

### D6 HTTP 依 client 記錄四個事實

client 由 flow 推出（HTTP Toolkit 的 Connected Sources），不由驗證流程推出；證明是理由。**否決**：沿用單一的 `httpsVerification`——它在 proxy 停止時清除（04-F3），造成每次啟動的 amber。

### D7 Manifest v2

形狀沿用 08 §3a，三處調整：(1) `emits[]` 加 `reader`，只能指向 Spec 072 的讀者登記；(2) `author` 保留（`PluginDetailPanel.tsx:225` 有讀者），`homepage` 刪除（無讀者）；(3) Processor 的 `terminalProfiles` 留在 Processor（它是設定 shell adapter 的資料，不是每個事件的推導，但仍需核准）。**Exporter 不建**（spec FR-051）。驗證器：手寫最小驗證器，由 schema 產生錯誤訊息，避免 main 多一個執行期相依；`ajv` 只在測試中比對手寫驗證器與 schema 的結果一致（雙實作一致性測試）。**否決**：(a) 08 的 `processor` 與 `source` 都在同一份 manifest（一個資料夾多種 kind）——id、核准與憑證的範圍會變成兩個東西共用；(b) 執行期引入 `ajv`。

被否決的搬動（07 的警告）：把 `builtin-tools` 改成核心程式碼（它是資料，且「不預設操作者用哪些工具」）；把 screenshot、host monitors、managed proxy 改成外掛；建 mapper 管線或 `/api/ingest` 的 raw-first 形狀（DESIGN-plugin-kernel §3）。

### D8 Processor 的時限與紀錄

每事件一個 deadline，所有使用者規則共用（取代 `bounded-regex.ts:125-140` 的「停一條、再跑一趟」）；規則集紀錄放在 `_ingest.rules`（字串陣列，每項 `<pluginId>#<hash12>`，至多 3 項，超過時第 3 項為 `+<n>`）與 `_ingest.rules_partial`（`true` 或省略），Spec 071 已接受（071 FR-005、FR-006）。原提案的 `<pluginId>@<version>#<hash12>` 改為不帶版本的有界形式，因為 071 FR-006 對 `_ingest` 的 512 bytes 上限：典型 `_ingest` 約 320 bytes，三項規則加 `rules_partial` 最多約 175 bytes。版本由內容雜湊在外掛詳情中對照（內容雜湊改變即版本改變）。被停的規則保留到內容雜湊改變。**否決**：在 `data` 另立 `_processor` 或 `_rules` 鍵（多一個保留鍵；071 的蓋章已是唯一由接收端寫的區塊）。

### D9 v1 相容

v1 manifest 轉成內部 v2 形狀，雜湊沿用 v1 算法，既有 grant 有效。v1 不涵蓋 hook 呼叫的同目錄檔（08 §1.5），所以 v1 使用者 Source 的提權步驟在改寫成 v2 前不顯示（理由 `reapproval-needed`，附 `plugin check` 的提示）。bundled 外掛在同一版本改寫成 v2。

### D10 不建 ProofStore 檔

專案層「曾經成功」：Spec 071 在第一次接受某來源的列時記錄里程碑（`ingest_instances` 的 `hello_at` 已有一半）。機器層「這台機器看過這個 shell」：既有的 `~/.redlog/tool-detection/shell:<platform>:<distro>:<shell>.json`（`redlog-relay.py` 寫入，`tool-detection.ts` 讀取）。HTTPS 的「上次已驗證」：既有的每專案 `http-verification` 歷史。**否決**：04 的 `~/.redlog/proofs.json`——又一個機器層檔案，而三份需要的事實都已有寫者。

### D11 原生同意對話框

main 以 `dialog.showMessageBox` 顯示，內容由 main 從自己載入的 manifest 產生；`plugins:grant(id, expectedHash)` 在顯示前與確認後各驗一次。官方 AI 在每個專案的第一次同意由該專案擷取控制的「在此專案記錄」觸發，儲存屬 Spec 073。**否決**：renderer 的 React 對話框（`PluginsPanel.tsx` 今天的做法；05-F5）。

### D12 事實清單的四個新增

`captureError`（今天的 `noteCaptureError`，失敗的主要證據）、`selfCheck`（09-F4 的執行期 doctor；P8）、`residue`（FR-075）、`manifest`／`workdir`／`seenOnMachine`／`machineDisabled`（把今天散在 AI 與外掛判斷中的條件命名）。都在描述與決策表中有固定位置，清單仍封閉。

### D13 存活但不送事件不是失敗

今天 `producerStalled`（`capture-health.ts:828-830`）把「有心跳、10 分鐘沒事件」判為 partial。安靜的網卡或 C2 沒有回連都會產生這種組合；它與「沒有閒置」的決定相同（安靜不是故障）。改為理由 `not-delivering`。**否決**：保留今天的行為——它是 04 所說「時間窗口讓同一台機器在沒變的情況下翻色」的一種。

## 理由與動作（封閉清單）

| 類 | 碼 |
|---|---|
| 無法確認 | `unknown` |
| 失敗（10） | `writing-while-off`、`manifest-invalid`、`residue`、`port-in-use`、`start-failed`、`capture-error`、`detached`、`not-reporting`、`credential-invalid`、`losing` |
| 已關閉 | `switched-off` |
| 無法使用（4） | `missing-prerequisite`、`platform`、`integration-missing`、`project-archived`（073 的唯讀 session） |
| 未設定（9） | `needs-approval`、`reapproval-needed`、`hook-not-installed`（實際讀的檔沒有 hook 行，帳本也沒有記錄寫過；`{file}` 指出實際讀的檔）、`hook-file-missing`（073：帳本記錄寫過，驗證為 `missing`／`modified`，`{file}`）、`not-configured`、`not-enabled-here`、`no-workdir`、`workdir-changed`、`consent-scope-changed`（073） |
| 未啟動（3） | `starting`、`manual-start`、`stopped` |
| 待命／記錄中（12） | `recording-paused`、`in-use-not-recorded`、`no-client-yet`、`elsewhere-proxy`、`seen-on-machine`、`not-yet-seen`、`gap`、`quarantined`、`legacy-door`、`tls-untrusted`、`not-delivering`、`bound-elsewhere`（073：外部終端機綁定在另一個專案） |

另有不需要文字的：`awaiting-first-event`、`recorded`、`clients`（以資料呈現 client 清單）、`output-not-recorded`（沿用 Spec 060 FR-003，計入上限）。有文字的合計 41（上表 40 加 `output-not-recorded`；起草時寫 39，是因為「待命／記錄中」一列的標頭少算了 `bound-elsewhere`），上限隨之從 40 調為 41。073 要求的四個碼（`project-archived`、`bound-elsewhere`、`consent-scope-changed`、`hook-file-missing`）都在清單中（2026-11-12 對帳時補上 `hook-file-missing`：「RedLog 寫過、後來不見或被改」與「從沒寫進實際讀的檔」是不同的修復）。動作 5 個：`open-owner`、`fix-prerequisite`、`prepare`、`retry`、`open-terminal`；「前往」的文字用目的地頁面的既有名稱，不新增 key。

## 資料形狀

**內建描述（節錄）**

```ts
{ id: 'shell:zsh', label: { i18nKey: 'shell.zsh' }, kind: 'shell-adapter',
  emits: ['shell:command_start', 'shell:command_end'],
  scope: 'machine', setup: { by: 'redlog', owner: { page: 'hooks', row: 'shell:zsh' }, projectOptIn: false },
  prerequisites: [{ id: 'python3', kind: 'binary', allOf: ['python3', 'curl'] }, { id: 'posix', kind: 'platform', platforms: ['darwin', 'linux'] }],
  liveness: 'hello', verification: 'hello', startedBy: 'always', core: true,
  shell: { name: 'zsh', platforms: ['darwin', 'linux'], adapter: 'hooks/shell-zsh-hook.zsh' } }
{ id: 'http-proxy', kind: 'managed-service', liveness: 'process', verification: 'http-clients', startedBy: 'redlog',
  prerequisites: [{ id: 'mitmdump', kind: 'binary', anyOf: ['mitmdump'] }], setup: { by: 'none', owner: { page: 'browser', row: 'http-proxy' }, projectOptIn: false }, core: true, … }
{ id: 'agent:claude-code', kind: 'in-process', scope: 'project', liveness: 'none', startedBy: 'redlog',
  setup: { by: 'operator', owner: { page: 'captureControl', row: 'agent:claude-code' }, projectOptIn: true }, core: false, … }
```

**Payload v2（`capture:health`、`/api/status` 的 `capture`）**

```json
{"v":2,"overall":"waiting","attention":0,"paused":false,"checkedAt":1731400000000,
 "integrity":{"chain":"ok","writes":"ok"},
 "statuses":[{"id":"terminal","state":"ready","reason":"awaiting-first-event","action":"open-terminal",
   "owner":{"page":"hooks","row":"terminal"},"attention":false,"since":1731399990000,"facts":{…}}]}
```

**Manifest v2（Source）**

```jsonc
{
  "manifestVersion": 2,
  "id": "pcap-capture", "version": "2.0.0", "label": "Packet capture",
  "engines": { "pluginApi": 2 },
  "kind": "source",
  "files": { "hooks/pcap-capture.sh": "sha256:…", "pcap-capture.js": "sha256:…", "pcap-parse.js": "sha256:…", "pcap-sidecar.js": "sha256:…" },
  "source": {
    "emits": [ { "kind": "scanner:packet_flow", "label": "Packet flow" } ],
    "requires": [ { "binary": { "anyOf": ["tcpdump", "tshark"] } }, { "binary": { "allOf": ["node"] } }, { "privilege": "root" }, { "platform": ["darwin", "linux"] } ],
    "start": { "by": "operator", "steps": [ { "label": "Start capture", "run": "hooks/pcap-capture.sh", "args": ["<iface>"], "elevated": true } ] },
    "stop":  { "steps": [ { "label": "Stop capture", "run": "hooks/pcap-capture.sh", "args": ["--stop"], "elevated": true } ] },
    "liveness": "alive"
  }
}
```

**Manifest v2（Processor）**：`{"manifestVersion":2,"id":"builtin-tools","kind":"processor","files":{…},"processor":{"targetExtractors":[…]}}`。

**消費者登記（節錄）**

```ts
export const FIELD_CONSUMERS = {
  '/manifestVersion': 'src/core/plugins/manifest-v2.ts:parseManifest',
  '/files': 'src/core/plugins/manifest-v2.ts:contentHash',
  '/source/emits': 'src/core/sources/descriptor.ts:descriptorFromManifest',     // 也是 071 憑證的種類範圍
  '/source/emits/*/reader': 'src/core/kinds/plugin.ts:validatePluginKind',     // 072 的唯一入口
  '/source/requires': 'src/core/capture-health.ts:collectPrerequisites',
  '/processor/targetExtractors': 'src/core/plugins/contributions.ts:applyContributions',
  '/author': 'src/renderer/src/components/settings/PluginDetailPanel.tsx:PluginDetailPanel',
  …
} as const
```

## Gates

| # | 規則 | 檔案 | 形式 |
|---|---|---|---|
| G0 | `sources/status.ts`、`vocabulary.ts` 的匯入限制；誰能匯入 `status.ts` | `test/source-status-boundary.test.ts` | 匯入圖掃描（仿 `canonical-ingest-sources.test.ts`） |
| G1 | 決策表每列一案例；property：決定性、整體不取最壞、非 attention 不改整體、寬限期內暫時性失敗不為 failed | `test/source-status-table.test.ts`、`test/source-status-property.test.ts` | 表格驅動；以固定種子的隨機產生器做 property（repo 沒有 fast-check，不新增相依） |
| G2 | renderer 不自行判斷：除 `lib/sourceStatusView.ts` 外不得出現 `.facts`、`.verdict`、`state === 'error'`／`'ready'`／`'unset'`、`ownShellLastEventAt`、`httpsVerification`、`managedHttpProxy`、`captureFacts(`；core 中只有 `status.ts` 可指派 `SourceStateCode` 字面值 | `test/source-status-boundary.test.ts` | ratchet：基準 20，只降（仿 `test/mutation-guard.test.ts`） |
| G3 | 詞表：每個狀態、整體、理由、動作碼在兩個語系恰有一個 key；其他命名空間的值不得等於 12 個狀態字之一 | `test/source-status-vocabulary.test.ts` | 完整性測試 |
| G4 | 改變狀態的 handler 只在 owner：`hooks.install|uninstall`、`httpCapture.start|stop`、`plugins.setEnabled|grant|revoke|remove`、對 `packs`／`packMembers`／`agentTailer.sources` 的設定寫入，只能出現在允許清單的檔案 | `test/source-owner-actions.test.ts` | 允許清單，只能變短 |
| G5 | 描述表完整：每個收集到事實的來源都有描述；每個 `emits` 在 072 的種類登記或為外掛宣告；每個 `owner` 錨點對應一個實際渲染的 `data-source-id`；`src/` 中不得有 shell 名稱的字面陣列（描述表除外） | `test/source-descriptor-registry.test.ts` | 登記完整性＋ratchet（shell 陣列基準 9） |
| G6 | 每份 manifest（`plugins/*`、`optional-plugins/*`、`examples/plugins/*`、文件中的 jsonc）以 schema 驗證；手寫驗證器與 `ajv` 結果一致 | `test/plugin-manifest-schema.test.ts` | 雙實作一致性 |
| G7 | 每個 schema 欄位都有登記的讀者，且該符號存在於該檔 | `test/plugin-manifest-consumers.test.ts` | 登記完整性 |
| G8 | k 條病態使用者規則對單一事件的阻塞 ≤ 時限＋50 ms，不隨 k 成長；寫入路徑上的推導都帶 `_ingest.rules` | `test/processor-budget.test.ts` | 計時（只在 unit leg，以工作量計數為主、牆鐘為輔） |
| G9 | 內容雜湊涵蓋每個檔；未列出的檔為錯誤；載入、顯示步驟、發放憑證前都重算 | `test/plugin-trust-hash.test.ts` | 表格驅動 |
| G10 | v1 遷移：8 種機器狀態 fixture，升級後無靜默停止、grant 不失效、`state.json` 的 pack 旗標轉通知 | `test/manifest-v1-migration.test.ts` | golden |
| G11 | CLI 印出的狀態字等於英文詞表；`/api/status` 舊欄位依對映表 | `test/cli-status-words.test.ts`、`test/api-status-compat.test.ts` | 特徵化 |
| G12 | `plugin-development.md` 的 jsonc 以 schema 驗證；提到的 `examples/` 路徑存在 | `test/plugin-docs-examples.test.ts` | 文件 gate |
| — | 移除不留殘餘 | Spec 073 擁有（08 G4） | 本規格只消費其結果 |

沒有 gate 的規則：「提權步驟執行 root 擁有的複本」的實際權限只能真機驗證（T081）；單元測試只驗證步驟一定經過「複製 → 驗證 → 執行」的包裝（G9 的一部分）。

## 遷移與相容

| 階段（tasks） | 內容 | 相容 |
|---|---|---|
| Phase 1 | 只加 gate 與特徵化：今天 payload 的 golden、每個 surface 對同一 payload 的輸出、G2 ratchet 基準 20、G5 shell 陣列基準 9、G7 以「今天的 schema」先綠 | 行為不變 |
| Phase 2 | 新增 `sources/*`；`capture-health.ts` 改成收集器；payload 同時帶 v1 欄位與 v2 欄位；等價測試記錄每一個刻意差異（新專案 dark → waiting 等） | 舊 UI 讀 v1 欄位，不受影響 |
| Phase 3 | 整體換源：captureIssueView、StatusBar、RecordingWorkspace、CLI、`/api/status` | 契約變更；斷言舊整體的 test／e2e 同 PR 修改 |
| Phase 4 | 儀表板卡與 HTTP 列換源；刪除 `healthyGap`、`coreGap`、`coreCommandState` | 同上 |
| Phase 5 | 設定列、外掛詳情、AgentsPanel、ExternalCaptureGroup、pane 徽章換源；刪重複的動作（G4） | 同上 |
| Phase 6 | 首次使用＝儀表板同一清單；退役 i18n key；刪 `captureFacts`、`captureReadiness`、`coreCapture` | verify:i18n 列出斷言已刪字串的檔 |
| Phase 7 | manifest v2：schema、解析、雜湊、消費者登記；bundled 改寫為 v2；刪 starter-pack／pack-* manifest；`state.json` 旗標轉通知 | v1 照讀、grant 有效 |
| Phase 8 | 生命週期：原生核准、在此專案記錄、憑證發放與撤銷（依 071）、移除結果（依 073） | 依姊妹規格落地順序 |
| Phase 9 | Processor 每事件時限與規則紀錄 | 新列多一個鍵；舊列不動 |
| Phase 10 | 開發者體驗與文件 | — |

升級後的第一次啟動（Phase 7）：(1) 讀 `state.json`，bundled pack 與 starter-pack 的停用旗標寫成一次性通知並刪除；(2) 官方 AI 的收據交給 Spec 073 轉成同意紀錄（`installationId` 不變）；(3) 對每個在升級前「在擷取」的來源（依升級前最後一次 payload，若有）比對升級後第一次狀態，不符者記入 `debug-log` 並在該列以理由呈現（FR-071）。

## 對姊妹規格的需求與提供

| 規格 | 本規格需要（名稱為提案，由該規格決定最終名稱） | 本規格提供 |
|---|---|---|
| 071 寫入契約 | 每個來源的存活表讀取（`hello`／`alive`／`bye`，071 FR-110；含 shell 名、hook 版本、`parent_session`）；自我檢查的 `detached{by}`（**071 的信封尚未定義，跨規格協調中**，見 spec 開放問題下的注記）；每來源每專案的「第一次接受」與「最近一次接受」時間（071 FR-056、`ingest_producers`）；遺失帳本的累計，依 071 FR-050 的原因名稱（非有意、有意、待確認、停用後被拒）與最近一次非有意窗口的結束時間（071 FR-056）；隔離區計數；舊入口使用；憑證登記狀態與發放、撤銷（071 FR-072、FR-076）；專案層啟用的強制（071 FR-07A）；`/api/whoami`（071 FR-07B）；`_ingest.rules`／`rules_partial`（071 FR-005、FR-006，有界形式） | 描述的 `emits`（＝`plugin:<id>` 憑證的種類範圍）；`enabledForProject`（071 FR-07A 的政策輸入）；第一次在任一專案啟用的時刻（＝發放時機）；機器層停用與移除（＝撤銷時機）；狀態 payload（`/api/whoami` 的內容） |
| 072 種類與讀者 | `KindId`、`ReaderId`；`requireKind(id)`（內建描述的 `emits` 在 G5 以它檢查）；`validatePluginKind(pluginId, {kind, label, reader?})`；`kindOf(row, plugins)` 需要的外掛宣告由本規格的 manifest 狀態提供 | 每個描述的 `emits`（取代 072 清點表 #28 的 capture-health 探測表）；manifest `emits[]` |
| 073 專案執行期、設定範圍、安裝帳本 | `ProjectSession` 以專案為範圍持有狀態快取與 issue 狀態（換專案即重置），並提供 session 模式（唯讀）；`enabledForProject` 的設定位置（專案）與機器層停用（機器）；安裝帳本的每 shell 事實（`present`／`missing`／`modified`，對該 shell 實際讀的檔）、`residue(owner)`、`revert(owner) → { reverted, irreversible[] }`；同意事實（`consentState`）與終端機綁定事實；官方 AI adapter 從 app 本體載入、收據轉同意 | 描述的 `owner`、`scope`、`setup`；官方 AI 描述的 `adapter.readRoots`／`emits`／`digest`（＝073 的 `adapterDeclaration(kind)`）；073 要求的 4 個理由碼；移除結果的呈現。「已寫入」與「hello」的合成不另建 ProofStore：兩者是本規格的兩個事實，由狀態函式合成（D10；073 已改寫為直接取用） |
| 074 查詢與投影 | 「某種類最後一筆的時間」經 074 的 `query` 讀 `kind_totals`（不直接讀表），語意等於今天 `newestEvent` 的探針（`capture-health.ts:368-384`）；在那之前收集器保留今天的探針 | 事實的定義；074 的 `capture` topic 的內容（＝payload v2 變更時發布） |

衝突的歸屬：「hook 寫進哪個檔」屬 073；「hook 有沒有載入」的事實（hello）屬 071 的傳輸、本規格的解讀；「種類是否 chained」屬 072；「這個來源的狀態」只屬本規格。

## 驗收（工作計畫的三條規則）

1. **擷取可信度以真實來源端到端驗證**：zsh（含 `ZDOTDIR`）、macOS bash（login shell）、PowerShell 5.1／7、受管 proxy 加真實瀏覽器與 curl、bundled pcap 在 sudo 下、Claude Code 對話；每一項記錄狀態字的變化序列（未設定 → 待命 → 記錄中）與失敗注入（拆掉 hook、停用外掛後繼續送、proxy 埠被占用）的結果。
2. **契約落地時在真實 app 檢查讀它的介面**：儀表板擷取卡、狀態列（dot、label、tooltip、注意數、toast）、設定 ▸ 指令與終端、設定 ▸ HTTP、設定 ▸ 擷取控制（AI、pack、外部 Source 列）、外掛頁與詳情、首次使用、HUD、終端機 pane 徽章、`redlog-cli status`、shell 內 `redlog status`。每個 surface 截一張圖，與同一時刻的 payload 對照。
3. **「已決定／已實作／已驗證」分開**：`verification.md`（T100）分三欄記錄；真機項目沒有環境時記 NOT RUN 與原因，不以單元測試代替。

## 風險

| 風險 | 處理 |
|---|---|
| 新規則讓某個真實的失敗不再進需要處理（例如 D13） | 等價測試列出每個刻意差異；真機注入清單涵蓋 |
| 寬限期掩蓋快速、重複的失敗 | 確定性失敗不受寬限期影響；寬限期只從「開始」起算一次 |
| 外部 agent 讀 `/api/status` 的舊欄位 | 舊欄位保留一個 minor 版本，對映表有特徵化測試（G11） |
| 姊妹規格的事實尚未落地 | 每個事實有「今天的對等來源」與理由標示（spec Assumptions）；決策表不因事實缺席而誤判為失敗（缺席 = unknown） |
| 101 個 key 一次退役造成大 PR | 依 Phase 3–6 分批退役，每批只退役該批換源的 surface 用到的 key |
| manifest v2 讓使用者外掛需要重新核准 | v1 照讀、grant 有效；只有作者改寫成 v2 時才需要 |
| 手寫驗證器與 schema 漂移 | G6 的雙實作一致性測試 |

## 驗證策略

- **表格與 property**：G1。
- **render**：9 個 surface 對同一 payload（Phase 1 先釘今天的輸出，之後逐一翻轉）。
- **等價**：Phase 2 的新舊對照，沿用 `test/capture-health.test.ts` 的怪列矩陣。
- **e2e（ubuntu）**：首次使用、擷取設定互動、官方 AI、外掛探索、終端機 enrollment 各補一條「同一個字」的斷言。
- **真機**（不能以單元測試取代）：
  - macOS：新專案 × {有 hook、無 hook}；重開 app 20 次（SC-002）；`ZDOTDIR`；Terminal.app 的 bash；螢幕錄製權限未決定與拒絕（04-U7）；pcap 在 sudo 下修改 hook 檔後執行步驟必須失敗。
  - Linux 容器：移除 python3 的新專案（04-U6a）；fish 為預設 shell 的 pane（U6b）。
  - Windows：PowerShell 5.1／7、VS Code PowerShell host、Restricted 執行原則（04-U8）；WSL。
  - 打包版：官方 AI 從 app 本體執行，換一版 adapter 後仍在記錄；`state.json` 有 pack 停用旗標的升級。

## Project Structure

### Documentation (this feature)

```text
specs/075-source-status-and-plugin-manifest/
├── spec.md
├── plan.md
├── tasks.md
└── verification.md        # T100 建立
plugins/plugin.schema.json # manifest v2 的唯一定義
```

### Source Code

```text
src/core/sources/{vocabulary,descriptor,status}.ts      # 新增
src/core/capture-health.ts                              # 改為事實收集器（檔名不變）
src/core/plugins/{manifest-v2,manifest-consumers}.ts    # 新增；manifest.ts 的 v1 驗證併入 manifest-v2
src/core/plugins/{loader,contributions,trust,state}.ts  # 改讀 manifest-v2；trust 不再記 operator id
src/core/hooks-manager.ts                               # 刪 loadStarterPack 與 STARTER_PACK_FALLBACK，改讀描述表
src/core/capture-packs.ts                               # isPackAvailable 不再看外掛
src/core/bounded-regex.ts、command-tagger.ts、target-extractor.ts、loot-detector 等  # 每事件 deadline
src/main/ipc/plugins.ts                                 # grant(id, expectedHash)、原生對話框
src/renderer/src/lib/sourceStatusView.ts                # 新增
cli/redlog-cli.js                                       # 印狀態字
plugins/*/plugin.json                                   # 改寫為 v2；刪 starter-pack、pack-*
test/source-*.test.ts、plugin-manifest-*.test.ts、processor-budget.test.ts …
```

**Structure Decision**：在 `src/core/` 下新增 `sources/` 一個小目錄（三個檔），不搬動其他檔案；`capture-health.ts` 保留檔名以免牽動既有匯入與測試。

## Complexity Tracking

| 新增 | 解決的現存問題 | 較簡單做法為何不夠 |
|---|---|---|
| `src/core/sources/` 三個檔 | 20 處獨立判斷、2 組設定位置對照（04-F1、F5） | 只改型別（04 §6.2）仍允許 renderer 重組事實；需要一個能被 CLI 與 API 共用的擁有者 |
| `plugin.schema.json` 加手寫驗證器 | 3 份 schema，宣告了的欄位沒有行為（08-F1） | 只刪欄位：下一個欄位一樣會先宣告、後補行為；需要消費者登記 gate |
| 消費者登記表 | 同上 | 文件約定無法執行 |
| v1 轉譯層 | 不中斷既有外掛與 grant（FR-071） | 一次改寫所有外掛：使用者外掛不在 repo 內 |
