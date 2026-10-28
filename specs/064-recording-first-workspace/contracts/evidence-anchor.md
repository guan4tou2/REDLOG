# C4 — 證據片段與位置契約

**Status**: Draft contract · 2026-10-26。適用 FR-035、FR-052；驗收 CT-13／14。適用搜尋命中、Marker、Bookmark 及閱讀位置；不把私人書籤改成證據事件。

## 1. Anchor 的必要資訊

Anchor 包含 project、來源 Event IDs、Evidence ref、內容版本／hash、座標種類、選取範圍及定位精度。可另保存選取摘錄與 digest、文字轉換版本，供核對及降級；摘錄不能取代完整原件。不得將原始對話另存到全域 UI 偏好作為閱讀位置。

| 座標 | 定義與限制 |
| --- | --- |
| raw byte range | 不可變版本內，從零開始、左閉右開的 byte 範圍。不能拿 JS UTF-16 index、字元數或行號直接當 bytes。 |
| normalized text range | 指定文字表示及轉換版本內的位置；須有映射才能宣稱 raw 精確定位。 |
| cast position | 來源錄影／分段版本、frame index／來源相對時間；有實際資料時才加 frame payload 範圍。時間定位不等於精確文字 bytes。 |
| logical multipart offset | 使用已確認有序分段與各段長度映射；保存分段識別／hash。不能把跨檔總 offset 直接套在某一實體檔。 |
| Event／excerpt fallback | 只定位 Event、附件、時間或摘錄；明示精度不足，不填假的精確偏移。 |

Cast 的序列化 JSON bytes、解碼 frame payload、終端呈現文字是不同座標。只有來源確實提供、reader 可驗證的座標才可持久引用。

## 2. 轉換及還原

Unicode／emoji、CRLF、ANSI、游標移動及進度列可能改變文字長度或順序。轉換層需提供有界 raw↔display 映射，或明示只能恢復至較粗範圍。FTS 正規化命中也不能無條件轉成原件 byte range。

重新開啟先核對來源身分及版本，再定位範圍。來源還在、hash／prefix 相符才可標示精確；超出目前保存範圍、附件被清理、同名替換、檔案移動卻無可信識別時，不自動指向另一內容。可呈現原 Event／既存摘錄及「原件不可用／位置無法還原」。

正式 Marker 及修訂沿既有 append-only 規則；原件被清理不刪掉標記歷史。Bookmark 可編修且維持其私人狀態。摘錄／正規化版本是衍生表示；Logged 內容的 hash 亦不等同已進 hash chain。

## 3. 驗證邊界

定位能證明「摘錄來自哪份已保存內容」，不證明命令因果。檔案 watcher 的時間重疊、工作目錄或文字相近不能因此升格為某道命令確實產生該檔。來源缺少版本、順序或精確座標時保留可用連結，拒絕偽造完整性。

## 4. 目前實作切片（2026-10-27）

保存 UTF-8 欄位的 `ContentAnchor` 使用 `utf8-bytes`、左閉右開範圍、完整 `ContentRef` 版本及片段 SHA-256。一次最多 16 KiB，超過時停用標記並顯示原因，不自動截短。Renderer 先確認 DOM 選取與原始讀取視窗一致，再換算 bytes；主程序重新檢查版本、UTF-8 邊界及 digest 後才建立 append-only marker，並將來源 Event 加入 `_causes`。

Marker 不保存額外原文摘錄；重開時讀取同版本原件並高亮範圍。原件缺失、遭替換或超出目前專案時回報明確失敗，保留 marker 與 Event 連結。ANSI 以保存文字原樣呈現；不把剝除控制字元後的文字、Markdown 渲染或 cast 畫面選取冒充 raw byte 精確座標。其他座標仍依前述契約待實作。
