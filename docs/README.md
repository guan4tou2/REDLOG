# RedLog 文件入口

文件按操作、工程、規格與歷史分流；此頁不宣告未經驗收的版本能力。RedLog 保存已接入來源能觀測到的操作與 HTTP(S) 證據；沒有事件不等於沒有操作，來源 running 也不等於完整擷取。

## 使用與接入

| 需求 | 文件 |
|---|---|
| 安裝、首次使用、日常記錄與交付 | [操作者手冊](USER-GUIDE.md)、[內測說明](INTERNAL-TESTING.md)、[專案 README](../README.md) |
| Windows／WSL 設定與開發 | [Windows setup](windows-setup.md)、[Windows development](windows-development.md) |
| 外部終端與顯式 session recording | [External session recording](external-session-recording.md)、[Agent integration](agent-integration.md) |
| Agent、REST、外掛 | [Agent integration](agent-integration.md)、[API reference](api-reference.md)、[Plugin development](plugin-development.md) |
| 證據鏈、事件與清洗 | [Audit trail](audit-trail.md)、[Event schema](event-schema.md)、[Redaction design](redaction-design.md)；設計頁的歷史說法需對照現行契約 |

## 接續工作

| 需求 | 唯一入口 |
|---|---|
| 目前程式與候選成品的區別 | [目前狀態](CURRENT-STATUS.md) |
| 待辦、issue 歸屬、依賴與驗收批次 | [工作計畫](WORK-PLAN.md) |
| 全部 64 份 spec、正式狀態與舊任務對帳 | [Spec 索引](../specs/README.md) |
| 最近一次修復與實測結果 | [2026-10-29 完成紀錄](records/2026-10-29/UIUX-COMPLETION-2026-10-29.md) |
| 每次審查、提案、追溯及驗收快照 | [Records 索引](records/README.md) |
| 已失效設計與早期 roadmap | [Archive 索引](archive/README.md)，不當作現況或開發清單 |

[DESIGN-OPEN-ITEMS](DESIGN-OPEN-ITEMS.md) 的原始 backlog 已標清空，保留設計推理；後續不是再從它的舊步驟開發。過去 audit 文件也只是其當時版本的發現，不能直接當成現在尚未修復。既有 [2026-08 correctness audit](AUDIT-2026-08-08.md)、[2026-08 UX audit](UX-AUDIT-2026-08.md)、[2026-09 AI log audit](AUDIT-2026-09-18-app-ai-log.md) 及 [回應](AUDIT-2026-09-18-RESPONSE.md)、[2026-09 findings](AUDIT-2026-09-19-current-findings.md)、[engineering review](AUDIT-2026-09-19-engineering-methods.md)、[Windows compatibility audit](WINDOWS_COMPAT_AUDIT.md) 保留舊位置供既有引用存查，不加入新排程。

## 工程與驗證

| 需求 | 文件 |
|---|---|
| 程式／檔案架構、責任與查找方式 | [Architecture](ARCHITECTURE.md) |
| 詞彙與穩定領域契約 | [Glossary](domain/glossary.md)、[Capture lifecycle](domain/SPEC-capture-source-lifecycle.md)、[Scope](domain/SPEC-scope-evaluation.md)、[Query](domain/SPEC-search-query-semantics.md)、[Selection](domain/SPEC-export-event-selection.md)、[Target identity](domain/SPEC-target-identity.md) |
| 測試分層、命令與驗收責任 | [Testing](TESTING.md)、[Packaged smoke](PACKAGED-SMOKE.md)、[CLAUDE.md](../CLAUDE.md) |
| 發布、候選與安裝包檢查 | [Releasing](releasing.md)、[Release checklist](RELEASE_CHECKLIST.md)、[Release smoke](RELEASE-SMOKE-TEST.md)；`RELEASE-v*.md` 是版本紀錄 |
| 開發／agent 工作規則 | [AGENTS.md](../AGENTS.md)、[CLAUDE.md](../CLAUDE.md)、[Constitution](../.specify/memory/constitution.md) |

## 產品與 UI

- [Product positioning](PRODUCT-POSITIONING.md)：使用者與產品邊界。
- [Capture trust](DESIGN-capture-trust.md)：擷取與保存的真實性要求，現況快照按日期閱讀。
- [Project runtime](DESIGN-project-runtime.md)：重構順序（R0–R8）與專案生命週期邊界；R1a 已實作，§4 為日期快照。
- [UIUX Standard](UIUX-STANDARD.md)、[Controls and copy](UIUX-CONTROLS-AND-COPY.md)：現行 UI／文案規則。
- [Forensic Editorial](UIUX-FORENSIC-EDITORIAL.md)：尚未完成的全產品視覺與操作矩陣，由 Spec 062 承接。
- [Alert roles](ALERT-ROLES.md)、[Layout reliability](LAYOUT-RELIABILITY.md)：警示語意與布局契約。
- [Design project sync](design-project-sync.md)：設計與來源對照；同步日期不代表整體驗收完成。

## 文件放置規則

`docs/` 根目錄保留跨版本的使用手冊、工程入口與標準。穩定語意放 `domain/`，跨 feature 的當次紀錄放 `records/YYYY-MM-DD/`，被取代的提案放 `archive/`，feature 的執行文件留在 `specs/NNN-slug/`。

移動文件時修正本機相對連結及 inline repo 路徑，保留固定 commit／release URL、原始測試日期與 hash。不要為每次整理複製另一份 roadmap、狀態總表或測試矩陣；從本頁與工作計畫連到原權威來源。
