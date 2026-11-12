# RedLog 文件入口

> **狀態**：current  
> **範圍**：`docs/` 的索引與放置規則  
> **最後核對**：2026-11-12 於 `main@aaee01fd`（本頁連結與目錄結構）

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
| 現在什麼是真的：程式、spec 狀態、候選成品 | [目前狀態](CURRENT-STATUS.md) |
| 下一步：待辦、issue 歸屬、依賴與驗收批次 | [工作計畫](WORK-PLAN.md) |
| 全部 70 份 spec、正式狀態與舊任務對帳 | [Spec 索引](../specs/README.md) |
| 每次審查、提案、計畫、追溯及驗收快照 | [Records 索引](records/README.md) |
| 已失效設計與早期 roadmap | [Archive 索引](archive/README.md)，不當作現況或開發清單 |

過去的 audit、重新核對與計畫只是其當時版本的發現，不能直接當成現在尚未修復，也不加入新排程；它們都在 [records/](records/README.md)。[DESIGN-OPEN-ITEMS](archive/DESIGN-OPEN-ITEMS.md) 的原始 backlog 已標清空，保留設計推理。

## 工程與驗證

| 需求 | 文件 |
|---|---|
| 程式／檔案架構、責任與查找方式 | [Architecture](ARCHITECTURE.md) |
| 詞彙與穩定領域契約 | [Glossary](domain/glossary.md)、[Capture lifecycle](domain/SPEC-capture-source-lifecycle.md)、[Scope](domain/SPEC-scope-evaluation.md)、[Query](domain/SPEC-search-query-semantics.md)、[Selection](domain/SPEC-export-event-selection.md)、[Target identity](domain/SPEC-target-identity.md)、[Query completeness](domain/INVENTORY-query-completeness.md) |
| 測試分層、命令與驗收責任 | [Testing](TESTING.md)、[Packaged smoke](PACKAGED-SMOKE.md)、[CLAUDE.md](../CLAUDE.md) |
| 發布、候選與安裝包檢查 | [Releasing](releasing.md)、[Release checklist](RELEASE_CHECKLIST.md)、[Release smoke](RELEASE-SMOKE-TEST.md)；`RELEASE-v*.md` 是版本紀錄 |
| 開發／agent 工作規則 | [AGENTS.md](../AGENTS.md)、[CLAUDE.md](../CLAUDE.md)、[Constitution](../.specify/memory/constitution.md)、[Agent routing](agent-routing.md)、[Token-saving tools](TOKEN-SAVING-TOOLS.md) |

## 產品與 UI

- [Product positioning](PRODUCT-POSITIONING.md)：使用者與產品邊界。
- [UIUX Standard](UIUX-STANDARD.md)、§25 控制項與文案：現行 UI／文案規則，唯一的全域 UI 標準。[控制項與文案](UIUX-CONTROLS-AND-COPY.md) 已併入 §25，只保留原始論述。
- [Alert roles](ALERT-ROLES.md)、[Layout reliability](LAYOUT-RELIABILITY.md)：警示語意與布局契約。
- [Design project sync](design-project-sync.md)：設計與來源對照；同步日期不代表整體驗收完成。

現行設計（`design/`）：

- [Design principles](design/DESIGN-PRINCIPLES.md)（§1 已被下一份取代）、[Core and capture](design/DESIGN-core-and-capture.md)：產品核心與擷取覆蓋。
- [Capture trust](design/DESIGN-capture-trust.md)：擷取與保存的真實性要求，§12 為日期快照。
- [Project runtime](design/DESIGN-project-runtime.md)：重構順序（R0–R8）與專案生命週期邊界；§4 為日期快照。
- [Plugin kernel](design/DESIGN-plugin-kernel.md)、[E1 target extractors](design/DESIGN-E1-target-extractor-plugins.md)：核心＋外掛與 envelope。
- [Two-tier chain](design/DESIGN-two-tier-chain.md)、[Logged-tier retention](design/DESIGN-logged-tier-retention.md)：chained／logged 兩層與保存期限。
- [Traffic capture](design/DESIGN-traffic-capture.md)、[Traffic attribution](design/DESIGN-traffic-attribution.md)：HTTP 擷取路徑與依工具歸因。
- [Stitch 整合設計](design/UIUX-STITCH-DESIGN.md)：跨頁設計決策與 React 整合契約，Draft，2026-11-06 快照。
- [Forensic Editorial](design/UIUX-FORENSIC-EDITORIAL.md)：尚未完成的全產品視覺與操作矩陣，由 Spec 062 承接。

研究筆記（`research/`）：[Tool design analysis](research/RESEARCH-tool-design-analysis.md)、[Onboarding references](research/RESEARCH-onboarding-references.md)。外部產品的參考，不是需求。

## 文件放置規則

`docs/` 根目錄保留跨版本的使用手冊、工程入口、標準與少數長期參考。現行設計放 `design/`，穩定語意放 `domain/`，研究筆記放 `research/`，跨 feature 的當次紀錄放 `records/YYYY-MM-DD/`，被取代的提案放 `archive/`，feature 的執行文件留在 `specs/NNN-slug/`。

| 文件 | 位置 |
|---|---|
| 使用手冊、工程入口、標準、長期參考 | `docs/` 根目錄 |
| 仍描述系統應如何運作的設計 | `design/`；不再成立時移到 `archive/`，開頭加一行 superseded-by |
| 有日期的 audit、重新核對、驗證、同步狀態、當日計畫、issue／spec 檢查、效能量測（含其腳本） | `records/YYYY-MM-DD/`，日期取文件自述的檢查或量測日 |
| 外部產品與方法研究 | `research/` |
| 某一版的發布說明 | `docs/RELEASE-v<版本>.md`，留在根目錄：`.github/workflows/release.yml` 以此路徑作 release body |
| feature 的 spec、plan、tasks、verification | `specs/NNN-slug/`；`docs/` 不複製其任務或結果 |

狀態與計畫各只有一頁：現況在 [CURRENT-STATUS](CURRENT-STATUS.md)，下一步在 [WORK-PLAN](WORK-PLAN.md)。其他文件不維護狀態表或待辦；需要記下當天的狀態或計畫時寫成 record，並在開頭指回這兩頁。不要為每次整理複製另一份 roadmap、狀態總表或測試矩陣。

**新增 record**：建 `records/YYYY-MM-DD/`（已有就沿用），檔名描述內容，日期已在目錄名，不必重複；開頭寫日期、檢查對象的 commit、平台與結果，並在 [records 索引](records/README.md) 加一列。record 寫成後不改寫；後來的更正以日期補記附加。

**非 record 文件的開頭**（根目錄與 `design/`）用三行：

```markdown
> **狀態**：current｜draft｜superseded-by <連結>
> **範圍**：這份文件管什麼
> **最後核對**：<日期> 於 <commit> 核對了什麼；沒核對就寫「本次整理未重新核對」
```

英文文件用 `Status`／`Scope`／`Last verified`。`domain/` 與 `specs/` 依各自的範本，不套用此格式。

**檔名**：新文件用 `UPPER-KEBAB-CASE.md`，不用底線。既有檔名（小寫參考文件、`RELEASE_CHECKLIST.md`、`WINDOWS_COMPAT_AUDIT.md`）不為統一而改名，因為外部連結、`src/` 註解與 CI 以原名引用。

移動文件時用 `git mv`，並修正本機相對連結及 inline repo 路徑（含 `src/`、`test/` 註解中的路徑）；保留固定 commit／release URL、原始測試日期與 hash。`CHANGELOG.md` 是發布歷史，不隨搬移改寫。
