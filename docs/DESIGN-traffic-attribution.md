# 流量歸因設計筆記 —— 依工具分開紀錄

寫於 2026-09-06，回答一個很具體的問題：

> 流量一定要全部截取。但流量有辦法**依照工具**分開紀錄嗎？例如 nmap 的封包、
> 網頁操作的 request / response，能不能各自歸到「是哪個工具/哪道指令產生的」？

短答：**可以，但分兩種流量，機制完全不同。** 應用層流量（HTTP/DNS，經 mitmproxy）
今天就已經天然分得開，因為每筆都帶自己的中繼資料；連線層流量（nmap、SMB、reverse
shell、C2）要靠 **socket → pid → 指令** 的關聯才能歸因，而那條鏈目前只做了一半。
本筆記把現況、缺口與建議實作寫清楚。

> **實作狀態(2026-09-07 更新):** socket→pid→指令 對照器已在 PR #36 落地並接進 `ingest()`;
> §2.3 的三來源歸因已生效。pcap producer 與透明代理已於 PR #46 以 out-of-process producer pack
> 出貨(`plugins/pcap-capture/`、`plugins/transparent-proxy/`)——第四類 SYN 掃描現在可經 pcap
> 現形並以 `syn_only` 誠實標示。特權執行(tcpdump/iptables/pf)在操作員側跑;純解析有單元測試。
> 下方分析為背景,仍成立。

相關：[`DESIGN-traffic-capture.md`](DESIGN-traffic-capture.md)（截取管線）、
[`DESIGN-core-and-capture.md` §2.1](DESIGN-core-and-capture.md)（非 HTTP 流量的決策）、
[`event-schema.md`](event-schema.md)（`scanner` / `dns` / `http_navigation` 鍵）。

---

## 1. 滲透測試會產生哪些流量，各自長怎樣

按 RedLog 看得到的形態分四類，不是按攻擊階段分。**能不能歸因，取決於它以什麼形態
到達 RedLog**，跟工具名字無關。

| 類別 | 典型工具 | 送出的東西 | RedLog 看得到的形態 |
|---|---|---|---|
| **應用層 HTTP/S** | Burp、sqlmap、ffuf、nuclei、gobuster、瀏覽器手動操作、curl/wget | 完整 request + response（含 header、body、狀態碼、時間） | `scanner`（經 mitmproxy）／`http_navigation`（經 CDP 瀏覽器） |
| **DNS** | 解析、子網域枚舉、DoH/DNS 隧道 | query name/type、response code、answers | `dns`（經 mitmproxy DNS 模式） |
| **連線層（有握手）** | reverse shell、bind shell、SMB/LDAP/RDP、C2 beacon、scp/rsync、`nc` | 一條 TCP/UDP 連線：五元組、協定、時長 | `scanner.connection`（經 connection-monitor 輪詢 socket 表） |
| **連線層（無握手）** | `nmap -sS` SYN 掃描、`masscan`、UDP 掃描 | 半開封包，從不完成握手 | **看不到**（socket 表裡沒有已建立連線）——只有那道 `nmap` 指令在時間軸上，封包本身沒有 |

第四類是結構性的洞，不是 bug：不抓原始封包（pcap）就一定看不到 SYN 掃描。RedLog 的
立場是**誠實標示**而非假裝有覆蓋——指令有記錄，它產生的封包沒有，而 UI 要說出這件事
（`connection_capture_started` 事件的文案就是在講這個）。pcap 是未來的補強，代價是 root /
`CAP_NET_RAW`、Windows 要裝 npcap、二進位 payload 的遮蔽是另一個問題（見 §2.1 的成本表）。

---

## 2. 「依工具分開」實際上是兩個不同的問題

「依工具分開」可以指兩件事，兩者的難度差一個數量級：

- **A. 按流量的種類分**——HTTP 歸 HTTP、DNS 歸 DNS、連線歸連線。**今天就做到了。**
  這正是 18 泳道 + 4 分帶（指令／流量／產物／訊號）在做的事：`scanner`、`dns`、
  `http_navigation`、`browser` 各有自己的泳道，`filter` 列可以只留一種。
- **B. 按產生它的指令/工具分**——「這 40 筆 request 是那一次 `sqlmap` 打出來的」、
  「這條 SMB 連線是那道 `crackmapexec` 開的」。**這是真正的問題，目前只做了一半。**

下面談 B。

### 2.1 HTTP / DNS：已經帶得動歸因，只差把它接起來

每一筆經 mitmproxy 的流量事件都帶 `source_addr`（`client_conn.peername`，即
`IP:port`）。同一台機器上，這個來源埠在那個時間點**唯一對應一個 pid**，而 pid 又對
應一道指令。所以歸因鏈是：

```
http_request（source_addr=127.0.0.1:54321）
   → 反查 socket 表：54321 屬於 pid 8821
   → pid 8821 是 sqlmap，由 shell.command_start 記過
   → 把 http 事件的 _causes 指向那道 command_start
```

`_causes` 這個因果欄位已經存在（DNS response 已經用它指回 query，HTTP response 指回
request）。缺的是「新流量事件進來時，用 `source_addr` 反查一次 pid，再把 `_causes`
指向對應的指令」這一步。這跟 §2.2 的連線層歸因是**同一個 socket→pid→指令查表**，應該
一起做。

一個天然但較弱的替代：mitmproxy 每個工具用不同的上游埠（Burp 走 8080、sqlmap 走
8081…），addon 把監聽埠寫進事件，就能粗略分流。可行，但要操作員手動配置每個工具的
proxy，而且瀏覽器手動操作跟 sqlmap 若共用一個 proxy 就分不開。socket→pid 反查不需要
操作員做任何事，是更好的預設。

### 2.2 連線層：pid 欄位在，關聯還沒接

`connection-monitor` 輪詢 socket 表，Linux 用 `ss`、Windows 用 `netstat -no`，
**兩者都給得到 pid**，事件也已經帶 `pid`（見 `connection-monitor.ts` 第 182 行）。
macOS 是例外：`netstat` 不吐 pid，要 `lsof` 且看別人的連線要 root，所以 macOS 上
`pid` 目前是 undefined。

所以連線層的現況是：**Linux/Windows 有 pid，但沒有把 pid 翻成指令**；macOS 連 pid
都還沒有。要做的是同一件事——一張 `pid → 最近一筆 shell.command_start` 的表，連線事件
進來時查它、填 `_causes`。process-monitor 已經在維護類似的 ppid→session 對應
（`_causes` 指到 `session_start`），可以共用。

### 2.3 建議實作：一個共用的 `socket-attribution` 解析器

把三個來源（HTTP source_addr、DNS source_addr、connection pid）收斂到一個純函式：

```
resolveOwningCommand({ pid?, localPort? }, now) → commandStartEventId | null
```

- 維護兩張有界表，跟 `causes-resolver.ts` 的 `BoundedMap` 同樣的淘汰策略：
  `localPort → pid`（從 socket 表，定期刷新）與 `pid → command_start eventId`
  （shell hook 送 `command_start` 時寫入，`command_end` 時保留一小段 TTL，因為
  子行程可能在指令回報結束後才收尾）。
- HTTP/DNS 事件只有 `source_addr`：先 `localPort → pid` 再 `pid → command`。
- 連線事件已有 `pid`：直接第二段。
- 查不到就回 null，事件照存，只是沒有 `_causes`——**歸因失敗絕不能擋下截取**，這是
  §1「先全抓」的底線。

純函式、可單元測試，跟 `causes-resolver` 放在一起。UI 端不用改：時間軸的
「相關／因果鏈」面板已經會讀 `_causes`，一旦填上，點一筆 request 就能跳到開它的那道
`sqlmap`，反過來從指令也能展開它產生的所有流量。

### 2.4 歸因不到的時候，怎麼呈現才誠實

- 抓到 pid 但對不到指令（例如 GUI 的 Burp，不是從被 hook 的 shell 起的）：把
  `process_name` 填進事件（`ss`/`netstat` 給得到），至少顯示「這條連線屬於 `java`
  (Burp)」，即使連不到某道指令。
- macOS 沒有 pid：事件照存五元組，UI 標「本機無法歸因（macOS 需 lsof/root）」，跟
  SYN 掃描同樣的誠實標示原則。
- 完全對不到：留白，不要猜。§3「兩層屬性」規定推論一律標為 suggestion，歸因是推論。

---

## 3. 一句話總結給操作員

- **HTTP / DNS**：已經分得開（按種類），而且**幾乎**能對到是哪道指令打的——差
  source_addr→pid 這一步反查，屬於待做。
- **nmap / SMB / reverse shell 等連線**：Linux/Windows 上連線帶 pid，把 pid 對到指令
  是同一個待做項；`nmap -sS` 這種半開掃描抓不到封包，是不裝 pcap 就無解的物理限制，
  UI 會明說。
- **全抓**這件事本來就成立：流量原始內容進 sidecar、只有 sha256 上鏈；歸因是加在上面
  的一層，做不到時退化成「有這筆流量、但不知是誰開的」，而不是丟掉它。

待辦追蹤：`socket-attribution` 解析器（§2.3）是把「依工具分開」從一半做到完整的關鍵，
且 HTTP 與連線兩邊共用它。
