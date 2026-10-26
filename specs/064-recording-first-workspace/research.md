# Planning decisions

1. **Reuse**：現有 shell-common、terminal_app.py、relay／session 已有集中 gate，不另設一套 Terminal App policy。讀取 TERM_PROGRAM／WT_SESSION 的現況不滿足 C6。
2. **Origin**：macOS 可讀程序 executable 路徑及 App Info.plist，核對 CFBundleExecutable／Identifier；環境值只提示。無可信 ancestry、跨主機／WSL／tmux 時拒絕受限模式，不推測。
3. **Scope**：功能分批但不刪需求；S1 正確性優先，原生／跨平台未知如實保留。單元假環境不是 Warp 隔離驗收。
4. **Architecture**：C1–C6 延伸 canonical domain，不新增 framework／資料庫／外掛商店。共用 reader 語意不要求相同視覺。

本機 Warp metadata 已唯讀核對為 dev.warp.Warp-Stable／stable；只用於本機候選，其他版本／平台須另核實，不以這個值猜任意相似 App。
