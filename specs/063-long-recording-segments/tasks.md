# Tasks

- [x] T001 Reproduce capacity loss and missing segment attribution with failing tests.
- [ ] T002 Rotate bounded cast files; preserve range/time reads, hashes, recovery and indexing.
- [ ] T003 Export every companion and attribute/approve every cast part.
- [ ] T004 Preserve long foreground, background and external PTY output with bounded working memory; fault-test interruption, refusal, pause and disk/transport failures.
- [ ] T005 Inventory and validate long HTTP/SSE/WebSocket persistence/export under #290.
- [ ] T006 Run focused regression, typecheck/build, affected desktop/package acceptance.
- [ ] T007 Execute Windows/WSL/Kali native acceptance; keep #432 unmerged until conflict and runtime checks are resolved.

## 2026-10-30 執行對帳入口

依 [工作計畫批次 0／1](../../docs/WORK-PLAN.md) 接續。以下任務已有局部程式與證據，保留 checkbox 以代表原完整門檻；不能再從零實作分段。

| 任務 | 已存在的對帳起點 | 尚需核對 |
|---|---|---|
| T002／T003 | [TerminalRecording](../../src/main/terminal-recording.ts)、[recording tests](../../test/terminal-recording.test.ts)、[export attachments](../../test/export-attachments.test.ts)；Spec 064 T007／verification 的 Mac 分段與成品證據 | 各種來源、range／time／index、核准與 companions 是否完整符合本 spec；平台差額 |
| T004 | 現有 relay、[late-output tests](../../test/relay-late-output.test.ts)、Spec 064 S1 與 #291 | 長時間、前景／背景／外部 PTY、中斷、拒絕、pause、磁碟與 transport 失敗逐項實測 |
| T005 | 既有 mitmproxy source、body store／index 與 #290 | HTTP／SSE／雙向 WS 何時落盤、途中斷線及匯出能讀到的 bytes；不以 PTY 結果代替網路串流 |
| T006／T007 | 既有 macOS 候選與 064 test-coverage-matrix | 先核對 #432 目前狀態，不再照舊敘述假定 PR 未合；Windows／WSL／Kali 與完整 feature gate 仍待 |

#291／#290 管功能可靠性，#296 管測試集合，#457 協調缺少的實機環境。各自回填原證據，不以本對帳表取代驗收。
