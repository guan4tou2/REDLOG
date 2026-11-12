# B — 多 producer 進單一本機 store：傳輸契約、收據、冪等、遺失帳本、交接目錄、tailer、邊緣蓋章、暫停邊界、跨語言一致性

讀取日期：2026-11-12。版本以頁面當下所示為準（OTLP 1.11.1；Filebeat 9.x 文件；Vector 現行文件；Sentry develop docs client-reports 1.26.0 changelog）。
標記：**[源]** = 已讀一手來源；**[次]** = 只讀到二手來源；**[未驗]** = 憑記憶或找不到一手來源。

---

## 0. 一頁摘要

| 主題 | 收斂設計（≥3 系統同意） | 最小可採用版本 | 主要來源 |
|---|---|---|---|
| 1 收據 | 逐項（per-item）結果 + 「可重試 / 不可重試」二分 + 部分成功時回報被拒數與原因；伺服器告知退避時間 | receipt：`accepted`/`duplicate`/`rejected{reason}`/`retry_after{ms}`，逐項，與請求同序同長 | OTLP partial_success、Kinesis PutRecords、PRW 2.0 `*-Written` 標頭、Fluent Forward `ack` |
| 2 冪等 | producer 產生的 key；伺服器在**有界**窗口內記住；重複回「已收，原始位置」而非錯誤；跨重啟只有穩定 id 才能去重 | `event_id` = producer 端 UUIDv4/v7（或 `producer_instance_id + seq`），store 以 UNIQUE 約束永久去重（本機無需時間窗） | Kafka KIP-98、Stripe、SQS FIFO、NATS（次） |
| 3 遺失帳本 | 遺失以「計數 + 原因列舉」呈現，與資料分開傳送、晚一點送達；有序號的流可在流內偵測缺口 | producer 端 `discarded{reason,category,qty}` 聚合，搭下一個 envelope 送；receiver 用 `(instance_id, seq)` 偵測缺口並寫 gap 記錄 | Sentry client reports、OTel SDK metrics `error.type=queue_full`、Vector `component_discarded_events_total{intentional}`、auditd `lost`、/dev/kmsg seq+EPIPE、perf `PERF_RECORD_LOST` |
| 4 本機緩衝 | append-only 分段檔 + checksum；滿了要明確選 block / drop_newest / drop_oldest 並計數；壞檔隔離而非刪除；DLQ 有上限且需人工處理 | spool 目錄 `tmp/ → new/ → (ingested 刪除) / quarantine/`，rename 交接；滿了 drop_newest + 記帳 | maildir、Postfix corrupt/hold、Fluent Bit DLQ、Logstash DLQ、Vector disk buffer |
| 5 tailer | 以內容前綴指紋辨識檔案（inode 會重用）；offset 只在下游確認後持久化；copytruncate 有窗口遺失 | 指紋 = SHA-256(前 1024 bytes)＋檔案小於門檻先不追；offset 存在同一個 DB transaction 與寫入的事件一起 commit | Filebeat 9.0 改預設 fingerprint、Vector checksum、Fluent Bit tail |
| 6 邊緣蓋章 | 兩個時間戳：事件時間（來源時鐘）與觀察時間（收集端時鐘）；可信欄位由 receiver 蓋，client 送的同名欄位一律忽略；producer 送 sdk 名稱/版本 | envelope 帶 `ts_event`(producer) + `sent_at`(producer)；receiver 蓋 `ts_observed`、`peer_pid/uid`、`producer_trust`；`sdk{name,version}` 必填 | OTel log data model、Sentry `sent_at`、journald `_` 前綴可信欄位、OTel `telemetry.sdk.*` |
| 7 暫停邊界 | disabled 時在管線**第一步**丟棄（不入佇列）；shutdown 後拒收並計 `already_shutdown`；sampling DROP 不進 processor | producer 在捕捉點檢查 pause；pause 期間丟棄且只計數 `paused`；receiver 再以 pause 區間二次過濾 | Sentry client「disabled 第一步丟棄」、OTel `already_shutdown`、Sampler DROP |
| 8 一致性 | 文字規格 + 共用測試向量 + 每個實作提供一個統一 CLI 入口給共用測試驅動 + xfail 清單 + 相容矩陣 | `conformance/vectors/*.json` + mock receiver + 每個 producer 實作 `producer-under-test` 入口 | sigstore-conformance、OTel compliance matrix、OTel in-memory exporter |

---

## 1. 傳輸契約與收據

### 1.1 各系統怎麼做

**OpenTelemetry OTLP（1.11.1，Stable）** [源 https://opentelemetry.io/docs/specs/otlp/]
- 全成功：HTTP 200 / gRPC OK，`partial_success` MUST 未設。空請求 SHOULD 回成功。
- 部分成功：`partial_success.rejected_{spans|log_records|data_points}` + `error_message`（人讀、無結構）。只有警告時 rejected=0 且訊息非空。**client MUST NOT retry 帶 partial_success 的回應**——被拒的那部分視為永久拒絕。
- 可重試：gRPC `UNAVAILABLE`、`DEADLINE_EXCEEDED`、`ABORTED`、`CANCELLED`、`OUT_OF_RANGE`、`DATA_LOSS`；`RESOURCE_EXHAUSTED` 只有伺服器附 `RetryInfo` 才可重試。HTTP 僅 429/502/503/504 可重試，**其他 4xx/5xx MUST NOT retry**。
- 不可重試的資料 MUST 丟棄，SHOULD 計數。
- 節流：HTTP 429/503 可帶 `Retry-After`（秒或 HTTP-date），client SHOULD 遵守；無則指數退避；斷線則指數退避加 jitter。
- 冪等：明說「為了交付寧可重複」，不定義去重機制。
- 注意設計取捨：OTLP 的部分成功**只有計數**，沒有逐項索引——producer 無法知道是哪幾筆被拒。

**AWS Kinesis PutRecords** [源 https://docs.aws.amazon.com/kinesis/latest/APIReference/API_PutRecords.html]
- 回 200 + `FailedRecordCount` + `Records[]`；回應陣列**與請求同長、同序**，成功項有 `SequenceNumber`/`ShardId`，失敗項有 `ErrorCode`（`ProvisionedThroughputExceededException` | `InternalFailure`）+ `ErrorMessage`。
- 一筆失敗不中止後續；因此批次內不保證順序。producer 自己挑失敗項重送。
- 這是「逐項收據」最乾淨的範本：位置對應，不需要 id。

**Elasticsearch Bulk** [源（部分）https://www.elastic.co/docs/api/doc/elasticsearch/operation/operation-bulk]
- 回 `took`、`errors`(bool)、`items[]` 每個動作一項。`create` 動作在同 `_id` 已存在時失敗（`index` 則覆寫）——即「用 create + 自訂 id 得到冪等」。失敗項 status 409 的細節本次頁面截斷，**[未驗]**。
- 慣例（**[未驗]**，憑記憶）：HTTP 200 不代表全部成功，必須看 `errors` 再逐項處理；429 項可重試，400 類不可。

**Prometheus Remote-Write 2.0** [源 https://prometheus.io/docs/specs/prw/remote_write_spec_2_0/]
- receiver MUST 回 `X-Prometheus-Remote-Write-{Samples,Histograms,Exemplars}-Written` 計數；未帶時 sender 可假設 0。
- receiver MUST NOT 回 2xx，除非所有已知資料都已同步寫入。部分無效回 400，錯誤內文 SHOULD 說明被拒數與原因。
- 5xx MUST retry（退避）；429 MAY retry（落後時可放棄以便前進）；其他 4xx MUST NOT。
- 重送必須是冪等的。
- **v1 → v2 的教訓**：v2 用「寫入計數」標頭偵測**壞掉的 v1 receiver**——它們忽略 Content-Type、把 v2 payload 當空的、回 2xx 而沒計數；sender 看到這個模式應當視為 415。也就是：**「2xx 但沒說收了幾筆」本身就是一種故障訊號**。

**Fluent Forward v1** [源 https://github.com/fluent/fluentd/wiki/Forward-Protocol-Specification-v1]
- 選項 `chunk` = Base64 的 128-bit 唯一 id。有 `chunk` 時 server MUST 回 `{ack: <同 chunk>}`；沒有則 server 靜默。client 沒收到 ack SHOULD 稍後重送。
- 未定義重試次數、退避與去重——「ack 遺失 → 重送 → 重複」留給實作。即 at-least-once，chunk id 可當去重 key，但規格沒要求 server 去重。

**Splunk HEC indexer acknowledgment** [源 https://help.splunk.com/en/splunk-enterprise/get-data-in/collect-http-event-data/about-http-event-collector-indexer-acknowledgment]
- 明說 **HTTP 200 不夠**：200 在事件進入處理管線前就回了。
- 開啟後每個請求回 `{"ackID": n}`；client 自帶 channel GUID；之後 `POST /services/collector/ack?channel=…` `{"acks":[…]}` 輪詢（建議約 10 秒）。
- `true` = 達到複寫因子（**仍不保證已索引**，parser 可能丟）；`true` 回過一次後狀態即刪，再查回 `false`。
- 逾時（例如 5 分鐘）未確認 → 視為遺失重送，**並把重送資料標記為「可能重複」**。
- 這是「兩段式收據」：收下（accepted）≠ 持久化（durable）。

**Sentry 攝取** [源 https://develop.sentry.dev/sdk/expected-features/rate-limiting/]
- `X-Sentry-Rate-Limits: retry_after:categories:scope:reason_code:namespaces`；**任何狀態碼（含 200）都要解析**。429 只有 `Retry-After` → 對所有類別；兩者都無 → 假設 60 秒。
- 每個 DSN、每個類別各自追蹤；未知類別忽略；多個限制取較長者。限制期間 SDK MUST 不送並丟棄該類別資料。
- 429 不記 client report（上游已計，避免重複計數）[源 client-reports 1.3.0]。

**Kafka produce acks** [源 https://docs.confluent.io/platform/current/installation/configuration/producer-configs.html]
- `acks=0` 不等回應（retries 無效）；`1` leader 寫入即回，leader 掛可能遺失；`all` 等全部 ISR。`delivery.timeout.ms`（預設 120 s）是 `send()` 之後回報成敗的上限——**「最終一定會告訴你結果」的時間界線**。

**syslog** [源 RFC 5424 §4, §8.5 https://www.rfc-editor.org/rfc/rfc5424；RFC 5425 §6.3；RFC 3195]
- RFC 5424 明說協定不提供交付確認；沒有遺失指示時訊息會「無聲消失」；發送端若**刻意**丟棄應能通知 relay/collector。`meta` SD-ID 的 `sequenceId`（從 1 遞增，2147483647 回捲）RFC 沒說是用來偵測遺失——那是推論。
- RFC 5425（TLS）：無應用層 ack；連線斷時發送端「不一定知道」哪些已送達。
- RFC 3195（BEEP）：RAW 無逐項 ack；COOKED 逐項回 ok/error。採用度：**[未驗]**（憑記憶：極少部署，業界轉向 RELP 等非標準方案）。
- 教訓：syslog 是反例——三十年來的主要傳輸都沒有收據，所以 rsyslog 等另造 RELP（**[未驗]**）。

**systemd-journal native protocol** [源 https://systemd.io/JOURNAL_NATIVE_PROTOCOL/]
- 一個 datagram 一筆；`KEY=VALUE\n`，值含換行時改為 `KEY\n<u64 LE 長度><bytes>\n`；過大時改傳一個 sealed memfd。無 ack；建議加大 `SO_SNDBUF` 延後阻塞。
- `_` 開頭欄位為**可信欄位**，由 journald 接收端附加；client 送來的直接忽略（見 §6）。

**Loki push** [源（部分）https://grafana.com/docs/loki/latest/reference/loki-http-api/]：JSON `streams[{stream, values[[ts_ns_string, line, {meta}]]}]`。成功碼、亂序/過舊 400、429、部分寫入語意本頁未載，**[未驗]**。

### 1.2 收斂與差異
- **收斂**：(a) 可重試 vs 永久拒絕二分，且「永久拒絕的不准重送」（OTLP、PRW 2.0、Sentry、Logstash DLQ 只收 400/404）；(b) 伺服器主導退避時間（Retry-After / RetryInfo / X-Sentry-Rate-Limits）；(c) 部分成功是常態，必須能表達（OTLP 計數、Kinesis/Bulk 逐項、PRW 計數標頭）；(d) 重送必然造成重複，接收端要冪等或標記可能重複（OTLP、PRW、HEC、Forward）。
- **差異**：粒度——OTLP/PRW 只給計數（producer 無法知道哪筆），Kinesis/Bulk 逐項（可精準重送）；耐久層級——HEC/Kafka acks=all 把「收下」和「持久」分開，OTLP 不分。

### 1.3 收據應列舉的結果與 producer 的必要反應

| outcome | 意義 | producer 必做 |
|---|---|---|
| `accepted` | 已**持久寫入**（commit 完成） | 從本機 spool 刪除；推進 checkpoint |
| `duplicate` | 同 key 先前已持久，回原始位置 | 視同 accepted（Kafka：「可忽略」；NATS 回原 seq） |
| `rejected` + reason | 永久錯誤（schema、大小、簽章、暫停期內） | **不重送**；移入 quarantine 或丟棄，並記入遺失帳本 reason |
| `retry_after` + ms | 暫時（忙、DB 鎖、啟動中） | 保留於 spool，至少等 ms，之後指數退避+jitter |
| （無回應 / 斷線） | 不明 | 當 retry；靠冪等 key 吸收重複 |
| batch 部分 | 逐項混合上述 | 依各項處理；回應與請求同序同長 |

再加一條 PRW 2.0 的教訓：**收據必須帶「寫入數」**，producer 若收到 2xx 但寫入數 ≠ 送出數，視為協定錯誤。

### 1.4 轉移 / 不轉移
- **轉移**：逐項同序收據（Kinesis 形）；永久 vs 暫時二分；「accepted 只在 commit 之後」（PRW「MUST NOT 2xx unless synchronously written」）；寫入計數自我檢查。
- **不轉移**：HEC 的非同步 ackId 輪詢（本機 SQLite 同步 commit，回應時已持久，兩段式無必要）；per-category 配額、多租戶限流、DSN；gRPC 狀態碼表。
- **最小版本**：見 §9.2。

---

## 2. 冪等與「近似 exactly-once」

### 2.1 各系統
- **Kafka idempotent producer**（KIP-98）[源 https://cwiki.apache.org/confluence/display/KAFKA/KIP-98+-+Exactly+Once+Delivery+and+Transactional+Messaging]
  - 初始化時拿 PID（使用者看不到）；每 (PID, partition) 序號從 0 每則 +1。broker 只接受「上次 +1」：較小 → duplicate 錯誤，producer 可忽略；較大 → `OutOfOrderSequenceException`，**視為致命，代表有遺失**。
  - 無 `transactional.id` 時重啟拿新 PID → **跨重啟不去重**（原文：只在單一 producer session 內保證）。
  - 有 `transactional.id`：穩定 id；coordinator 每次初始化 bump epoch，舊實例（zombie）以 `InvalidProducerEpoch`/`ProducerFencedException` 被圍堵。
  - **改過的設計**：KIP-98 時要求 `max.inflight=1`；現行 Confluent 文件為 `≤5` 且 `enable.idempotence` 預設 `true`，衝突且未明設時**靜默關閉**、明設則拋 ConfigException [源 confluent producer-configs]。教訓：預設開啟、衝突時明確失敗。
  - 「序號同時用於去重與缺口偵測」——這正是本系統遺失帳本需要的雙重用途（§3）。
- **Stripe idempotency keys** [源 https://docs.stripe.com/api/idempotent_requests]
  - client 產生（建議 UUIDv4），≤255 字元，不可含敏感資料。v1：端點**開始執行後**才保存狀態碼與內文；同 key 重送回存檔回應，**包含 500**。key 至少 24 小時後可被清除，清除後同 key 視為新請求。參數不同 → 錯誤（防誤用）。驗證失敗或與並行同 key 請求衝突時**不保存**，可重試。
  - v2 改為：重試不重做成功部分，盡可能把失敗部分做完——「v1 存回應 vs v2 收斂到完成」是明確的設計演進。
- **SQS FIFO** [源 https://docs.aws.amazon.com/AWSSimpleQueueService/latest/SQSDeveloperGuide/using-messagededuplicationid-property.html]：5 分鐘窗口；重複**被確認但不投遞**；訊息被刪除後仍追蹤 id。content-based dedup（body SHA-256）**[未驗]**（本頁未載）。
- **NATS JetStream** [次 https://www.synadia.com/blog/prevent-existing-duplicate-messages-jetstream 等]：`Nats-Msg-Id` 標頭，每 stream 的 duplicate window 預設 2 分鐘；重複回 PubAck `duplicate:true` 與**原始序號**；窗口外再送會再存一次。一手文件未讀到 → 細節 **[次]**。
- **OTLP**：明確不去重 [源 §1.1]。
- **Sentry event_id**：32 位小寫 hex uuid4，必填 [源 https://develop.sentry.dev/sdk/data-model/event-payloads/]；伺服器是否以之去重本頁未說 **[未驗]**。另外頁面內部矛盾（32 字元 vs「≤36 且為合法 UUID」）——小教訓：id 格式要單一、可機器驗證。

### 2.2 收斂
- key 由 **producer** 產生；重複回「已收 + 原位置」而非錯誤（Kafka、SQS、NATS、Stripe 回存檔）；同 key 不同內容 → 錯誤（Stripe）。
- 去重狀態都**有時間界限**（Stripe 24h、SQS 5min、NATS 2min、Kafka 以 session 為界）——那是因為分散式、多租戶的記憶體/儲存成本。
- 跨 producer 重啟：只有「穩定身分」（transactional.id、client key）才能去重；隨機 PID 不行。

### 2.3 轉移 / 不轉移
- **轉移**：producer 端 key；重複回 `duplicate` + 原 rowid；同 key 異內容 → `rejected{reason:"key_conflict"}`（並記帳，這可能是 bug 或竄改）；(instance_id, seq) 同時做缺口偵測。
- **不轉移**：時間窗口。本機單一使用者、每專案一個 DB，`UNIQUE(event_id)` 永久存在成本極低，且 hash chain 本來就要求每筆只出現一次——**去重應永久**，避免「窗口外重送造成鏈上重複」。epoch fencing 也不需要（單機、無 zombie 競爭——但見 §9.3 的 lock）。
- **最小版本**：§9.3。

---

## 3. 遺失帳本（本主題核心）

### 3.1 帶外計數（out-of-band counter）
- **Sentry client reports** [源 https://develop.sentry.dev/sdk/telemetry/client-reports/]
  - item `client_report`：`{timestamp?, discarded_events:[{reason, category, quantity}]}`，≤4 KiB。
  - reason 列舉（摘）：`queue_overflow`、`cache_overflow`、`buffer_overflow`、`ratelimit_backoff`、`network_error`、`send_error`、`internal_sdk_error`、`sample_rate`、`backpressure`、`before_send`、`event_processor`、`ignored`、`invalid`、`callback_error`…
  - 送法：**不可每丟一筆送一個 envelope**；附在已排程的 envelope 上，或後端定期 flush。報告**繞過**緩衝與佇列。**不要求跨 crash 持久化**——即 crash 會連帳本一起丟。
  - 不計：2xx；429（上游已計，1.3.0 起避免重複計數）；會重試的網路錯；SDK 自身 bug（1.7.0 起移出範圍）。
  - 聚合：每 client 一個 thread-safe 元件，**原子 read-and-reset**。
  - 1.25.0 改為「每個內含項目」計數而非每個 envelope；另計 byte 類別。**新增 reason 需先協調後端、前端、文件**——reason 是封閉列舉、版本化。
  - 明說「近似、best-effort」，接受 413 重複計數。
  - 演進史（1.0→1.26）幾乎全是在**補 reason**與**修重複計數**——這是最值得借鏡的「先錯後改」紀錄。
- **OTel SDK self-metrics**（Development）[源 https://opentelemetry.io/docs/specs/semconv/otel/sdk-metrics/]：`otel.sdk.processor.span.processed{error.type}`，`queue_full` MUST 用於佇列滿丟棄、`already_shutdown` 用於關閉後丟棄；`otel.sdk.exporter.span.exported{error.type}`，例 `rejected`（部分成功時的後備）、`timeout`、`500`；成功時 MUST NOT 設 `error.type`；`queue.size`/`queue.capacity`/`inflight` 量測。trace SDK 規格本身只說「滿了就丟」，沒定義計數器——計數是後來的 semconv 補上 [源 https://opentelemetry.io/docs/specs/otel/trace/sdk/]。
- **OTel Collector** [源 https://opentelemetry.io/docs/collector/internal-telemetry/]：`otelcol_exporter_enqueue_failed_*`（沒進佇列＝丟）、`otelcol_exporter_send_failed_*`（**不必然**是遺失，因為可能還會重試）、`otelcol_receiver_refused_*`（回錯誤給 client，是否遺失取決於 client）。教訓：**「失敗」和「遺失」要分開命名**。
- **Vector instrumentation spec** [源 https://github.com/vectordotdev/vector/blob/master/docs/specs/instrumentation.md]：`component_discarded_events_total{intentional}`；log 必含 `count`、`intentional`、`reason`；有意丟棄 debug、無意丟棄 error；log 每 10 秒限流；**會重試的不算丟棄**；造成丟棄的錯誤 MUST 同時發 EventsDropped。`intentional` 二分是最值得抄的維度（過濾 ≠ 遺失）。
- **Fluent Bit** [源 https://docs.fluentbit.io/manual/administration/monitoring]：`output_dropped_records_total`、`retries_total`、`retries_failed_total`（重試用盡＝丟）、`errors_total`；health check 在窗口內錯誤/重試失敗超門檻時 `/api/v2/health` 回 500——**遺失直接變成健康狀態**。
- **Prometheus remote write** [源 https://prometheus.io/docs/practices/remote_write/]：從 WAL 讀；斷線超過約 2 小時 WAL 壓縮後未送資料遺失。`samples_dropped_total{reason}`（`dropped_series`、`too_old`）[次]——同樣是「有意/無意」混在一個計數器靠 label 分。
- **auditd** [源 https://man7.org/linux/man-pages/man8/auditctl.8.html]：`-b` backlog 上限（預設 64）；滿時依 `-f`：0 靜默、1 printk、2 panic（「安全環境大概會想設 2」）；`-s` 顯示 `lost`（因佇列溢出丟棄的記錄數）與 `backlog`。**fail-closed 選項**（panic）是安全稽核系統獨有的設計：寧可停機也不無紀錄地執行。
- **journald** [源 https://www.freedesktop.org/software/systemd/man/latest/journald.conf.html]：每服務 `RateLimitIntervalSec`/`RateLimitBurst`（預設 30 s / 10000，依剩餘磁碟放大 1–6 倍）；超過就丟並**產生一筆「丟了幾筆」的訊息**——這是流內 gap 記錄。確切措辭 **[未驗]**。

### 3.2 流內缺口（in-stream gap marker）
- **/dev/kmsg** [源 https://docs.kernel.org/admin-guide/abi-testing.html]：每筆 64-bit 序號；reader 落後被覆寫時下一次 `read()` 回 `-EPIPE` 並跳到下一筆可用記錄 → reader 由序號差得知遺失數。「EPIPE 是歷史行為，改不得」。
- **perf** [源 https://man7.org/linux/man-pages/man2/perf_event_open.2.html]：`PERF_RECORD_LOST{id, lost}` 是 ring buffer 裡的一筆記錄，出現在遺失發生的位置；預設非覆寫模式下 kernel 不覆寫未讀資料（所以是丟新的，並記一筆 LOST）。
- **BPF ringbuf** [源 https://docs.kernel.org/bpf/ringbuf.html]：滿了 `reserve` 失敗不阻塞；**沒有內建遺失計數**——程式要自己計。反例：機制提供了失敗訊號但沒提供帳本，各工具各自補。
- **journald 抑制訊息**、**printk ratelimit「callbacks suppressed」**（**[未驗]** 措辭）同屬此類。
- **Kafka OutOfOrderSequence**：序號跳號＝遺失，致命。

### 3.3 比較：流內 vs 帶外；誰能活過 crash
| 方式 | 例 | 優點 | 活過 producer crash？ |
|---|---|---|---|
| 帶外計數 | Sentry、OTel、Vector、Fluent Bit | 便宜、可聚合、可加 reason | Sentry 明說不要求；記憶體計數器 crash 即失 |
| 流內 gap 記錄 | perf LOST、journald 抑制訊息 | 在時間線上**原位**可見 | 只有在記錄成功寫入時 |
| 序號推導 | /dev/kmsg、Kafka seq、RFC5424 sequenceId（推論） | **不靠 producer 存活**——由 receiver 從缺口推出 | 是（receiver 端偵測） |
| 持久計數 | auditd `lost`（kernel 內，重開機歸零） | — | kernel 存活即可 |

關鍵洞見：**只有「序號缺口」能涵蓋 producer 自己 crash 掉的那一刻**——producer 死了就沒法報告自己丟了什麼，但下一個 session 的 receiver 能看到 seq 停在 N 而 spool 裡沒有 N+1…，再加上「上一個 instance 沒送 shutdown 記錄」即可標為「未正常結束，尾端可能遺失（數量未知）」。

### 3.4 reason 分類的設計指引（綜合）
- 封閉列舉、版本化、新增需同步更新 receiver 與 UI（Sentry）。
- 第一維：`intentional`（使用者設定的過濾/暫停/取樣）vs 非有意（溢出、錯誤）（Vector）。混在一起，UI 會把「我按了暫停」顯示成資料遺失。
- 第二維：在哪一階段（Vector `stage: receiving|processing|sending`；OTel enqueue vs send）。
- 不計會重試的；只在**最終放棄**時計（Vector、Sentry、OTel exported「最後一次嘗試後計一次」）。
- 不重複計數：同一件事只由一方計（Sentry 429 規則）。
- 「失敗」≠「遺失」（OTel Collector send_failed 文件）。

### 3.5 轉移 / 不轉移
- **轉移**：Sentry 的 `{reason, category, quantity}` 形狀與「附在下一個 envelope」送法；Vector 的 `intentional` 維度；kmsg/Kafka 的序號缺口偵測；perf 的「在原位插 gap 記錄」；Fluent Bit 的「遺失→健康狀態」。
- **不轉移**：Prometheus/OTel 的 metrics 管線（本系統不需要時序指標後端——帳本就是 DB 的一張表）；auditd panic（但可考慮「錄製保證模式」：帳本非零時 UI 顯紅，不必停機）。
- **最小版本**：§9.5。

---

## 4. Producer 端耐久緩衝與 spool 目錄

### 4.1 各系統
- **maildir**（Bernstein, ~1995）[次 https://en.wikipedia.org/wiki/Maildir；一手 cr.yp.to 抓取失敗]：在 `tmp/` 以唯一名稱建檔 → 寫完 → `rename`（或 link+unlink）進 `new/`；reader **永不看 `tmp/`**；reader 取用後 rename 進 `cur/`。目的：reader 永遠看不到寫一半的檔，且無需鎖。link-then-unlink 非原子，可能造成重複。寫入後 fsync 與「tmp 超過 36 小時清掉」**[未驗]**（憑記憶出自 Bernstein 原文）。
  - **為何 rename-into-place 是標準**：POSIX `rename()` 在同一檔案系統內對目標名稱是原子的——觀察者要嘛看到舊狀態（不存在）、要嘛看到完整新檔；crash 只會留下 `tmp/` 裡的孤兒，可安全清掉或重試。前提：同一檔案系統；資料要在 rename **前** fsync，否則 crash 後可能得到「名稱在、內容空」（這點是 ext4 等的已知行為，**[未驗]** 於本次來源）。
- **Postfix 佇列** [次 https://www.postfix.org/queuing.html（搜尋摘要；一手頁抓取被擋）]：`maildrop`/`incoming`/`active`/`deferred` 四個佇列 + `hold`/`corrupt` 兩個「停車場」。`deferred`：首次失敗，重試間隔**倍增**；`hold`：凍結直到管理員 `postsuper` 釋放；`corrupt`：**壞掉的佇列檔不刪，留給人檢查**。`active` 有大小上限。最大存活時間後退信（`maximal_queue_lifetime`）**[未驗]**。
- **Fluent Bit filesystem buffering** [源 https://docs.fluentbit.io/manual/administration/buffering-and-storage]：約 2 MB chunk，mmap 寫檔；`up`（記憶體+檔）/`down`（只在檔）；`storage.total_limit_size` 滿時**丟最舊的 chunk**；memory-only 模式滿則**暫停 input**；`memrb` 模式丟最舊並計 `memrb_dropped_chunks/bytes`。
- **Fluent Bit DLQ**（2025-11 新增，PR #11000）[源 https://docs.fluentbit.io/manual/administration/dead-letter-queue]：觸發＝不可恢復錯誤、重試用盡、停用重試時失敗、排程器失敗。檔名 `<tag>_<status>_<output>_<uid>.flb`（**狀態碼進檔名**，人一眼看出原因）；不自動重送，「手動移除前一直在」；`storage.rejected.limit` 滿時停止複製並記 warning。這是「最近才補上」的功能——意味著之前重試用盡就是靜默丟。
- **Logstash DLQ** [源 https://www.elastic.co/docs/reference/logstash/dead-letter-queues]：只收 ES 回 400/404（不可重試）與條件式處理錯誤；連不上 ES 不進 DLQ，**無限重試**。讀 DLQ 用專門 input，讀不刪、記 offset；`max_bytes` 預設 1024 MB，`storage_policy` = `drop_newer`（預設）| `drop_older`；`retain.age` 只在寫入與關閉時檢查（過期可能殘留）；從 DLQ 再失敗的不再入 DLQ（防迴圈）；清空需停 pipeline 手刪。
- **Vector disk buffer** [源 https://vector.dev/docs/architecture/buffering-model/]：WAL 式；預設每 500 ms sync；每筆 checksum，讀到壞資料**跳過並盡量救回其餘**，並發 metric；flush I/O 錯（如磁碟滿）→ **Vector 強制停止**，因為無法確定什麼已落盤；`when_full = block`（預設，保序、背壓）| `drop_newest`；**沒有 drop_oldest**（原因頁面未說）；overflow 鏈「尚不適合生產」。
  - **v1 → v2** [源 https://vector.dev/highlights/2022-02-08-disk-buffer-v2-beta/、https://vector.dev/highlights/2022-04-06-disk-buffer-v2-stable/（次）]：v1 用 LevelDB——耐久夠但效能不穩、compaction 寫放大、預設可 mmap 1000 檔有 OOM 風險、C++ 建置複雜、同步 API 難配非同步。v2 改為「像真的 log：寫一次、循序讀、不 compaction」。0.22 自動且**破壞性**遷移，建議先備份。教訓：**順序寫入的佇列不要用通用 KV store**。
- **Filebeat / Promtail**：見 §5。rsyslog disk-assisted queue **[未驗]**（未讀）。

### 4.2 滿了怎麼辦——三種策略
| 策略 | 誰用 | 代價 | 如何回報 |
|---|---|---|---|
| block（背壓） | Vector 預設、Fluent Bit memory 模式、auditd backlog_wait | producer 卡住；對 shell hook 等於讓使用者的 shell 卡住 | 通常不計（沒丟） |
| drop_newest | Vector、Logstash DLQ 預設、perf 非覆寫 | 保留最早的脈絡，丟最新 | 計數 + reason |
| drop_oldest | Fluent Bit filesystem limit / memrb、Logstash `drop_older`、kmsg ring | 保留最新，舊的被覆寫 | 計數；kmsg 用 seq 缺口 |

對「記錄系統」：**drop_newest 較適合**——已經寫進 spool 的東西是「已觀察到」的事實，丟它等於改寫歷史；新來的被拒能在**觀察當下**記帳（「此時起 N 筆未記」）。block 對互動 shell 不可接受。

### 4.3 fsync 取捨
- Vector 500 ms、journald 5 min（CRIT 以上立即）、Fluent Bit `storage.sync normal|full`、tail DB `db.sync full` 每次寫都 sync（I/O 成本高）[源 各頁]。收斂：**依嚴重度/價值分級 sync**（journald），或固定小間隔接受小窗口遺失。
- 對 spool 交接：每個檔案寫完 fsync 一次再 rename；目錄 fsync 頻率可低（**[未驗]** 各 FS 細節）。

### 4.4 隔離（poison/quarantine）的收斂
- 壞的不刪，移到專用目錄留給人（Postfix corrupt、Fluent Bit rejected、Logstash DLQ）。
- 隔離區**有上限**，滿了停止隔離並告警（Fluent Bit limit、Logstash max_bytes）。
- 只放**不可重試**的；可重試的留在主佇列無限/退避重試（Logstash 明確區分）。
- 從隔離區重處理再失敗不得再進隔離區（Logstash）。
- 原因要能一眼看出（Fluent Bit 檔名含狀態碼）。
- 沒有一個系統自動重送 DLQ——都是人工。

### 4.5 轉移 / 不轉移
- **轉移**：maildir 三目錄 + rename；Postfix `corrupt`/`hold` 語意；Fluent Bit 檔名帶原因；Logstash「只有不可重試才隔離、隔離有上限、不再入」；Vector「無法確定是否落盤就停下並大聲說」。
- **不轉移**：chunk up/down 記憶體管理、overflow 鏈、多 output fanout、shard 動態調整。
- **最小版本**：§9.4。

---

## 5. File tailer

### 5.1 各系統
- **Filebeat filestream** [源 https://www.elastic.co/docs/reference/beats/filebeat/file-identity、https://www.elastic.co/docs/reference/beats/filebeat/how-filebeat-works]
  - 身分：`path`（最危險）、`native`(dev+inode，9.0 前預設)、`inode_marker`、`fingerprint`（**9.0 起預設**）：hash 前 `length=1024` bytes（`offset=0`，最短 64）。改預設的理由：rotation 改名使以名為 key 的追蹤誤判；inode 重用使不同檔被當同一檔 → 重複或遺失。指紋碰撞時只吃第一個。
  - 小檔：9.0–9.4 小於 offset+length 的檔**不讀直到長到夠大**；9.5 起 `fingerprint.growing` 預設開，小檔也能立即讀。——**同一設計改了兩次**，極有參考價值。
  - 遷移：只支援 path/native → fingerprint 不重讀；其他切換會從頭重讀造成重複。
  - registry 存每檔 offset；**at-least-once**：輸出未確認就持續重試；關閉時不等未確認者，重啟後重送 → 可能重複。已知限制：rotation 快過處理、輸出不可用時刪檔 → 遺失；Linux inode 重用 → 跳行。
- **Vector file source** [源 https://vector.dev/docs/reference/configuration/sources/file/]：預設 `checksum` 指紋（前 `fingerprint.lines=1` 行；`ignored_header_bytes` 跳過共同檔頭）；`device_and_inode` 因 inode 重用而不可靠；**行數不足的檔「完全不讀」**；move-and-create rotation 會讀完舊 handle 再接新檔；copytruncate「處理得不錯」但建議 `delaycompress` 並把第一個 rotated 檔納入 include 以縮小遺失窗口；checkpoint 存 `data_dir`；有 checkpoint 的檔忽略 `read_from`。是否在 ack 後才寫 checkpoint，本頁未說 **[未驗]**；end-to-end ack 頁說明 source 收到下游最差狀態才回應上游 [源 https://vector.dev/docs/architecture/end-to-end-acknowledgements/]，且 Vector 啟動時若 ack-enabled sink 的來源不支援 ack 會**警告「可能無聲遺失」**。
- **Fluent Bit tail** [源 https://docs.fluentbit.io/manual/pipeline/inputs/tail]：SQLite 存 `inode=offset`；`db.compare_filename` 才比對檔名；`rotate_wait` 5 s；inotify 溢出後以 inode+名稱比對 rotation，並**重置被截斷檔的 offset**；copytruncate **明確警告可能遺失**；超過 `buffer_max_size` 的行**預設把整個檔移出監看**（`skip_long_lines` 才跳行）——這是靜默遺失的陷阱；非正常關閉 → at-least-once 重讀；`offset_key` 可把 offset 寫進記錄。
- **Promtail**：positions 檔、`sync_period` 等設定頁 404，**[未驗]**；Promtail 已被 Grafana Alloy 取代（**[未驗]**，憑記憶）。

### 5.2 收斂
- inode 不可靠 → 內容前綴指紋（Filebeat、Vector 預設）。
- 小於指紋長度的檔是**真實邊緣情況**，兩家都曾「不讀」，Filebeat 後來改成 growing。
- offset 持久化後才算進度；crash → 重讀 → 重複（三家都明說 at-least-once）。所以下游必須冪等。
- copytruncate 有不可消除的窗口（Fluent Bit 明說，Vector 給緩解）。
- 部分末行：三家頁面都沒明說 **[未驗]**；常見做法是等換行或逾時再 flush（Fluent Bit multiline/docker_mode flush 4 s 類似）。

### 5.3 本系統的特例：AI agent transcript（JSONL）
- 這類檔通常 append-only、不 rotation，但可能被**整檔改寫**（壓縮、編輯）。辨識改寫：保存「已讀前綴的 hash」（不只是開頭 1024 bytes，而是 `[0, offset)` 的滾動 hash 或最後一塊的 hash）；重開時若已讀部分 hash 變了 → 不是 append，是改寫 → 記 `source_rewritten` 事件並以新版本重新攝取（標示為新版本，不覆蓋舊紀錄——記錄系統不改歷史）。這是本系統獨有需求，上述系統皆無對應 **[推論]**。
- 末行無換行：不攝取，直到換行出現；關閉 session 時若仍無換行，以 `partial_line` 標記攝取。

### 5.4 轉移 / 不轉移
- **轉移**：指紋＝前 N bytes hash + growing；offset 與事件**同一個 DB transaction** commit（本機同步 DB 讓「ack 後才 checkpoint」變成單一 transaction，比 Filebeat/Vector 簡單且無重複）；長行不得導致整檔停追；截斷偵測（size < offset → 記 `truncated` 並從 0 讀）。
- **不轉移**：glob 掃描大量檔、inotify 溢出重整、容器 log 格式、多 output。

---

## 6. 身分、時間、出處：邊緣蓋 vs 接收端蓋

### 6.1 各系統
- **OTel log data model** [源 https://opentelemetry.io/docs/specs/otel/logs/data-model/]：`Timestamp`＝來源時鐘的事件時間（可缺）；`ObservedTimestamp`＝收集系統時鐘的觀察時間，SHOULD 在被觀察時設定；OTel 自己產生的事件兩者相等；只支援一個時間戳的系統：有 Timestamp 用它，否則用 Observed。`Resource` 描述來源、可每批只記一次。（「為何兩者並存」規格沒明說——由定義推論：來源時鐘不可信/可缺，收集端時鐘一致。）
- **OTel Resource SDK** [源 https://opentelemetry.io/docs/specs/otel/resource/sdk/]：SDK MUST 提供預設 Resource（`telemetry.sdk.*` 名單在 semconv 另頁，本次未讀細目 → 欄位名 **[未驗]** 但憑記憶為 `telemetry.sdk.name/language/version`）；合併時更新方勝；schema_url 衝突＝錯誤。
- **OTel library guidelines** [源 https://opentelemetry.io/docs/specs/otel/library-guidelines/]：每個 release MUST 標明實作的**規格版本號**。
- **Sentry envelope** [源 https://develop.sentry.dev/sdk/data-model/envelopes/]：header `sdk`（適用所有 item 型別）、`sent_at`（UTC RFC3339，**盡量靠近實際傳送時產生**，用於校正事件時間戳的時鐘漂移；只能寫一次，重複則整個 envelope 被拒；**落地快取時不寫，送出時才加**）。未知 item 型別要**保留並轉送**、未知屬性要轉送（向前相容）。`length` 標頭讓 payload 可含換行。
  - 推導的漂移校正（**[推論]**，頁面未給公式）：`skew = receiver_now − sent_at`；`corrected_ts = event_ts + skew`。`received` 欄位由伺服器加——本次未找到一手頁 **[未驗]**。
- **journald** [源 §1.1]：`_` 前綴＝可信、由 journald 蓋，client 送的被忽略。可信度來自 `SO_PEERCRED`/`SCM_CREDENTIALS` 這類 kernel 提供的對端資訊 **[未驗]**（本頁未說機制）。
- **RFC 5424**：`timeQuality{tzKnown, isSynced}` 讓發送端**自報時鐘可信度**；`origin{software, swVersion}` 讓 receiver 知道哪個版本送的 [源]。

### 6.2 收斂
- 兩個時間：事件時間（producer）+ 觀察/接收時間（receiver）；排序與鏈用 receiver 時間，顯示可用事件時間。
- 版本欄位：每則帶 producer 名稱+版本（Sentry `sdk`、OTel `telemetry.sdk.*`、RFC5424 `origin`）。
- 可信欄位命名空間：receiver 蓋的欄位用保留前綴，client 同名欄位**忽略**而非報錯（journald）。
- 向前相容：未知欄位/型別保留不丟（Sentry）。

### 6.3 轉移 / 不轉移
- **轉移**：保留前綴（如 `_`）給 receiver 蓋的欄位；`sent_at` 漂移校正；`sdk{name,version}` + 規格版本；未知欄位原樣保存（對記錄系統特別重要——驗證者日後要能看到原樣）。
- **不轉移**：Resource 偵測器、雲端/容器屬性、schema_url 合併。
- 本機特例：shell hook 與 receiver 同一台機器同一時鐘，漂移幾乎為零，但**跨 VM / SSH 遠端 / 容器內**的 producer 會有漂移——`sent_at` 依然值得帶。

---

## 7. 暫停 / 取樣 / 同意邊界

### 7.1 各系統
- **Sentry client** [源 https://develop.sentry.dev/sdk/foundations/client/]：無 transport/DSN → disabled；disabled 時事件在**管線第一步**丟棄，processor、scope callback、breadcrumb 都不跑；`close(timeout)` 最多阻塞 timeout 秒 flush 後停用；`flush` 不停用；`before_send` 回 null → 丟並記 `before_send` client report；`sample_rate` 丟棄也必記 client report。
- **OTel** [源 trace SDK 頁]：Sampler `DROP` → 不記錄，processor 與 exporter 都收不到；`Shutdown` 只能一次，之後回 no-op tracer；關閉後丟棄計 `already_shutdown` [源 semconv]；`ForceFlush` 匯出所有未匯出的。
- **Mixpanel** [源 https://docs.mixpanel.com/docs/tracking-methods/sdks/javascript]：opt-out 後「不送任何資料」，狀態持久存在 local storage；是否清除已排隊資料，頁面未說 **[未驗]**。
- **PostHog** `opt_out_capturing`「停止捕捉並刪除本機資料」僅見於第三方鏡像 **[次]**。
- **Google Consent Mode** [源 https://developers.google.com/tag-platform/security/guides/consent]：每頁在任何 event 前設 default；`wait_for_update` 給非同步 banner 時間；拒絕時不設新廣告 cookie；同意前事件是否排隊，頁面未說。

### 7.2 收斂與缺口
- 收斂：**在捕捉點（最上游）丟**，不是在送出點過濾（Sentry 第一步、OTel DROP 不進 processor）。這樣 pause 期間的資料**從未存在於任何佇列**，自然不可能之後被 flush。
- 丟棄也要記帳，但標為有意（Sentry `sample_rate`/`before_send`；Vector `intentional`）。
- 缺口：沒有一個來源明確規範「同意被撤回時，已排在佇列中的資料要清除」——一手文件都避而不談 **[未驗]**。本系統需自訂。
- 本系統的特殊風險：producer 是**獨立程序**（shell hook、proxy addon），pause 狀態要跨程序傳遞；有競態——producer 在 pause 前一刻產生、pause 後才送達。解法：envelope 帶 `ts_event`，receiver 以 pause 區間 `[t0,t1)` 二次過濾並 `rejected{reason:"paused"}`；spool 裡在 pause 期間的檔案同樣處理（而非在 resume 後被 flush）。

### 7.3 最小版本
- 單一來源的 pause 狀態檔（例如 `state/pause` 存在＝暫停，內容為開始時間）；producer 每次捕捉前 `stat` 一次（shell 可負擔）。
- producer：暫停中 → 不寫 spool，只把 `paused` 計數 +1（有意）。
- receiver：pause 區間持久記錄於 DB；攝取時 `ts_event ∈ pause` → `rejected:paused`（不入鏈）並記帳，不寫內容。
- UI 帳本區分「暫停期間未記錄 N 筆（有意）」與「遺失 N 筆（非有意）」。

---

## 8. 一份規格、多種語言實作

### 8.1 各系統
- **OTel**：規格 + 各語言 release MUST 標明實作的規格版本 [源 library-guidelines]；**spec compliance matrix**：每個功能一列、每個語言一欄，`+`/`-`/`N/A`/空白(未知)，另有 Optional 欄 [源 https://github.com/open-telemetry/opentelemetry-specification/blob/main/spec-compliance-matrix.md]；鼓勵提供 in-memory exporter / mock 實作供測試 [源 library-guidelines]。矩陣是**自報**，不是由共用測試產生——這是它的弱點（**[推論]**）。
- **sigstore-conformance** [源 https://github.com/sigstore/sigstore-conformance]：每個 client 提供一個實作**統一 CLI 協定**的執行檔（`docs/cli_protocol.md`）；共用 pytest 套件呼叫它；驗證測試大多由 `test/assets/bundle-verify/` 的**資料檔參數化**（加案例不需加程式碼）；GitHub Action 輸入 `entrypoint`、`environment`、`xfail`（萬用字元，標記尚未支援的選用功能）；也有 mock 服務測異常情境；不追求 fuzz/覆蓋率，只測工作流程層級。
- **Sentry**：develop docs 是規格；client reports 等頁有 changelog 版本號 [源]。「共用 mock relay 測試所有 SDK」——本次未找到一手來源 **[未驗]**。
- TUF / W3C（如 web-platform-tests）共享測試向量模式：本次未讀 **[未驗]**。

### 8.2 收斂
- 規格有版本號，實作宣告它實作哪一版。
- 黑箱入口統一（CLI 協定）讓**一套**測試驅動 N 種語言。
- 測試資料化（JSON 向量），測試程式只寫一次。
- xfail 明確列出未實作的選用功能，而不是讓測試靜默略過。

### 8.3 對 sh/zsh/bash/PowerShell/Python/JS 的轉移
- 「CLI 協定」形式最適合 shell：每個 producer 提供 `producer-under-test` 入口，從 stdin/參數讀一個「動作腳本」（例如：產生事件 X、模擬 receiver 不在、模擬 pause），把產物寫到指定 spool 目錄。
- 測試驅動（一份，用 receiver 自己的語言寫）讀向量 → 呼叫入口 → **檢查 spool 目錄內容**（而非經網路）→ 比對 envelope 欄位、命名、原子性、計數帳本。
- mock receiver：就是真的 receiver 攝取函式加上可注入的 receipt（強制回 `retry_after`、`rejected`），供測 producer 對每種 outcome 的反應。

---

## 9. 最小可採用版本（具體）

### 9.1 Envelope（一個 JSON 物件，一個檔一筆或 JSONL 一行一筆）
| 欄位 | 誰設 | 說明 |
|---|---|---|
| `v` | producer | envelope 規格版本（整數），receiver 拒絕未知主版本 → `rejected:unsupported_version` |
| `event_id` | producer | UUIDv7（含時間、可排序）或 v4；冪等 key |
| `producer` | producer | `{name, version, lang}`，如 `{name:"zsh-hook", version:"3", lang:"zsh"}` |
| `instance_id` | producer | 每個 producer 程序/shell session 啟動時產生的隨機 id |
| `seq` | producer | 該 instance 內從 0 起遞增；缺口偵測 |
| `kind` | producer | 封閉列舉（`command`、`output_chunk`、`http_flow`、`transcript_line`…） |
| `ts_event` | producer | 事件時間（producer 時鐘），可缺 |
| `sent_at` | producer | 寫入 spool/送出那一刻；**落地暫存時不填，交接時才填**（Sentry 規則） |
| `body` | producer | 型別相依；大型 payload 改用 content-addressed 外部檔參照 + `sha256` + `length` |
| `discarded` | producer | 可選：附帶的遺失帳本片段 `[{reason, kind, qty, since, until}]` |
| `_ts_observed`、`_peer`(pid/uid 若可得)、`_source_path`、`_ingest_seq`、`_trust` | **receiver** | `_` 前綴保留；producer 送來的同名欄位忽略並計 `invalid` 一次 |

未知非 `_` 欄位：原樣保存（向前相容，且對驗證者完整）。

### 9.2 Receipt
每次攝取（批次）回傳與輸入同序同長的陣列 + 總計：
```json
{"written": 3,
 "items": [
  {"event_id":"…","outcome":"accepted","row":1201},
  {"event_id":"…","outcome":"duplicate","row":1180},
  {"event_id":"…","outcome":"rejected","reason":"schema_invalid","detail":"missing kind"},
  {"event_id":"…","outcome":"retry_after","ms":2000}
 ]}
```
規則：`accepted` 只在 DB commit 之後；`written` ＝ accepted 數，producer 檢查 `written == count(accepted)`（PRW 教訓）；`rejected` 的 reason 為封閉列舉（`schema_invalid`、`too_large`、`unsupported_version`、`key_conflict`、`paused`、`project_closed`）。
producer 反應：accepted/duplicate → 刪 spool 檔；rejected → 移 `quarantine/` 並帳本 +1（`paused` 例外：直接刪，計有意）；retry_after/無回應 → 留在 `new/`，退避 `min(cap, base·2^n)+jitter`，上限次數後不刪，標 `deferred`（Postfix 語意），由 UI 顯示「積壓 N 筆」。
本機以檔案交接時，receipt 不必回到 producer 程序：receiver 自己執行「刪 / 移 quarantine」，receipt 寫入 DB（每個 spool 檔一列 ingest_log），UI 與匯出讀它。網路式 producer（proxy addon 若走 socket）才需要回傳。

### 9.3 冪等 key 規則
- `event_id` 由 producer 在**事件產生當下**生成並隨 spool 檔一起持久——重送一定帶同一個 id（關鍵：不可在送出時才生成）。
- DB `UNIQUE(event_id)`，**永久**（無時間窗）。同 id：內容 hash 相同 → `duplicate` 回原 row；不同 → `rejected:key_conflict`、隔離、帳本計非有意。
- `(instance_id, seq)` 另設 UNIQUE；新 instance 啟動送一筆 `kind:"producer_start"`，正常結束送 `producer_stop{last_seq}`。

### 9.4 Crash-safe 交接目錄
```
spool/<project>/
  tmp/          producer 寫入中（reader 永不讀）
  new/          完整、待攝取
  quarantine/   不可重試，留給人
  state/pause   存在＝暫停
```
- producer：`tmp/<event_id>.<pid>.json` → write → fsync → `rename` 到 `new/<sent_at_ns>-<instance_id>-<seq>.json`（同一檔案系統；檔名可排序）。shell 沒有 fsync 可用時，退而求其次用 `mv`（rename）並接受極小窗口；**[未驗]** 各 shell 的 sync 能力。
- receiver：只列 `new/`；每檔一個 transaction：解析 → 去重 → 寫事件+鏈+ingest_log → commit → `unlink`。crash 於 commit 後 unlink 前 → 下次讀到 → `duplicate` → unlink（冪等吸收）。
- `tmp/` 中超過 N 小時（maildir 傳統 36 h **[未驗]**）的孤兒：不刪，移 `quarantine/` 並計 `producer_incomplete_write`。
- `quarantine/` 檔名：`<reason>__<原檔名>`（Fluent Bit 檔名帶原因）；附 `.reason.json`（reason、detail、時間、receiver 版本）。有總大小上限；滿了停止移入、改為只計數並在 UI 顯紅（Fluent Bit/Logstash）。不自動重送；UI 提供「檢視 / 重新攝取（修好後）/ 標記為已檢視」——重新攝取失敗**不再回到 quarantine 迴圈**，直接保留並顯示（Logstash）。
- spool 上限（producer 端）：寫前檢查 `new/` 總量；超過 → **drop_newest**（不寫），帳本 `spool_full` +1。不要 block 使用者 shell。
- 壞檔（JSON 解析失敗、checksum 不符）：與 Postfix `corrupt` 同義，入 quarantine，不刪。
- Vector 教訓：receiver 若寫 DB 失敗（磁碟滿）且無法確定是否落盤 → 停止攝取並在 UI 大聲報錯，而不是繼續刪 spool 檔。

### 9.5 遺失帳本
**計什麼**（封閉列舉 reason × `intentional` × `stage`）：
- producer 端（有意）：`paused`、`filtered`（使用者排除規則）、`sampled`。
- producer 端（非有意）：`spool_full`、`write_error`、`oversize_truncated`、`encode_error`、`hook_timeout`。
- receiver 端：`rejected:<reason>`、`quarantined`、`seq_gap`（由 `(instance_id, seq)` 推得）、`producer_unclean_exit`（有 start 無 stop，數量未知）、`tail_truncated`、`source_rewritten`、`tmp_orphan`。
- 不計：會再重試的；`duplicate`（那是正常的冪等吸收，另計於 ingest_log 供診斷）。

**存在哪**：
- producer 端：一個小檔 `spool/<project>/state/discarded-<instance_id>.json`，以 read-modify-rename 原子更新（活過 producer crash，優於 Sentry 的「不要求持久」）；或直接附在下一個 envelope 的 `discarded` 欄位（Sentry 附帶送法）。shell 實作取後者較簡單：計數放 shell 變數，下次成功寫 spool 時附上並歸零；shell 結束時寫一筆 `producer_stop` 帶剩餘計數。
- receiver 端：DB 表 `loss_ledger(id, project, ts_from, ts_to, source{producer,instance_id}, stage, reason, intentional, qty, qty_known bool, detail)`，**進入 hash chain**（帳本本身是記錄的一部分；事後無法偷偷抹除遺失）。
- 時間線：在缺口位置插一筆 gap 標記（perf `PERF_RECORD_LOST`、journald 抑制訊息的做法），讓讀者在原位看到「此處 zsh session X 遺失 seq 41–57」。

**如何到 UI**：常駐狀態指示（0 = 綠；非有意 >0 = 琥珀/紅，Fluent Bit 健康檢查思路）；點開為依 source × reason 的表；時間線上 gap 標記；有意與非有意分開顯示（Vector）。
**如何進匯出**：bundle 內含 `loss_ledger.jsonl`（與事件同一簽章範圍）與摘要（每 source 的 seq 覆蓋範圍、缺口、未正常結束的 instance）。驗證者可據此說明「此 bundle 已知不完整之處」——系統不宣稱完整，只宣稱**已知遺失已全部列出**。

### 9.6 共用一致性測試包
```
conformance/
  SPEC_VERSION                 envelope/receipt 規格版本
  vectors/
    envelope-valid/*.json      輸入動作 + 期望 spool 產物（欄位、型別、命名規則）
    envelope-invalid/*.json    期望 receiver outcome + reason
    receipts/*.json            注入 receipt → 期望 producer 行為（刪/隔離/保留/退避）
    loss/*.json                pause、spool 滿、seq 缺口、unclean exit → 期望帳本列
    unicode-binary/*.json      非 UTF-8 輸出、超長行、內嵌換行、CRLF
  driver/                      一份測試驅動（receiver 的語言），讀向量、呼叫入口、檢查 spool
  mock-receiver/               真 receiver 攝取函式 + 可注入 outcome
  xfail/<producer>.txt         每個 producer 尚未支援的選用項（萬用字元）
  matrix.md                    由 driver 結果**自動產生**的相容矩陣（不是自報）
```
每個 producer（sh/zsh/bash/PowerShell/Python/JS）提供一個入口 `producer-under-test --spool DIR --action FILE`，動作包含：`emit{kind, body}`、`set_pause on|off`、`fill_spool`、`kill -9 mid-write`（驗證 `tmp/` 孤兒且 `new/` 無半檔）、`restart`（驗證新 instance_id 且 seq 歸零、帶 start 記錄）。driver 檢查的不變式：
1. `new/` 中每個檔都可完整解析（從無半檔）。
2. `event_id` 在重送間不變。
3. `(instance_id, seq)` 連續；帳本數 + 成功數 = 嘗試數。
4. pause 期間 `new/` 無新檔，帳本 `paused` 等於嘗試數。
5. `_` 前綴欄位不出現在 producer 產物中。
6. `sent_at` 只出現一次。
在 CI 對每個 producer 跑一次（PowerShell 在 Windows runner，其餘 ubuntu/macOS），矩陣由結果產生。

---

## 10. 共通：什麼不轉移（總結）
多租戶配額與 per-category 限流、DSN/token 認證、gRPC 狀態碼表、叢集複寫層級（acks=all、HEC replication factor）、非同步 ackId 輪詢、時間窗去重（本機可永久去重）、epoch fencing（改以單一 receiver lock 檔代替 **[推論]**）、動態 shard、overflow 緩衝鏈、metrics 時序後端、Resource 偵測器。這些都是在解「多機、多租戶、網路不可靠、資料量巨大」——本系統是單機、單一使用者、同步 DB，**最大的風險反而是 producer 程序在使用者的 shell 裡出錯、卡住或被殺**，以及「遺失無聲」。

---

## 11. 無法驗證的項目
- Elasticsearch Bulk 失敗項結構、409 狀態碼、429 逐項重試慣例（頁面截斷）。
- Loki push 成功碼、亂序/過舊 400、429、部分寫入語意。
- Promtail positions 檔與 backoff 設定（設定頁 404）；Promtail 已被 Alloy 取代。
- NATS JetStream 去重細節（僅二手來源）。
- SQS content-based dedup（SHA-256）細節。
- Sentry 伺服器是否以 `event_id` 去重；`received` 欄位；SDK 共用 mock relay 測試。
- Sentry `sent_at` 漂移校正公式（頁面只說用途）。
- journald 抑制訊息確切措辭；printk ratelimit「callbacks suppressed」措辭與 printk ring buffer 覆寫細節。
- maildir 一手原文（cr.yp.to 抓取失敗）：寫後 fsync、`tmp/` 36 小時清理。
- Postfix 一手頁（postfix.org 回 402）；佇列描述來自搜尋摘要；`maximal_queue_lifetime` 未驗。
- rename 前未 fsync 導致空檔的檔案系統行為；目錄 fsync。
- rsyslog disk-assisted queue、RELP；RFC 3195 採用度。
- Vector file source 是否只在 ack 後寫 checkpoint；Vector 不提供 drop_oldest 的原因；disk v2 內部（ledger、checksum 格式）。
- Prometheus `samples_dropped_total{reason}` 一手定義（僅二手）。
- OTel `telemetry.sdk.*` 欄位名（semconv 細頁未讀）。
- PostHog/Mixpanel/Google Consent Mode 在撤回同意時是否清除已排隊事件——一手文件皆未說明。
- TUF、W3C web-platform-tests 的測試向量模式（未讀）。
- §5.3、§7.2、§9 中標 **[推論]** 者為本報告的設計推導，非任何來源的主張。
