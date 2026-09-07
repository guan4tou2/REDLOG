# RedLog 完善需求(PRD)

寫於 2026-09-06,PM 視角。把這幾輪審視的所有發現——紅隊審視、系統設計債、開放項目、
plugin-kernel 方向——整理成**有優先級、有驗收標準、有里程碑**的需求,作為實作前的單一依據。

「怎麼做」在各設計文件([`DESIGN-OPEN-ITEMS`](DESIGN-OPEN-ITEMS.md)、
[`DESIGN-plugin-kernel`](DESIGN-plugin-kernel.md)、[`DESIGN-traffic-attribution`](DESIGN-traffic-attribution.md));
這份只定義**做什麼、為誰、算不算完成、先後**。

---

## 0. 目標與定位(不變的量尺)

**RedLog 是一場紅隊交戰的本機紀錄:被動記下每個指令、連線、檔案、畫面,讓事後能重建、能給
紫隊判讀、能證明在範圍內、能查到當下沒盯著的那段。** 判準:一個功能值不值得做,看它是否
(i) 讓紀錄更完整、(ii) 讓紀錄更可信、(iii) 服務即時 OPSEC 前門(HUD)、(iv) 讓事後檢視更快。
不在這四項裡的,是 scope creep。

### 非目標(明確排除,不再討論)

| 非目標 | 理由 |
|---|---|
| **報告產出**(Ghostwriter/Markdown/PDF 成稿) | 產品決定,只做 log;RedLog 到「可查、可驗證的事件流」為止 |
| **多人中央架構**(中央伺服器/共享 DB/團隊儀表板) | `DESIGN-PRINCIPLES §5` 凍結;團隊 = 設定檔同步 |
| **報告式解讀寫成權威事實**(自動 MITRE 當定論) | `§3` 兩層屬性:解讀一律標 inferred,不變事實 |

---

## 1.「完善」的定義(品質門檻)

一個需求算完成,要同時滿足:

1. **行為**:驗收標準逐條可驗證(不是「做好了」)。
2. **測試**:純邏輯有單元測試;跨程序/geometry 有 e2e;i18n 兩語系同步。
3. **不失真**:不新增「抓到卻沒記、或記錯還無法回溯」的路徑。
4. **契約**:動到 REST/CLI/外掛能力/SQL 表名時,有別名期或明確的破壞性宣告。
5. **誠實**:抓不到的盲點 UI 要說(SYN 掃描、加密流量、macOS 無 pid)。

整個專案的「完善」= 下方 P0/P1 全部達標,且 `Timeline.tsx` 有第一批互動測試。

---

## 2. 需求(依主題,每項含優先級/大小/驗收/相依)

優先級:**P0** 有隱私/安全/可信後果,或擋住其他工作 · **P1** 明顯價值,合理成本 · **P2** 值得但可延。
大小:S <½ 天 · M ½–2 天 · L >2 天。

### 主題 A — 紀錄完整性與可信

**A1. 書籤 retention 清理 · ✅ 已實作(PR #36)· P0 · S**
- 為什麼:書籤存貼上憑證 + 擷取到的外部 IP,永久留存;裁決「書籤是便條本不是紀錄」後更站不住。
- 驗收:`retention.bookmarks.keepDays` 預設 0(不改既有);>0 時開專案掃、刪超期書籤、寫一筆
  `system.bookmarks_pruned`(數量,不含內容);單元測試涵蓋。
- 設計:`DESIGN-OPEN-ITEMS §1`。相依:無。

**A2. Scope-aware sanitize + artifact rotation · ✅ 已實作(匯出遮蔽 PR #36 · rotation 排序 PR #43)· P1 · M–L**
- 續作:~~artifact rotation 依範圍排序~~ ✅(#43);~~eviction 預算旋鈕接進 Settings~~ ✅(#47);~~匯出遮蔽的覆寫 UI 開關~~ ✅(#54,ExportMenu 加「遮蔽範圍外內容(建議)」勾選,取消才原樣輸出、標警示)。
- 為什麼:匯出遮蔽與 artifact 輪替目前不看範圍,out-of-scope 的 client 資料與 in-scope 證據同等對待。
- 驗收:匯出時 out-of-scope 事件的 body/preview 預設遮蔽(可覆寫),manifest 記
  `sanitized_out_of_scope: N`;casts/screenshots 輪替時 out-of-scope 先淘汰、in-scope 後淘汰;
  測試涵蓋 in/out 兩路。**破壞性:匯出內容改變,要 CHANGELOG + 覆寫選項。**
- 設計:`DESIGN-OPEN-ITEMS §3`。相依:無。

**A3. 每專案 token 隔離 · ✅ 已實作(PR #36)· P1 · S**
- 為什麼:全域一把 token 跨所有客戶交戰;每場交戰換一把 secret 是安全衛生。**(價值中低:同一時間
  只服務一個開啟中的專案,不是並發隔離。)**
- 驗收:每專案自己的 token 檔;鏡像到 `~/.redlog/api-token` 讓 hook 不改;跨專案 token 互不通用(401);測試涵蓋。
- 設計:`DESIGN-OPEN-ITEMS §2`。相依:無。

### 主題 B — OPSEC(紅隊)

**B1. Air-gap 模式 · ✅ 已實作(PR #36)**
- 關掉錨定/NTP/更新/外部 IP 查詢,`system.opsec_airgap` 記錄。

**B2. 交付驗證器 file-hash · ✅ 已實作(PR #36)**
- `redlog-verify.py` 重算 manifest 每個檔案,竄改截圖會失敗。

**B3. 依工具分流量(socket→pid→指令 對照器)· ✅ 已實作(PR #36)· P1 · M**
- 為什麼:HTTP/DNS 已分得開,但「這筆流量是哪道指令打的」只做一半;連線層 pid 有了、沒對到指令。
- 驗收:新流量事件透過 `source_addr`/`pid` 對到開它的 `command_start`,填 `_causes`;點一筆 request
  能跳到那道 `sqlmap`,反之亦然;macOS 無 pid 時 UI 標「本機無法歸因」;純函式 + 測試。
- 設計:`DESIGN-traffic-attribution §2.3`。相依:無(在既有 `causes-resolver` 旁)。

**B4. pcap 側錄 + 透明代理 · ✅ 已實作(PR #46)· P2 · L**
- 為什麼:補 SYN 掃描與不吃 `HTTP_PROXY` 工具的物理盲點。
- 做法:兩個 out-of-process producer pack(`plugins/pcap-capture/`、`plugins/transparent-proxy/`),
  沿 RedLog 一貫的「producer POST 到本機 API、特權在操作員側跑、RedLog 不持有 root」模型。
  pcap 讀 tcpdump 文字輸出、折成 `scanner.packet_flow`(含 `syn_only` 誠實標示),attribution
  靠 `local_port` 走既有 ingest;透明代理沿用既有 mitmproxy addon + iptables/pf 重導。
- 已驗收:flow 摘要走 scanner 泳道、SYN 掃描現形且誠實標示、attribution 接既有 socket→pid。
  純解析/分類有單元測試;**特權執行路徑(tcpdump/iptables/pf)本質上要操作員在自己硬體上跑,
  無法在 CI 沙箱驗證**——pack 只宣告 hook + preflight 誠實擋。
- 決策已採納(root/`CAP_NET_RAW` 成本)。Windows pcap(npcap)與原始 pcap sidecar 輪替為後續。
- 設計:`DESIGN-traffic-attribution §1`、`DESIGN-core-and-capture §2.1`。

### 主題 C — 檢視與上手(多數已完善)

**C1. 時間軸/設定/側欄 UI 修復 · ✅ 已實作(PR #36)**

**C2. 操作者手冊 · ✅ 已實作(PR #36,`USER-GUIDE.md`)**

**C3. 首次執行「先跑一個指令」· ✅ 既有**
- 無新需求;維持。

### 主題 D — 架構健康(設計債,威脅可維護性)

**D1. Timeline 純函式接縫(density-zoom + clustering)· ✅ 首批已實作(PR #36)· P0 · M–L**
- 續作:再抽 lane 可見性解析與 palette filter,並補真正的互動測試(zoom/cluster/minimap)。
- 為什麼:`Timeline.tsx` 近 5000 行、65 useState、**零互動測試**,是唯一「零測試的 5000 行」,
  回歸最容易藏。這是降低系統性風險 CP 值最高的一項,勝過任何新功能。
- 驗收:cluster bucketing、lane 可見性解析、時間域/minimap binning、⌘K palette filter 至少抽出
  4 個純函式並各附單元測試;`Timeline.tsx` 行數下降;第一批互動測試(zoom/cluster/minimap)存在。
- 設計:審計 F2 / `UX-BACKLOG-TICKETS T5`。相依:無。

**D2. `env.d.ts` 推導自 preload · P1 · M**
- 為什麼:405 行手抄契約會漂。
- 驗收:preload `export const api`;`env.d.ts` 改 `typeof` 推導;typecheck 乾淨;手抄介面刪除。
  **獨立 PR**(module 化波及每個裸用全域型別的檔)。
- 設計:`DESIGN-OPEN-ITEMS §4`。相依:無。

**D3. ingest() 完成 + 去全域狀態 · ✅ 大致已滿足 · P2 · M**
- ingest 已上熱路徑(需要 enrichment 的 producer:`/api/events`、builtin-terminal 經 hook、PS transcript;其餘型別對 ingest 是 no-op,不強接——PR #36)。
- 「去全域狀態」:`configureIngest` 已是單一 owner(`startProject`);ingest 測試不設全域、以 `_resetIngest` 為 seam,不靠殘留。此為 core/main 的 DI 慣例,與 api-server/capture-health 一致;不值得為邊際測試性churn 熱路徑。
- 續作(若要):把三個 ref 改成每呼叫 deps 覆寫——低價值,獨立處理。

**D4. 清死碼 · ✅ 部分實作(PR #36)· P2 · S**
- ✅ `event_annotations` 死表已移除(0 引用)。
- 續作:plugin 兩個「capture」概念(hooks-manager 的 `PluginManifest` vs `contributes.capture`)其實是協作的兩層、非死碼,合併與否是設計取捨,留待評估。

### 主題 E — 外掛化完成(大架構,分階段)

**E1. 內建 target extractor 宣告化 + 外掛化 · ✅ 已實作(Option A #41 · Option B #44)· P2 · M** — Option A:`STRATEGIES` 註冊表 + 宣告式資料。Option B:整張工具→策略表搬進 bundled pack `plugins/builtin-tools/`,core 不再有 per-tool 資料;`initPlugins()` 註冊該 pack,precedence 以 source 決定(user 蓋 bundled),`plugins/` 進 `extraResources` 才隨包出貨(順帶修好 c2-tailers 從沒打包的漏),停用即移除內建。
**E2. Starter pack 預裝 · ✅ 已實作(安全版,PR #51)· P2 · M** — 內建 producer 改由 bundled `plugins/starter-pack/plugin.json` 宣告(`builtinProducers`),hooks-manager 讀它並 `~` 展開;**帶 in-code fallback**,manifest 缺失就退回,關鍵路徑不倒退。裸 id 保留。**真正可移除已補(PR #60)**:`allManifests()` 讀 disabled 狀態,停用 starter-pack 真的移除內建 producer(重啟用恢復);與穩健度 fallback 正交——缺檔仍退回,只有明確停用才移除。
**E3. manifest 前向相容 + 健康度讀 manifest · ✅ 已實作(#48 + #49 + #50)· P2 · M**
- ✅ 健康度讀 manifest:capture 貢獻加 `emits`(宣告發出的 subtype),capture-health 據此給每個 plugin producer 真實 active/idle/off 餵食狀態,並顯示在擷取卡(唯讀、標 plugin、閒置不擾)。verdict 非對稱:活著的 plugin 計入 recording/active,但**任何 plugin 永不進 `expectedSilent`**——裝了沒跑的永不翻 amber(三個測試釘住)。
- ✅ 前向相容(PR #50):loader 讀領先一版的 manifest——宣告式 pack 套用已知貢獻並標 `apiAhead`,程式 pack 領先版整個拒絕(不跑不懂的新程式),領先兩版拒收。bundle 驗證器本來就接受兩版。
- 設計全在 `DESIGN-plugin-kernel §5`。相依:E 之間有序;不擋 A–D。

### 主題 F — 收尾/外觀

**F1. 視窗底色 `#0a0a0a`→`#121214` · ✅ 已實作(PR #36)· P1 · S** — `windows.ts` 兩處,載入不再閃暗底。
**F2. 單一字標 `REDL(●)G` · ✅ 已實作(PR #36)· P2 · M** — `Wordmark` 即時文字元件,環為錄製指示、em-based、#d75f63;換掉標題列與 Picker 的圖片+純文字。
**F3. Linux 多尺寸圖示 + release matrix · ✅ 已實作(圖示 PR #36 · matrix PR #45)· P2 · S** — `resources/icons/<N>x<N>.png` + `linux.icon` 指向目錄 + make-icons 同步 + guard;PR #45 把 `ubuntu-latest` 加進 release build matrix(AppImage + deb),以 `continue-on-error` 設為 best-effort,失敗不擋 mac/win。**續作**:一次 tag release 觀察 Linux leg 真的綠,再拿掉 `continue-on-error` 升為必需。
**F4. QuickMark→Bookmark 改名 · ✅ 已實作(PR #40)· P2 · M** — 內部改名(型別/IPC/component/SQL `ALTER TABLE … RENAME`)+ 外部契約與別名(`/api/bookmarks`、CLI `bookmark`、`read:bookmarks`,舊路由/動詞/能力保留別名)全數落地。原計畫的兩段(part A 內部、part B 外部)在同一分支依序完成。
- 設計:`DESIGN-OPEN-ITEMS §5–7`。

---

## 3. 里程碑(實作順序)

**M1 — 隱私與可信收尾 · ✅ 已達成(PR #36)**
A1 書籤 retention · F1 視窗底色 · A3 每專案 token · D1 Timeline 接縫+測試(首批)
→ 已達成:沒有永久留存的憑證便條、Timeline 有首批單元測試、每交戰獨立 secret。
D1 的續作(lane 可見性 + 互動測試)延到 M3 的 D 系列。

**M2 — 證據深度與 OPSEC · ✅ 大致達成(PR #36)**
A2 scope-aware sanitize(匯出遮蔽 ✅ PR #36;rotation 排序 ✅ PR #43) · B3 依工具分流量 ✅
→ 已達成:匯出遮蔽 out-of-scope 內容、流量透過 socket→pid 對得到指令。

**M3 — 架構健康(P1/P2)· 部分達成**
D4 死表移除 ✅ · D3 已大致滿足(單一 owner + 測試不靠殘留)✅ · **D2 env.d.ts 推導 · ✅ 已實作(PR #37)**
→ D2 已做:`env.d.ts` 改為 `typeof api` 推導,preload 具名 export `api: RedLogAPI`;獨立 PR #37 完成,漂移在型別層即不可能。

**M4 — 外掛化 + 外觀(P2)· 外觀達成,外掛化首步達成**
F2 字標 ✅ · F3 Linux 圖示 + release matrix ✅(#36 + #45,best-effort leg) · F4 改名 ✅(PR #40) · E1 外掛化 Option A ✅(#41) + Option B ✅(#44)
→ E1 已完整外掛化:工具知識現在只活在 bundled pack,core 只留通用 strategy 庫;載入順序在測試 setup + 啟動路徑解掉。**仍待獨立 PR:E2 starter pack 預裝 + E3 manifest 雙版本讀取。**

**B4 pcap / 透明代理**:✅ 已實作(PR #46,out-of-process producer pack;特權路徑操作員側驗證)。

---

## 4. 需要產品決策的點(擋住對應需求)

**四項決策於 2026-09-06 全部採納(✅ accepted),對應需求解鎖:**

| 決策 | 裁決 | 對需求的影響 |
|---|---|---|
| SQL 表名 `quickmarks`→`bookmarks` | ✅ 改 | F4 含 `ALTER TABLE` migration;無混版工作流的前提下進行 |
| Linux 進 release 出貨 | ✅ 是 | F3 值得做,Linux 進 release matrix |
| 接受 pcap 的 root/npcap 成本 | ✅ 接受 | B4 進入定位內,可排期 |
| A2 匯出依範圍遮蔽的破壞性變更 | ✅ 接受 | A2 直接做,CHANGELOG 標破壞性 + 提供覆寫 |

---

## 5. 追蹤規則

- 每項落地後,在對應設計文件把狀態改「已實作 → 見 X」,並在本 PRD 該項標 ✅。
- 新需求先進本 PRD 定義驗收,再開設計,再實作——避免又出現 spec-without-code 的漂移。
- 非目標三項不因個案破例;要破例先改 `PRODUCT-POSITIONING` 與 `DESIGN-PRINCIPLES`。
