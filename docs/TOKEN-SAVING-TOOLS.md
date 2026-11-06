# 節省 token 的工具:評估與使用規則

日期:2026-11-07。範圍:Claude Code 工作階段的 token 用量,與 RedLog 產品本身無關。

## 結論

| 工具 | 狀態 | 理由 |
|---|---|---|
| [rtk](https://github.com/rtk-ai/rtk) | 本機已裝 binary(1.1.0),**未裝 hook** | 只壓縮 Bash 輸出,效果可量測;只用在讀取型命令 |
| [TokenEconomizer](https://github.com/microsoft/TokenEconomizer) | **未安裝** | 每個工作階段都掛 hook、會多呼叫模型,且支援的 Claude Code 版本低於本機版本 |

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

### 為什麼先不裝

- 版本:README 寫 Claude Code 只測過 2.1.300–2.1.310;本機是 2.1.319。
- 會改檔:tool pruning 會編輯 `.claude/settings.local.json`(並寫入 `.git/info/exclude`)。本 repo 多個 session 共用同一個 checkout,設定被悄悄改掉的後果不易追。
- 額外成本:裁判模型(與啟用時的事實提案)會多呼叫模型。
- 行為:導正訊息會改變 agent 的做法;被移除的工具之後的 session 都看不到,要手動還原。

### 若要試

先在拋棄式的 worktree 試一個 session,只開 tool pruning,比較用量與結果,再決定。移除用外掛自己的還原指令,不要手改 `settings.local.json`。

## 兩者都沒做的事

這份文件不代表任何一項已被證明省錢:rtk 只有上面七個命令的樣本,TokenEconomizer 沒有在本 repo 跑過。
