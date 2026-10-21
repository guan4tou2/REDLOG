# 下一切片：AI 擷取插件按需安裝（US5）

**狀態：T014 本機安裝底層完成；啟用、專案目錄與 UI 尚未實作。** 不把現有三個 checkbox 視為已滿足「未安裝」。此文件補足 plan.md 的後續切片，不改變先完成 US6 的順序。

## 程式核對

- `src/main/services/agent-tailer.ts` 會在第一次 configure 時登錄三個內建 adapter；目前沒有個別安裝生命週期。
- `plugins/pack-ai-agents/plugin.json` 與 `src/core/capture-packs.ts` 把三種工具當同一個出廠 pack；pack 啟用時未另外關掉的 member 都可能被選中。
- `src/main/index.ts` 以 pack/member 決定 enabledAgents，但讀取範圍來自本機 `hook-config.json` 的 watchPaths。空清單代表全部來源工作，並非本專案授權範圍。
- `AgentsPanel.tsx` 的 AgentMembers 與 HookWatchPathsPanel 分別維護啟用和全機目錄；來源查詢失敗被轉成空陣列，容易誤認沒有安裝任何工具。

## 收斂的設計

1. Claude Code、Codex、OpenCode 各有一個官方擷取插件。安裝的是 RedLog 的讀取整合，不是 AI 工具，也不呼叫付費／免費模型。可選 manifest 放在不會被預設 plugin discovery 載入的 catalog；安裝時才放入本機插件目錄。沿用現有 declarative plugin 格式與本機載入器，不新增市場或第三方程式碼執行器。
2. 安裝狀態由本機實際安裝檔決定；本專案是否啟用、允許的工作目錄由專案設定決定。一個來源一列完成安裝／選範圍／啟用。取消 AI 總開關作為第二個權威來源，更新 health／來源設定／pack 契約一起使用同一決策函式。
3. 新安裝不啟用；空工作範圍不記錄。明示原始對話讀取位置與允許的工作目錄。來源缺 cwd 或無法證明歸屬時不自動歸入目前專案；停用立即停止讀取。預設從啟用邊界後開始，不默默匯入整段歷史。
4. 解除安裝停止 adapter、移除已管理的插件安裝檔，保留專案證據與 cursor provenance。未知、被使用者修改或非本機 installer 管理的同名目錄，不做遞迴刪除；回報可理解錯誤。
5. 安裝器只接受三個已知 id，檔案操作限制在管理目錄，不接受 renderer 提供的來源或任意目的路徑。安裝／解除安裝必須回傳成功或具體錯誤，不把查詢失敗表示為「未安裝」。
6. 展示來源實際提供的訊息與 tool call/result；不宣稱隱藏推理或所有網頁／桌面版對話。不擴充 keyboard logging 或 LLM 分類。

## 實作前 RED 與驗收

- 乾淨本機：三項未安裝；插件不載入，三個測試 transcript 的 open/read 次數皆為 0。
- 僅安裝 Codex：不自動啟用、不登錄其他工具；明確工作範圍後才讀新資料。
- 範圍空／缺 cwd／其它目錄／切換專案／晚到結果：不得寫入前景專案。啟用前的歷史不自動匯入。
- 停用及解除安裝後讀取停止，已保存事件及證據 bytes 不變；重開 App／專案不擴大授權。
- UI 涵蓋未安裝、安裝中、已安裝未啟用、範圍未設、記錄中、查詢或安裝失敗；錯誤可重試，沒有重複 AI 總開關。
- 檢查 native package 是否含可選 catalog，且乾淨首次啟動不把它放入 user plugins。Windows / macOS 路徑各做契約測試；真機驗收分開列。

## 接線範圍

`src/core/plugins/`（既有 discovery／管理）、`src/core/capture-packs.ts`、`src/core/config.ts`、`src/main/services/{agent-tailer,tailer-host}.ts`、`src/main/index.ts`、IPC/preload/env bridge、`settings/AgentsPanel.tsx`、來源 health、packaged resources、對應測試及 `docs/domain/SPEC-capture-source-lifecycle.md`。正式實作前將 T007 拆成依序可驗證的測試→安裝→範圍→UI→package 任務，不能只更換前端標籤。

## T014 實際交付範圍（2026-10-22）

官方 manifest templates 已置於 `src/core/plugins/official-agents.ts` 的靜態 catalog，而不是會被自動掃描的插件目錄；只有明確 IPC install 才建立一個 managed plugin.json。目前 manifest 僅供安裝生命週期接線，不帶 executable/capture contribution，不是已完成可用的 AI 擷取插件。現有 AI pack 與全機 watchPaths 在 T015–T018 才替換，不能宣稱現在整個 App 已達到 US5 的「未安裝來源零讀取」。

安裝／解除安裝經既有 plugin IPC/preload 可呼叫；不修改專案設定。修改過的 manifest、額外檔案、symlink、未知 id 都拒絕，沒有遞迴刪除。manifest 已移除但目錄清理失敗時，回傳錯誤並標示 changed=true，主程序仍重新整理 metadata／擷取決策，不把部分成功當作完全沒改變。51個插件相關測試、1條隔離 Electron 安裝→衝突→解除安裝及證據保留流程通過。沒有新增 UI 按鈕，沒有手動／安裝包驗收，不將此階段標為 US5 Verified。
