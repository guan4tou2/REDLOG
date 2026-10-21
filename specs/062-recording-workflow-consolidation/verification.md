# Verification: Recording workflow consolidation

Overall status remains Draft. Existing bounded Mac acceptance and three prior fixes: see mac-acceptance-20261021.md and fix-verification.md. This record covers the US6 slice, not a claim that all stories passed.

## RED
- 8 個新行為案例先跑，全數失敗：舊介面沒有直接 dialog、格式／範圍獨立控制或 loading 取消；舊介面不會在開啟時解析選取。
- 原生操作發現附件重算後焦點落到背景；在 export-attachment-list.test.tsx 加入焦點斷言先跑，1 failed。

## GREEN
- 新單一視窗測試擴為 11 個；9 檔相關 UI/架構回歸共 68 tests passed。
- Electron 6 條原流程通過；擴大後英／繁中分頁匯出各 1 條通過（106 筆，超過搜尋一頁100筆；切換格式、晚到事件隔離、空及錯誤 query）。
- 焦點修正的相關 2 檔12測試通過。
- 第一輪 typecheck、verify:i18n、verify:architecture、verify:specs、build、diff check 通過。最後焦點修改後單一 worker 重跑 9 檔68測試通過；一次平行重跑有4個 worker 啟動逾時，屬環境失敗，沒有將它算通過。

### 最後檢查（2026-10-22）

- `vitest run --maxWorkers=1 --no-file-parallelism` 指定9檔：68 passed。
- `playwright test e2e/export-preview.spec.ts e2e/filtered-export.spec.ts e2e/external-session.spec.ts`：7 passed，包括新附件焦點／底部按鈕區可見性測試。
- `typecheck`、`verify:i18n`、`verify:architecture`、`verify:specs`、`build` 與 `git diff --check` 通過。最後只有CSS捲動區分離及E2E追加；typecheck、build、7條受影響E2E再次通過。
- 一次帶原生驗收App同時執行的E2E發生afterAll退出逾時，四個行為斷言均通過；結束原生候選App後完整7條通過。沒有放寬timeout或修改產品退出程式來消除此失敗。
- 版面分離屬低風險CSS：不改選取／執行語義；焦點缺陷有RED，版面另有實際Electron幾何斷言，不以模擬DOM尺寸當桌面驗證。

## Operational Verification
Risk surface: export renderer / existing local ExportPlan integration. No capture or package resource contracts change. Native Mac 新視窗、NDJSON內容、bundle附件排除與簽章驗證通過；見 export-acceptance-20261022.md。最終候選包以 Tab 移至附件、空白鍵排除後，確認焦點仍留原核取方塊。捲動區改為與按鈕分開後，小視窗版面由 Electron 回歸確認，未另重包手動驗收該 CSS 排列。 Windows installation NOT RUN on this host.

## Release Impact
| Item | Result |
|---|---|
| User-visible | yes |
| Breaking | no persisted contract changes |
| Packaging affected | no packaged resource or installer changes |
| CHANGELOG updated | yes; unified dialog and prior Mac fixes recorded |
| Upgrade note required | no |
| Packaged smoke required | no resource change; native candidate export check required |

## Gates
| Gate | Result | Date |
|---|---|---|
| Clarify | No new questions for US6: supplied decisions fix range independence, existing formats, exclusions and one confirmation. AI installation handled separately. | 2026-10-21 |
| Checklist | US6 reviewed for default current selection, all-page completeness, capabilities, races, failure, keyboard and narrow windows; acceptance remains open. | 2026-10-21 |
| Analyze | No conflicts in bounded US6 plan/spec/tasks. Existing domain selection contract is reused. Other US1–5/7 work explicitly remains open; no claim of full completion. | 2026-10-21 |
| Converge | US6 的8個 acceptance scenarios、FR-012–014及相關FR-016逐項對照無新增實作缺口；使用既有領域契約，9項憲法原則無例外。全062仍有US5及跨平台驗收等已列T007–T013，不宣稱全規格收斂。 | 2026-10-22 |

## US5 / T014 installation-backend increment（2026-10-22）

Scope: local catalog/install/uninstall only. Installation metadata does not activate an adapter, write project configuration, install an AI tool or download code. Existing AI source activation/global scope behavior remains until T015–T018; whole-US5 uninstalled/read-isolation claims are NOT verified yet.

### RED

- New real-filesystem manager tests against the stub: 8 failed / 9 passed, including empty catalog, absent manifest installation and preservation behavior.
- New IPC tests before handlers existed: 6 failed because the catalog/install/uninstall channels were not registered.
- Partial removal test first failed: cleanup error did not report that the manifest was already removed. Test injection initially spied on a different fs import wrapper; aligned the existing default-fs import convention, then verified the changed=true error path.

### GREEN

- `vitest run --maxWorkers=1 test/official-agent-plugins.test.ts test/official-agent-plugins-ipc.test.ts test/plugins-ipc-audit.test.ts test/plugins.test.ts`: 4 files, 51 passed.
- `playwright test e2e/official-agent-installation.spec.ts`: 1 passed. A fresh isolated HOME has three not-installed entries; Codex install creates only its manifest; project config is byte-equivalent through API; modified manifest is protected; uninstall preserves existing evidence. This is automated Electron integration, not manual UI acceptance.
- typecheck, architecture, i18n and build passed. No renderer controls or capture producer changed in this increment; no new packaged resources. Packaging and Windows native acceptance remain open in T019.

### Gates / convergence

Clarify: no additional question for allowlisted local installation; existing decisions are sufficient. Checklist/Analyze: reviewed no default filesystem writes, no extra destination input, no transcript reads in this manager, explicit IO errors, ownership and non-recursive deletion; canonical plugin format/loader/IPC reused. Converge: T014 complete; T007 and T015–T019 remain open, with the activation/scope/UI gap explicitly recorded rather than marked complete. No domain invariant changes in this installation-only increment; capture lifecycle contract integration stays T018.

Release impact: backend scaffolding only, no new operator workflow yet; CHANGELOG explicitly identifies the increment as inactive groundwork. No release or main merge performed.
