# 節省 token 的工具:評估與使用規則

> **狀態**：current  
> **範圍**：Claude Code 工作階段的工具使用規則；與產品無關（CLAUDE.md 以此路徑引用）  
> **最後核對**：2026-11-25（兩個工具在 Windows 開發機上的安裝狀態、該機器 21 天的用量）；rtk 的位元組實測仍是 2026-11-07 的紀錄，未重跑

日期:2026-11-07 初版,2026-11-25 補上用量實測。範圍:Claude Code 工作階段的 token 用量,與 RedLog 產品本身無關。

## 結論

| 工具 | 狀態(2026-11-25,Windows 開發機) | 理由 |
|---|---|---|
| [rtk](https://github.com/rtk-ai/rtk) | PowerShell 與 Git Bash 的 PATH 上都**找不到** `rtk`;未裝 hook | 只壓縮 Bash 輸出;對這裡輸出量最大的 `grep` 沒有壓縮效果(見下) |
| [TokenEconomizer](https://github.com/microsoft/TokenEconomizer) | **已安裝**(user scope,0.1.0);全域三個機制都關,本 repo 只開 loop guard | 開銷 0.1%,137 輪裡導正 2 次;tool pruning 與 micro-skills 維持關閉 |

用量實測的結論在最前面講:**花費由「每次呼叫帶多大的 context × 呼叫幾次」決定,不是由工具輸出的大小決定。** 上面兩個工具處理的都是後者,所以都不是最該先做的事。見〈實測:token 花在哪〉。

## rtk

CLI 代理:在命令輸出交給 agent 之前先過濾與壓縮。單一 Rust binary,Apache-2.0(內含的 `rtk-engine` 與 `rtk-proxy` 為 BUSL-1.1;產品化給第三方才需要聯絡授權方)。

- 安裝:`brew install rtk`。crates.io 上有另一個同名專案,裝完用 `rtk --version` 與 `rtk gain` 確認是這一個。
- 全域 hook:`rtk init -g`,會在 Bash 工具呼叫前改寫命令。**本機沒有裝。**
- 不加 `-g` 的 `rtk init` 只會改 repo 的 `CLAUDE.md` 並建立 `.rtk/filters.toml`,不裝 hook。本 repo 不使用它,規則手寫在 `CLAUDE.md`。
- 只攔 Bash 工具;Read／Grep／Glob 不經過它。
- 單次略過:`rtk bypass <命令>`。

### 在本 repo 的實測(2026-11-07,位元組數)

| 命令 | 原始 | 經 rtk |
|---|---|---|
| `git log -30` | 20276 | 7377 |
| `ls -la src/renderer/src/components` | 4057 | 1470 |
| `git status` | 1214 | 926 |
| `git diff origin/main --stat` | 20304 | 20304 |
| `grep -rn useI18n src/renderer/src/components` | 10295 | 10295 |

後兩列沒有被壓縮。整體 `rtk gain` 顯示 22.6%,樣本只有 7 個命令。官方所稱的 60–90% 是它自己的數字,這個 repo 沒有重現。

### 本 repo 的使用規則

壓縮會丟資訊(`cat` 只剩簽章、通過的測試折成筆數、`git log` 只剩雜湊與標題)。本 repo 的 gate 與 CI 診斷需要完整的失敗輸出,例如 `truncation.test.ts` 的真因就在失敗行的細節裡。

- **可以用 rtk:** `git status`、`git log`、`ls`、探索性的 `git diff --stat`。
- **不要用 rtk:** 五道 push gate(`typecheck`、`verify:*`、`npm test`)、`vitest`、`playwright`、`gh run view --log-failed`、任何要讀失敗訊息或逐行差異的命令。
- 結果與預期不符時,先用 `rtk bypass` 或不加 `rtk` 重跑一次,再下結論。

## TokenEconomizer

Microsoft Research 的外掛(論文 arXiv 2610.22732),從 repo 過去的工作階段學習,有三個機制:

1. **Micro-skills:** 記下 repo 事實(例如正確的測試命令)並在之後的工作階段開頭提示。預設關閉。
2. **Tool pruning:** 把用不到的工具從設定中移除。預設開啟。
3. **Loop guard:** 用裁判模型判斷這一輪是否卡住,卡住就加一段簡短的導正。預設開啟,每輪最多一次,不會自己中止。

README 宣稱 SWE-Bench 平均成本降低 18.4–30.9%。這是作者自己的 benchmark,不是對你的工作的保證;其中 Opus 4.8 組合成本降 30.9% 但 Pass@1 降 1.0。

### 現況(2026-11-25)

這份文件的初版寫「未安裝」,與機器上的狀態不符:本 repo 的設定檔 `~/.tokeneconomizer/repos/redlog-*/config.json` 的修改時間是 2026-11-01。

- 設定:全域 `loopguard=off toolprune=off microskills=off`;本 repo `loopguard=nudge toolprune=off`。repo 以 origin remote 識別,所以每個 worktree 共用同一份設定。
- `te status` 的數字:12 個 session、474.2M effective tokens,外掛開銷 592.1k(0.1%);loop guard 在 137 輪裡導正 2 次,沒有「仍卡住」的通知。
- 版本:README 寫 Claude Code 只測過 2.1.300–2.1.310;這台機器是 2.1.331。

### 為什麼其餘兩個機制不開

- Tool pruning 會改檔:它編輯 `.claude/settings.local.json`(並寫入 `.git/info/exclude`)。本 repo 多個 session 共用同一個 checkout,設定被悄悄改掉的後果不易追。
- Tool pruning 在這裡省不到多少:它目前提議移除的幾乎都是延遲載入的工具,那些工具平常只佔一個名字,schema 要用到才載入。真正佔空間的是 subagent 繼承的整套工具,那是在 agent 定義裡用 `tools:` 解決的(見下)。
- Micro-skills 會與 `CLAUDE.md`、`AGENTS.md` 重複。
- Loop guard 從輸出文字判斷失敗,因為 Bash 工具不回傳 exit code。先紅後綠的測試、已知的 flake、WSL lock 逾時看起來都像卡住。導正是建議,不是判決。

移除用外掛自己的還原指令,不要手改 `settings.local.json`。

## 實測:token 花在哪

2026-11-25,Windows 開發機。讀 `~/.claude/projects/*redlog*/**/*.jsonl` 裡每則 assistant 訊息的 `usage`,以 message id 去重。視窗是最近 21 天:3 個主工作階段與 12 個 subagent,共 1,503 次 API 呼叫。同一段時間 `main` 的大部分 commit 不是從這台機器的這些工作階段來的,所以這是局部樣本。

| | token | 約佔成本 |
|---|---|---|
| cache 讀取 | 243M | 59% |
| cache 寫入 | 10M | 30% |
| 輸出 | 0.95M | 11% |
| 未快取的輸入 | 不到 0.01M | — |

成本欄用的倍率是假設(相對於輸入單價:讀 0.1、寫 1.25、輸出 5),沒有對 5.5 系列的定價核對過,也不代表訂閱方案的額度怎麼計。token 欄是量到的。

量到的五件事,依影響排序:

1. **Context 長得很大。** 主工作階段平均每次呼叫帶 218k,最高 367k。帶超過 200k 的呼叫只佔次數的 31%,卻佔 prompt token 的 46%。自動壓縮的門檻設在 400k,實際上幾乎不會觸發。
2. **`worker` 繼承了整套工具。** 定義裡沒有 `tools:` 時,第一次呼叫就帶約 56k(歷來 41 個 worker 的中位數 56.5k);`reviewer` 列了四個工具,是 14.6k。同一個 headless 工作階段(`claude -p`)對照:沒有 `tools:` 是 47.7k,列出九個工具後是 24.4k。九個工具的清單不隨工作階段變,所以從 56.5k 算每次少帶約 32k;這 21 天的 759 次 worker 呼叫合計約 24M,佔全部 prompt token 的一成。這個一成是推算,對照量的只有第一次呼叫。
3. **閒置後 cache 過期。** 主執行緒的 cache 存活 5 分鐘。兩次呼叫相隔超過 5 分鐘的有 54 次,其中 28 次整段 context 重寫,共 6.8M,佔全部 cache 寫入的 68%。跑一輪久的測試、或離開座位再回來,都算。
4. **用 Bash 讀檔。** 進入 context 的工具輸出有 75% 來自 Bash,其中 `sed -n`、`grep`、`cat` 整個檔案約佔三分之一。這些輸出之後每一次呼叫都會再被讀一次。
5. **subagent 的總量比主執行緒多。** 141M 對 102M。單一 worker 跑 85–131 次呼叫,context 長到 200–270k——交辦的範圍太大時,subagent 省下的主執行緒 context 會在它自己身上花回來。

## 依實測該做的事

| 做法 | 狀態 | 依據 |
|---|---|---|
| 每個 agent 定義都列 `tools:` | `worker` 已於 2026-11-25 加上(`docs/agent-routing.md`);定義在工作階段啟動時載入,已開著的工作階段要重開才生效 | 上面第 2 點 |
| 一個任務一個工作階段;任務之間 `/clear` | 習慣,不是設定 | 第 1 點 |
| 把自動壓縮的門檻往下調 | 未做;要先看壓縮後的工作品質 | 第 1 點 |
| 離開前先 `/compact`,或把主執行緒的 cache 存活時間拉長 | 未做;拉長會提高每次寫入的單價,淨效果沒有量過 | 第 3 點 |
| 交辦給 `worker` 的範圍切小 | 習慣 | 第 5 點 |
| 讀檔用 Read／Grep,不用 `sed -n`／`cat` | 未寫進 agent 定義 | 第 4 點 |

## 沒有評估過、只是知道有的工具

以下都**沒有在本 repo 跑過**,省幅是作者自己的數字。任何新增的 MCP server 都會加大每次呼叫的固定開銷(上面第 2 點),所以要試的話只掛在需要它的 agent 上,並用同一個任務前後對照。

| 工具 | 做什麼 | 要先確認的事 |
|---|---|---|
| [ccusage](https://github.com/ryoppippi/ccusage) | 讀本機的工作階段紀錄,按日、工作階段、5 小時區塊統計 | 唯讀;補的是持續量測,本身不省 token |
| [Serena](https://github.com/oraios/serena) | 透過 LSP 以符號為單位查詢與讀取,取代整檔讀取 | 它也有編輯工具;先只開唯讀 |
| CodeGraph | tree-sitter 解析成 SQLite 圖譜再查詢 | 作者自己的數字裡,token 少很多的 repo 成本只降一點,有的持平 |
| 以 embedding 做語意搜尋的 MCP(Claude Context、Semble 等) | 以語意找程式碼片段 | embedding 在哪裡算;原始碼會不會離開機器 |

## 這份文件沒有證明的事

- rtk 只有上面七個命令的樣本,而且是 2026-11-07 的紀錄。
- TokenEconomizer 的數字是它自己回報的,沒有做過開與關的對照。
- 〈實測〉是一台機器、21 天、三個主工作階段。它指出該先看哪裡,不是全體的平均。
- 〈依實測該做的事〉裡標「未做」的,省幅都是從上面的數字推算的,沒有做過前後對照。
