# 設計來源檔

從 Claude Design 專案「RedLog 設計規範」取回的原稿，供不能開那個專案的人使用。
規範本文在 [`../docs/UIUX-STANDARD.md`](../docs/UIUX-STANDARD.md)；往返記錄在
[`../docs/design-project-sync.md`](../docs/design-project-sync.md)。

## assets/

| 檔案 | 是什麼 | 現況 |
|---|---|---|
| `redlog-mark.svg` | 1024×1024 app 圖示原稿。切角 22%、環外徑 45%、環寬 16%、內點 30%（`UIUX-STANDARD.md` §16） | **尚未套用** |
| `redlog-mark-small.svg` | ≤256px 變體，環收成實心點；16px 用它 | **尚未套用** |

**▲ 分歧，已知**：`resources/icon.svg`、`resources/logo.svg`、`tray-icon.svg` 與
`src/renderer/src/assets/logo.svg` 目前仍是**舊標**——圓角方形漸層底、漸層 R、斜線、外光暈。
§16 明說那一版已由上面的字標取代，理由是「漸層、外光暈與斜線在 16px 下全部糊成一團，且與 §1
『去飽和、不發光』的整體方向相反」。

換過去不只是替換檔案：`.icns` / `.ico` 由原稿產生，`electron-builder` 的設定、系統列圖示與
renderer 內嵌的 logo 都要一起動，並且要在三個平台目視確認。所以這裡只放原稿，不動打包路徑——
接手的人請把它當成一項待辦，別當成「已經套用」。

## 沒有放進來的

**設計稿本體（`RedLog 設計規範.dc.html`）**——1a 到 9b 的所有畫板。它在 Claude Design 專案裡
著作與編輯，複製一份進 repo 只會產生第二個會漂移的真相。要看畫面本身就開那個專案；repo 這邊
有的是從它萃取出來的文字規範（22 節，全文）。
