# Onboarding & UX References — 其他產品怎麼做

> 來源：2026-09-29 為了重新設計首次安裝流程（spec 047）所做的調查。
> 每一項只記「值得抄的那一件事」與它對 RedLog 的意義，不做產品全貌介紹。
> 狀態：持續更新中

RedLog 的設計紅線仍然適用（見 `RESEARCH-tool-design-analysis.md`）：只專注 log、
不做 report generation、不做多人中央架構。下面任何一條參考都在這個框內評估。

---

## 1. 安裝驗證：Sentry / Datadog

**Install → Configure → Verify，而 Verify 的定義是「真的有資料進來」。**

Sentry 把 getting-started 文件的結構寫死成三段，第三段 Verify 的要求是「給一段程式碼
讓使用者故意觸發一個錯誤」。畫面停在 `Waiting for events…`，收到第一筆才換成
「Take me to my event」。Datadog 裝完 agent 後同樣停在等第一筆 metric 回報。

**對 RedLog**：檢查結果不算驗證，事件才算。`FirstRunView` 已經是這個模式（跑一個指令
→ 真的出現在時間軸）；而 spec 036 的準備狀態卡是相反的東西 —— 它拿 preflight 的
**預測**去佔 Verify 的版面。這是 spec 047 把兩者收斂的主要理由。

- <https://develop.sentry.dev/frontend/working-on-getting-started-docs/>
- <https://docs.datadoghq.com/agent/troubleshooting/>

## 2. 首次啟動精靈：OBS Studio

**首次啟動自動跑設定精靈，而且 Tools 選單永遠能再跑一次。**

第一次開 OBS 會自己跳出 Auto-Configuration Wizard，跑完套用設定；跳過或想重跑，
隨時從 Tools 選單叫出來。

**對 RedLog**：這同時解掉「一次性 localStorage 旗標」的毛病 —— 精靈不是一次性告知，
是一個常駐可重跑的東西，首次啟動只是自動幫你跑一次。spec 047 的 FR-007 / FR-011
直接來自這條。

- <https://obsproject.com/forum/threads/how-do-i-launch-the-auto-configuration-wizard.160351/>

## 3. 引導清單：VS Code Walkthrough

**多步驟清單、步驟自動打勾、從不 modal。**

官方 UX 指南只有兩條「不要」：一個 walkthrough 不要塞太多步驟、不要開一堆
walkthrough。要的是每一步都有**動詞按鈕**（可執行的動作，不是純說明），步驟靠
`completionEvents` 在偵測到條件時自動打勾，進度會記住。

**對 RedLog**：步驟要配「一鍵安裝」這種會做事的按鈕，不是「複製這行自己去貼」。
也是 F14（主動觸發的能力永遠不會自己出現）唯一的既有解法：要教的是**可被叫用的
指令**，那種東西沒辦法等它自己出現。

- <https://code.visualstudio.com/api/ux-guidelines/walkthroughs>

## 4. 零設定的第一條成功路徑：Burp vs Caido

**Burp 內建一顆預先配置好、直接走自己 proxy 的 Chromium；Caido 沒有，要你自己去設
瀏覽器 proxy 或裝 CA。** CA 憑證這件事兩家都不在首次啟動擋人，而是放在 proxy 設定裡
等你真的要用才做。

**對 RedLog**：內建終端 = Burp 的內建瀏覽器。第一次啟動應該先讓人走完「完全不用裝
任何東西」的路並成功一次，再談把自己的 PowerShell 接上去、再談信任 CA。

- <https://docs.caido.io/burp-suite/core/browser-and-setup>
- <https://portswigger.net/burp/documentation/desktop/external-browser-config/certificate>

## 5. CA 信任：Fiddler Everywhere / mitmproxy

**Fiddler Everywhere 的 Settings ▸ HTTPS 有「Trust CA Certificate in the User
Store」這個 app 內動作**（Windows 與 macOS，macOS 會跳系統確認）。mitmproxy 走另一條：
`mitm.it` 依平台送對應的憑證安裝檔。

**對 RedLog（F11）**：現在給的是 `certutil -addstore -user Root "..."` 讓操作者複製。
注意那是 **`-user` 使用者信任庫，不需要系統管理員權限** —— Windows 上擋住一鍵的東西
是零。macOS / Linux 需要 sudo，維持指令但要標明為什麼這個平台得手動。

- <https://docs.telerik.com/fiddler-everywhere/installation-and-setup/trust-fiddler-ca>
- <https://docs.mitmproxy.org/stable/concepts/certificates/>

## 6. 錄製指示與暫停：OBS / Loom / macOS

**指示器必須在 app 不在前景時仍然看得到。** OBS 把錄製點放在系統匣圖示上，Loom 的
暫停在錄製列上是一級動作，macOS Sequoia 自己在選單列放橘點。

**對 RedLog**：狀態列（常駐 REC／暫停、最後一筆事件時間、點一下暫停或續錄、uptime）
已經是這個模式，HUD 覆蓋 app 不在前景的情境（§8）。這塊目前及格，列在這裡是為了
之後改動時不要退步。

- <https://support.atlassian.com/loom/docs/pause-and-resume-while-recording>
- <https://obsproject.com/forum/threads/so-how-do-i-actually-see-an-indication-whether-im-recording-or-not.111369/>

## 7. 篩選列：Burp HTTP history

**篩選列常駐一行、用白話描述目前生效的條件**（預設是灰底的
`Filter: Showing all items`），點開才展開完整的條件面板。條件永遠看得見，但不佔版面。

**對 RedLog**：時間軸／HTTP 歷史的共用篩選列可以對照這個作法 —— 重點不是「有篩選
功能」，而是**不點開也知道自己正在看的是不是全部**。這與憲章 II（Surface
Truthfulness）同一個方向：一個看起來像完整清單的子集是最糟的呈現。

- <https://portswigger.net/burp/documentation/desktop/tools/proxy/http-history/filter-settings>

## 8. 交接與報告：Dradis / PlexTrac（紅線外，但要知道對面長什麼樣）

RedLog **不做 report generation**，這條紅線不動。但匯出物要被誰接走、接走之後長什麼
樣子，決定了匯出介面該給什麼。

- **Dradis 的三層資料模型**：Issue（弱點類別）→ Node（受影響的系統）→ Evidence
  （該 node 上的具體實例）。樣板控制這三層在輸出文件裡怎麼組織。
- **PlexTrac 強調「邊測邊記」**：截圖、程式碼片段、影片、攻擊路徑直接在平台裡蒐集。

**對 RedLog**：RedLog 產出的是 Evidence 那一層 —— 時間、指令、請求、截圖、雜湊鏈。
匯出介面該回答的是「這包東西要怎麼被貼進上面那兩層」，而不是自己長出 Issue 與樣板。
這也說明 F15（整條 onboarding 從未提過匯出）為什麼值得補一句：操作者需要知道他今天
錄的東西，交戰結束時會變成什麼。

- <https://dradis.com/solutions/reporting.html>
- <https://plextrac.com/learn/pentesting/pentest-reports/>

## 9. 證據完整性：Autopsy / FTK Imager

**雜湊在採集當下計算並顯示，驗證是一個看得見的事件，不是一行日誌。** FTK Imager
在取像時自動算 MD5／SHA-1／SHA-256 並與來源比對，產出可以附進 chain-of-custody
文件的報告；Autopsy 在載入 image 時顯示雜湊，並可在 ingest 時驗證。

**對 RedLog**：兩層鏈與 OpenTimestamps 收據已經是更強的形式。可借鑑的是**呈現**：
驗證動作要有自己的畫面與結果，而不是只在匯出的檔案裡。

- <https://www.cyberforensicacademy.com/blog/how-to-use-autopsy-for-disk-imaging-evidence-extraction>

---

## 未解的設計問題

1. **F14 — 漸進揭露的適用邊界。** §22 的「名詞在它的資料存在之前不出現」對會自己
   抵達的資料（HTTP、loot）很漂亮，對需要操作者主動叫用的能力（標記 `Cmd+Shift+M`、
   截圖、⌘K）是循環的：要先用過它才會出現，不知道它存在就不會去用。VS Code 的
   walkthrough 是目前唯一看到的解法（明確的動詞按鈕清單）。需要一次規則裁定。
2. **HTTP 擷取是否自動啟動。** repo 裡沒有任何地方寫下「為什麼要按鈕」。RedLog 從不
   修改系統 proxy 設定，啟動＝spawn mitmdump ＋ 綁 localhost 埠，唯一真實風險是埠
   衝突（紅隊機器上 Burp 常年佔 8080），而 `failed` 狀態早就存在。
