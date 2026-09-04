# 設計來源檔

從 Claude Design 專案「RedLog 設計規範」取回的原稿，供不能開那個專案的人使用。
規範本文在 [`../docs/UIUX-STANDARD.md`](../docs/UIUX-STANDARD.md)；往返記錄在
[`../docs/design-project-sync.md`](../docs/design-project-sync.md)。

## assets/

| 檔案 | 是什麼 | 現況 |
|---|---|---|
| `redlog-mark.svg` | 1024×1024 app 圖示原稿。切角 22%、環外徑 45%（皆為邊長），環寬 16%、內點 30%（皆為環外徑） | **已套用** |
| `redlog-mark-small.svg` | 小尺寸變體，環收成實心點 | **已套用** |

這兩個檔是唯一的真相。`resources/` 與 `src/renderer/src/assets/` 底下的每一個圖示都由
[`../tools/make-icons.py`](../tools/make-icons.py) 從它們產生，`test/mark-assets.test.ts` 斷言副本
逐位元組相同。**不要手改產出**——改這裡，再跑一次腳本。

```bash
python3 tools/make-icons.py          # 重新產生
python3 tools/make-icons.py --check  # 只檢查有沒有過期
```

需要 `rsvg-convert`（`brew install librsvg`）；`.icns` 另外需要 macOS 的 `iconutil`。

## 產出對不上原稿的地方

換標時有四件事不能照原稿直接放大縮小，理由都寫在 `UIUX-STANDARD.md` §16 的分歧清單裡，
這裡只列結論：環收成點的門檻是 **32px**（不是規範寫的 16 或 256）；**系統列不用本標誌**，
而是只有環與點、沒有底板的另一組圖；系統列的環寬與內點**對齊像素**（16.7%／33.3%）；
Windows 與 Linux 的系統列圖是**彩色**的，因為 `setTemplateImage` 只有 macOS 有作用。

## 沒有放進來的

**設計稿本體（`RedLog 設計規範.dc.html`）**——1a 到 9b 的所有畫板。它在 Claude Design 專案裡
著作與編輯，複製一份進 repo 只會產生第二個會漂移的真相。要看畫面本身就開那個專案；repo 這邊
有的是從它萃取出來的文字規範（22 節，全文）。
