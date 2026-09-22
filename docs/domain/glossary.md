# RedLog Domain Glossary (Ubiquitous Language)

> 所有 code、spec、test、PR 描述應使用這份術語表的定義。
> 對一個概念有多種理解時，以本表為準。

| Term | 定義 |
|------|------|
| **Event** | 已發生的 atomic fact，不可變。有兩個存儲 tier（Chained / Logged）但對 Investigation surface 而言是同一抽象。 |
| **Chained Event** | 寫入 `events` 表的 Event，帶有 hash chain + Ed25519 signature，構成 tamper-evident evidence spine。 |
| **Logged Event** | 寫入 `events_logged` 表的高頻低價值 Event（HTTP flow、DNS、pcap、browser console、agent thinking、process monitor）。無 hash chain。 |
| **Evidence** | 支撐 Event 的原始不可變資料——HTTP body（content-addressed sidecar）、terminal cast、screenshot JPEG、附加檔案。 |
| **Activity** | 由相關 Events 投影出的 operator interaction（例如 HTTP History 的 Flow→Activity grouping）。Activity 是 projection，不是 DB table。 |
| **Target** | Engagement 中被觀察或操作的 canonical asset identity。由 `target_id` column 定義（IP / hostname / CIDR）。`data.detectedTarget` 是觀察 metadata，不是 canonical identity。 |
| **Observation** | 對 Target 的 hostname / IP / service / port 等觀察，可能多個 Observation 對應同一 Target。 |
| **Scope** | Engagement 的 authorization policy——定義哪些 Target 在授權範圍內。Scope evaluation 必須使用唯一的 canonical evaluator。 |
| **Scope Violation** | 與 Scope policy 衝突的 first-class Event，由 companion event 機制產生。 |
| **Loot** | Operator 取得的 credential / secret / artifact / sensitive data。 |
| **Pivot** | 建立到另一網路 / target 的 operational route。 |
| **Marker** | Operator 手動標記的 investigation note / bookmark。與 Event 不同，Marker 永遠是 chained。 |
| **Cause** | 一個 Event 對另一 Event 的因果關係，存於 `_causes` field。RedLog 的核心差異化能力。 |
| **Engagement** | 一次 pentest / red team operation 的完整 session 週期。 |
| **Recording** | RedLog 的 capture state——recording / paused。Paused 時只有 system / marker event 繼續寫入。 |
| **HTTP Flow** | 一對 HTTP request + response，以 `flow_id` 配對。Body 可能 externalized 到 sidecar。 |
| **Evidence Chain** | Chained Event 的 hash chain + signature 序列，構成不可否認的 audit trail。 |
| **Export** | 將 Events + Evidence 輸出為可交付格式（NDJSON / CSV / Evidence Bundle）。Export 永遠是 copy，原始 DB 不可變。 |
| **Export Selection** | Export 時的 event 選取策略。必須涵蓋所有 persisted event tier（chained + logged），除非 policy 明確排除。 |
| **Sanitization** | Export 時的 scope-aware 清理——out-of-scope event 的 operator PII 移除。只在 export copy 上操作。 |
| **Personal Domain** | Operator 標記為個人用途的 domain（例如 gmail.com），export 時完全排除。 |
| **Do-Not-Export** | 由 operator 標記或 policy 決定完全排除出 export 的 event。 |

## Bounded Contexts

```
Capture              Evidence              Engagement
├─ Terminal          ├─ Event              ├─ Target
├─ HTTP              ├─ Evidence           ├─ Scope
├─ Browser           ├─ Integrity          ├─ Pivot
├─ Agent             └─ Relationships      ├─ Loot
└─ Screenshot                              └─ Marker

Investigation        Handoff
├─ Timeline          ├─ Export Policy
├─ Search            ├─ Sanitization
├─ Transcript        ├─ NDJSON
├─ Target View       └─ Evidence Bundle
├─ HTTP History
└─ Replay
```

## Domain Invariants

1. **Evidence Immutability**: Recorded Event 不得以破壞 evidence chain 的方式被修改。所有 masking / sanitization 只在 export copy 上操作。
2. **Target Canonical Identity**: 每個 target-oriented query 必須使用相同的 canonical target identity semantics（`target_id` column）。
3. **Export Completeness**: Export selection 必須涵蓋所有 persisted event tier。Preview 和 actual export 必須使用相同的 selection policy。
4. **Scope Canonical Evaluation**: Scope evaluation 必須使用唯一的 canonical evaluator，不允許多份 copy 有不同 semantics。
5. **Cause Provenance**: Derived event 必須保留對 causing event(s) 的 provenance reference。
6. **Observed Artifact Correlation**: cwd 與時間重疊只能形成明確標示為推測的 command candidate，不得寫成 `_causes`。多個候選必須全部保留；只有 producer 提供直接來源證據時才能建立 cause。
