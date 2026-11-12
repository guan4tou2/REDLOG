# A — 防竄改本機紀錄與可驗證匯出：既有系統的做法

讀取日期：2026-11-12。所有 URL 為本次實際讀取的一手來源；標「未驗證」者為記憶或未讀到原文的部分。

## 0. 一頁摘要

| 主題 | 收斂設計（多個系統一致） | 最小可採用版本 | 主要來源 |
|---|---|---|---|
| 追加式日誌結構 | Merkle tree（葉 `H(0x00‖entry)`、節點 `H(0x01‖L‖R)`），簽「定期的 head/checkpoint」而非每筆；inclusion proof + consistency proof | 保留現有 hash chain 作為寫入順序；另外在每次 seal 時對同一序列計算 RFC 9162 Merkle root，簽 checkpoint `(origin, size, root)` | RFC 9162 §2.1；C2SP tlog-checkpoint；Crosby–Wallach 2009 |
| 尾端截斷／回滾 | 只有日誌本身**無法**偵測；需要「驗證者已持有的較舊 checkpoint」+ consistency proof（Go sumdb、CT、witness），或定期 heartbeat（CloudTrail 空 digest）、關閉紀錄（Schneier–Kelsey close entry） | 每份匯出帶 checkpoint；收件者保存上次的 checkpoint 並要求 consistency proof；本機另寫「session 開始／正常關閉／異常關閉」紀錄與固定間隔 heartbeat | go sumdb 設計；C2SP tlog-witness；CloudTrail digest；Schneier–Kelsey §3.2–3.3 |
| 外部時間錨定 | 只錨定一個 hash（head），證明「在 T 之前已存在」；不證明正確性 | 有網路時：對 checkpoint root 取 RFC 3161 token 或 OpenTimestamps（pending 可之後 upgrade）；離線：明說「僅本機時鐘」 | RFC 3161；OpenTimestamps 公告；Roughtime RFC；Sigstore TSA |
| 匯出容器 | 「被簽的內容清單」列出每個成員的 (路徑, 長度, digest)，清單本身才是被簽物；成員以 content address 綁定 | 一個 manifest（每筆附件 `{path, size, sha256, mediaType}`）+ checkpoint，包成 DSSE 信封簽 exact bytes | TUF targets；OCI descriptor；BagIt；in-toto/DSSE；Sigstore bundle |
| 合法省略 vs 竄改 | 被省略項的承諾（hash）仍留在被簽結構中，並有明確「已遮蔽」標記與理由；未在遮蔽清單內卻缺失 → 失敗 | Merkle 葉 hash 永遠在；匯出列出 `withheld: [{index, leafHash, reason}]`；驗證器區分 `withheld` / `missing` / `mismatch` 三種狀態碼 | C2PA §6.8、§15.10.3.1 |
| 格式版本與未知欄位 | 版本放在被簽的型別字串中；主版本不符即拒絕；同主版本下未知欄位：in-toto「忽略」、TUF「仍納入簽章驗證」、C2PA「可忽略或整份標為 unknown provenance」 | payloadType 帶主版本；未知主版本 fail closed；未知欄位因簽 exact bytes 已被認證，可顯示但不得影響判定 | DSSE；in-toto v1 README；TUF spec；C2PA §5.1 |
| 兩個驗證器一致 | 共享測試向量（有效／無效／可接受 + 預期錯誤碼）與 CLI 協定 | `vectors/` 目錄：輸入 bundle + 預期狀態碼；兩個實作都跑 | Wycheproof；sigstore-conformance |
| 金鑰 | 簽章帶 key id 只作「提示」；公鑰由帶外指紋或驗證者已持有的金鑰提供；輪替以「舊鑰簽新鑰」或「依時間窗查金鑰」 | Ed25519（或為 Secure Enclave 用 P-256），簽章帶 key fingerprint；首次匯出要求帶外核對指紋；輪替寫入一筆由舊鑰簽的 key-rotation 紀錄 | DSSE keyid；signify；minisign；CloudTrail ListPublicKeys；TUF root rotation；SSH accept-new |
| 正規化 | 簽「實際傳輸的位元組」，不要簽「結構」；需要時才用 RFC 8785 / 確定性 CBOR | 一律 hash／簽 exact bytes；儲存時保留原始位元組；不要在驗證時重新序列化 | DSSE background；Latacora；TUF issue #92；RFC 8949 §4.2 |
| 寫入者身分 | 憑證決定身分，由接收端蓋章；用戶端自稱欄位視為不可信 | 每個 producer 一個 write-only ingest token；主程序依 token 蓋 `producer_id`；用戶端自述放在 `claimed.*` | Sentry DSN；K8s bound SA token；SLSA external vs internal parameters；GitHub installation token |

---

## 1. 追加式防竄改日誌

### 1.1 純 hash chain 與 Schneier–Kelsey（1999）

來源：Schneier & Kelsey, "Secure Audit Logs to Support Computer Forensics"（PDF：https://www.schneier.com/wp-content/uploads/2016/02/paper-auditlogs.pdf；摘要頁 https://www.schneier.com/academic/archives/1999/05/secure_audit_logs_to.html）。

- 機制（§3.1，可重實作）：每筆 `L_j = W_j, E_{K_j}(D_j), Y_j, Z_j`，其中 `K_j = H("Encryption Key", W_j, A_j)`、`Y_j = H(Y_{j-1}, E_{K_j}(D_j), W_j)`（hash chain）、`Z_j = MAC_{A_j}(Y_j)`、`A_{j+1} = H("Increment Hash", A_j)`，舊 `A_j` 立即不可回復地刪除。`W_j` 是紀錄型別／權限遮罩。
- 解決的問題：攻擊者在時間 t 取得機器後，無法讀取或偽造 t 之前的紀錄（forward security）。
- **明確不解決**：作者直言沒有任何措施能保護「攻擊者取得控制後」寫入的紀錄，且「no cryptographic method can be used to actually prevent the deletion」；只能在 U 最終聯繫到可信機器 T 時偵測刪除。攻擊者**可以刪除一段或整個檔案**，但不能造新紀錄替代。
- 截斷偵測的關鍵設計：開檔時把 `A_0` 承諾給 T（§3.2）；若 T 沒回應，寫 `AbnormalCloseType` 紀錄並關檔；正常關閉寫 `NormalCloseMessage` 並刪掉最後的 `A_f`（§3.3）。也就是說，**截斷是靠「外部已知的開始」+「明確的關閉紀錄」來偵測**，不是靠鏈本身。
- 成本：每筆一次 hash + MAC，很便宜；但驗證需要共享秘密的 T（對稱 MAC），第三方無法獨立驗證。

### 1.2 Crosby–Wallach history tree（USENIX Security 2009）

來源：https://www.usenix.org/legacy/event/sec09/tech/full_papers/crosby.pdf

- 問題：hash chain 證明「第 i 筆在 C_j 中」或「C_i 與 C_j 一致」需線性時間。論文摘要：hash chain 可能需要 800 MB 來證明 8000 萬筆中的一筆，history tree 只要 3 KB。
- 機制：版本化的 Merkle tree；每加一筆產生 commitment `C_i`；五個演算法 `ADD`、`INCR.GEN`、`MEMBERSHIP.GEN`、`INCR.VF`、`MEMBERSHIP.VF`（§2.3）。「Historical Consistency」定義：若 `C_j` 與 `C_k` 的 incremental proof 驗證成功，兩者對共同前綴的任何一筆必相同。
- 安全模型重點：logger **完全不可信**；客戶端在收到 commitment 後必須「立即轉發給 auditors」（§2.2），否則 logger 可與客戶端合謀回滾。**偵測回滾／分叉完全依賴 auditor 手上有舊 commitment**。
- 也區分了「forward integrity」模型（§2.4，即 Schneier–Kelsey）：只保護拜占庭失效之前的事件。
- 附加功能「Merkle aggregation」（§4）：在節點上聚合屬性，允許依約定刪除舊事件並證明沒有不當刪除——這是「合法省略」的早期形式。

### 1.3 Certificate Transparency：RFC 6962 → RFC 9162

來源：https://www.rfc-editor.org/rfc/rfc9162.html

- 雜湊（§2.1.1）：葉 `HASH(0x00‖entry)`，內部節點 `HASH(0x01‖left‖right)`；前綴用於 second-preimage 抵抗。非 2 的冪次時以「小於 n 的最大 2 的冪」切分。
- inclusion proof 驗證（§2.1.3.2）與 consistency proof 驗證（§2.1.4.2）都有逐步演算法，可直接移植。
- 簽什麼：**簽 tree head，不簽每筆**。`TreeHeadDataV2 = {timestamp, tree_size, root_hash, sth_extensions}`，`SignedTreeHeadDataV2 = {log_id, tree_head, signature}`（§4.9–4.10）。即使沒有新提交也要在 MMD 內用新時間戳重簽同一 root（§4.10）——這等同 CloudTrail 的「空 digest」heartbeat。
- 分叉（split view）：RFC 直說稽核「can be circumvented」於向不同客戶端呈現不同視圖的 log，相關機制（gossip）不在範圍內（§1）。客戶端應對已持有的 STH 驗 consistency（§8.1.5）。
- v1→v2 變更（§1.3）：演算法敏捷性（IANA registry）、log ID 改 OID、`TransItem` 取代 `MerkleTreeLeaf`。RFC 9162 未在我讀到的範圍說明 v1 的雜湊有何錯誤（未驗證是否有）。
- CT 的「SCT 是承諾、之後才有 inclusion proof」設計，在 Sigstore 被逐步拿掉（見 1.6）。

### 1.4 Go checksum database 與 transparent log tiles

來源：Russ Cox, https://research.swtch.com/tlog；設計文件 https://go.googlesource.com/proposal/+/master/design/25530-sumdb.md

- tiles：只存每個高度 H tile 的底列，客戶端抓整片 tile，便於快取（建議 H=8）。
- 客戶端演算法：快取最新 `(N, T)`；收到新 log 先驗 consistency、更新快取、再驗 inclusion；失敗要「fail loudly」。
- 實際落地：`go` 指令把最新 tree size 與 hash 存在 `$GOPATH/pkg/sumdb/<name>/latest`，清 module cache 也保留；看到不一致就「complain loudly … and fail the build」（設計文件）。
- **這就是無 gossip 時最小的回滾偵測：驗證者自己記得上次看到的 head。** gossip 只被描述為可選強化（任何 proxy 都可當 gossip 來源），子指令只是佔位。
- `go.dev/ref/mod` 的 sumdb 章節我未讀到原文（頁面截斷），`SECURITY ERROR`、`GONOSUMDB` 細節為記憶，未驗證。

### 1.5 C2SP checkpoint 與 witness

來源：https://github.com/C2SP/C2SP/blob/main/tlog-checkpoint.md、https://github.com/C2SP/C2SP/blob/main/tlog-witness.md

- checkpoint 是 signed note，本文三行：origin、tree size（十進位、無前導零）、root hash（標準 base64）；可選 extension line 但「NOT RECOMMENDED」，因 monitor 無法稽核且並非所有簽章型別都涵蓋它。base64 必須正規，非正規須拒絕。
- 規則：log 或 cosigner「MUST NOT」簽與自己先前簽過者不一致的 checkpoint。
- witness 只存每個 origin 的最新已 cosign checkpoint；`add-checkpoint` 帶舊 size + consistency proof；舊 size 不符回 409 並告知自己的 size；**必須在回應前原子地持久化新 checkpoint**，否則競態可導致回滾。
- 啟示：「單調計數器 + 持久化 + consistency proof」三件組就是 witness 的全部。

### 1.6 Trillian → Tessera、Rekor v1 → v2（最有價值的「改過的地方」）

來源：https://github.com/transparency-dev/tessera、https://blog.sigstore.dev/rekor-v2-ga/、https://github.com/sigstore/protobuf-specs/blob/main/protos/sigstore_bundle.proto

- Tessera：從微服務堆疊（Trillian v1）改為函式庫；流程分「sequencing（分配連續 index，持久化）→ integration（併入樹）→ publishing（簽 checkpoint、收 witness cosign，policy 未滿足就不發布）」。一筆紀錄在有 checkpoint 涵蓋之前不算「已發布」。antispam 去重是可選且昂貴。
- Rekor v2 拿掉的東西：log 不再回傳 signed entry timestamp，時間改由獨立 TSA 提供；移除搜尋索引；entry 類型從十餘種縮到 `hashedrekord` 與 `dsse`；改為 tile 讀取 API。理由是營運成本與複雜度。
- Sigstore bundle：v0.1 允許「inclusion promise」（log 的承諾）代替 inclusion proof；protobuf 註解要求在從未產生 v0.1 的生態中拒絕 v0.1。**教訓：承諾（promise）不如證明（proof）；時間戳與日誌應分離；entry 型別越少越好。**

### 1.7 AWS CloudTrail log file integrity validation

來源：https://docs.aws.amazon.com/awscloudtrail/latest/userguide/cloudtrail-log-file-validation-intro.html、…-digest-file-structure.html、…-custom-validation.html

- 每小時一個 digest file，列出該小時每個 log file 的 `{s3Object, hashValue(SHA-256 of uncompressed), oldest/newestEventTime}`，以及 `previousDigestHashValue` 與 `previousDigestSignature`；以區域專屬 RSA 金鑰簽（SHA256withRSA）。
- 被簽字串：`digestEndTime \n digest S3 path \n hex(sha256(digest content)) \n previousDigestSignature`。注意**路徑也被簽**，且驗證步驟要求檢查檔案是否從原位置取得——防止搬移／替換。
- 截斷與空白：無活動也送「空 digest」（`logFiles: []`），用以斷言「這一小時沒有 log」；停用或重啟會產生「starting digest」，其 previous 欄位為 null；停止 logging 時送最終 digest。**鏈斷點是明確的、有型別的事件，而不是靜默的缺口。**
- 金鑰：每個 digest 帶 `digestPublicKeyFingerprint`；公鑰依時間範圍以 `ListPublicKeys` 取得，可重疊有效期——舊紀錄在輪替後仍可驗。
- 誠實的限制：最新 digest 的簽章放在 S3 metadata，離線驗證時「the most recent digest file cannot be validated」，除非事先另存其簽章。這正是**尾端問題**：鏈頭總是需要鏈外的東西來錨定。

### 1.8 journald Forward Secure Sealing

來源：https://www.man7.org/linux/man-pages/man1/journalctl.1.html、https://lwn.net/Articles/512895/

- `--setup-keys` 產生 sealing key（留在主機、每個 interval 單向演進並刪舊）與 verification key（存外部，可輸出 QR code）；預設 interval 15 分鐘。
- 明說的限制：同一 interval 內的修改可能偵測不到；攻擊者取得機器後擁有當前 sealing key；可以整個刪檔（LWN：可能會被注意到）；舊 key 的安全刪除依賴檔案系統屬性；遺失 verification key 則整個方案失效；時鐘操縱影響「仍是開放問題」。
- 啟示：這是 Schneier–Kelsey 的實作化（對稱、需秘密才能驗證），**不提供第三方可驗證性**。

### 1.9 git 物件模型與簽章

來源：https://git-scm.com/docs/gitformat-signature、https://git-scm.com/docs/hash-function-transition

- commit 以 `gpgsig` header 內嵌簽章；tag 簽章附在訊息後；支援 OpenPGP、X.509、SSH。簽一個 commit 等於承諾其 tree 與所有祖先（content addressing）。
- 改過的地方：SHAttered 後改用 hardened SHA-1，仍決定轉 SHA-256；**被簽 payload 不標明雜湊演算法**，只能靠長度（40 vs 64 hex）區分，文件警告未來同長度雜湊需改格式；新增 `gpgsig-sha256` 讓雙簽並存，舊版 git 把只有 sha256 簽章的 commit 視為未簽。用 `repositoryFormatVersion=1` + `extensions.objectFormat` 讓舊版拒絕讀取而不是誤讀。
- 教訓：**把演算法名稱放進被簽的內容**（`sha256:` 前綴，如 OCI digest）；讓舊驗證器「拒絕」而非「誤判」。

### 1.10 auditd

未讀到描述其完整性機制的一手來源。就記憶而言（未驗證），auditd 本身不提供密碼學完整性，依賴遠端轉送（audisp-remote）與檔案權限。可視為「沒有完整性層」的基準線。

### 1.11 比較：hash chain vs Merkle log

| 能力 | 純 hash chain | Merkle log（RFC 9162 / history tree） |
|---|---|---|
| 偵測中間修改 | 可（需重算到頭） | 可 |
| 偵測尾端截斷 | **不可**（截掉後仍是有效鏈）；需外部已知的 head 或關閉紀錄 | 同樣**不可**單靠自身；但驗證者持有舊 checkpoint 時，consistency proof 可在 O(log n) 證明新 head 是舊 head 的延伸 |
| 證明「某筆在 head 中」 | O(n)：需交出從該筆到 head 的所有紀錄 | O(log n) inclusion proof；**匯出子集時不必交出其他紀錄** |
| 證明兩次匯出一致 | 需第二次匯出包含第一次的全部 | consistency proof，O(log n) |
| 合法省略 | 被省略的紀錄仍需以 hash 形式出現在鏈中（每筆一個 hash） | 只需 inclusion proof；或以葉 hash 列出被保留者 |
| 實作成本 | 極低 | 中等（RFC 9162 兩個演算法約百行；需處理非 2 冪次） |

收斂結論（RFC 9162、Crosby–Wallach、Cox、C2SP 一致）：**簽定期 head，不簽每筆；截斷與回滾只能由「驗證者已持有的較舊 head」或「外部錨定」偵測。** 差異在「誰持有舊 head」：CT／Rekor 用多方 monitor + gossip，Go 用每個客戶端本機快取，witness 用專職第三方，CloudTrail 用帳號擁有者自己的 S3（並建議 MFA Delete），journald／Schneier–Kelsey 用離線 verification key 或可信機器 T。

### 1.12 對本機單使用者紀錄器

- 可轉移：RFC 9162 雜湊與兩個證明演算法；checkpoint 文字格式；「空 heartbeat」與「start/normal-close/abnormal-close」的型別化鏈斷點；CloudTrail「被簽字串含位置與前一個簽章」。
- 不轉移：gossip、多 witness、MMD／SCT、tiles、sharding、antispam——它們解決的是多客戶端、對外服務與規模問題。本系統的 log 與「受害者」是同一個人，沒有多個客戶端可互相比對。
- 必須誠實承認：**同一使用者的程序可以讀到簽章金鑰並重寫整個 store**，此時沒有任何本機結構能偵測，只有「之前已交出去的 checkpoint」或外部時間錨定能限制損害範圍（與 Schneier–Kelsey「只能保護 compromise 之前」相同）。

---

## 2. 外部時間戳與錨定

### 2.1 RFC 3161 TSA

來源：https://www.rfc-editor.org/rfc/rfc3161.html

- 請求只送 `messageImprint`（hash）、可選 `nonce`、`certReq`、`reqPolicy`；TSA 不得檢視 imprint 內容，不得在 token 中放請求者身分。
- `TSTInfo`：`genTime`、可選 `accuracy`、唯一 `serialNumber`、`nonce`、`messageImprint`、`policy`、`ordering`。
- 語意：proof-of-existence——datum 在 genTime 之前存在。
- 安全考量：TSA 金鑰外洩需以 keyCompromise 撤銷，之後該鑰的 token 都不可信；長期有效性需「再時間戳」；建議用 nonce 偵測重放、慢回應可疑。
- 成本：需網路、需信任 TSA 與其 CA；token 可離線驗證（需持有 TSA 憑證鏈）。

### 2.2 OpenTimestamps

來源：https://petertodd.org/2016/opentimestamps-announcement、https://github.com/opentimestamps/opentimestamps-client/blob/master/doc/git-integration.md

- 證明是一串 commitment 操作（append／prepend／sha256），驗證者重放到一個已知存在於某時間的值（Bitcoin block header 的 Merkle root）。
- calendar 每約 1 秒聚合成 Merkle tree，只把 tip 上鏈；剛拿到的是「pending」（指向 calendar），之後 `ots upgrade` 變成完整證明；完整證明自足，不再需要 calendar。
- 信任模型：calendar 最多拒絕服務，不能偽造；但 pending 期間依賴 calendar 不遺失資料（預設用兩個 calendar 緩解）。完整驗證需要 block header（作者建議本機 Bitcoin 節點）。
- 作者明說：時間戳**不證明**真實性或哪個版本是原件；可用來限縮竄改範圍（證明入侵前紀錄未變），但無法為入侵後產生的資料背書。

### 2.3 Roughtime 與 NTS

來源：https://datatracker.ietf.org/doc/draft-ietf-ntp-roughtime/（頁面顯示已成為 RFC 10049，Experimental，2026-10；我未讀 RFC 本文，以 datatracker 為準）、https://www.rfc-editor.org/rfc/rfc8915.html

- Roughtime：客戶端送 32-byte nonce，伺服器以 Ed25519（經委派的短期鑰）簽 `MIDP ± RADI`；Merkle 批次簽 root。多伺服器串接時下一個 nonce = hash(前一回應 ‖ 隨機)，若時間不一致即構成**可轉交第三方的不當行為證明**。不保證時間正確、不保密、無錯誤訊息。
- NTS（RFC 8915）：NTS-KE 走 TLS 1.3，之後以 AEAD + cookie 保護 NTP；伺服器無狀態。關鍵限制：**對稱金鑰，所以封包無法由第三方驗證**；無法抵擋延遲攻擊；TLS 憑證驗證本身需要時間，引導期有雞生蛋問題（建議保存「最後已知良好時間」）。
- 純 NTP 無認證（RFC 8915 引言）。
- 結論：NTS 讓本機時鐘較難被網路攻擊者操縱，但**產生不了可放進匯出的證據**；Roughtime 回應是簽過的、可放進匯出，證明「伺服器在 [MIDP−RADI, MIDP+RADI] 間簽過含此 nonce 的回應」。若 nonce = hash(checkpoint)，就變成一種輕量時間錨定（這是我的推論，Roughtime RFC 未把它定位為時間戳服務）。

### 2.4 Sigstore Timestamp Authority

來源：https://github.com/sigstore/timestamp-authority

- RFC 3161 服務；起因是 Rekor 的時間來自自身時鐘「not externally verifiable」；生產用 KMS，file signer 不建議用於生產。Rekor v2 已完全把時間戳移交 TSA（1.6）。

### 2.5 收斂與轉移

- 收斂：錨定的對象一律是**一個 hash（head/root 或簽章本身）**，不是資料；語意一律是「在 T 之前存在」；驗證者離線所需的是 token 本身 + 信任根（TSA 憑證鏈／Bitcoin header）。
- 頻率：CT 依 MMD、CloudTrail 每小時、journald 每 15 分、OpenTimestamps 每次提交即聚合。
- 氣隙（air-gapped）：沒有任何一個系統能在無網路時產生外部可信時間；RFC 3161 與 OTS 都允許「之後補」——對一個「先前就已存在」的 head 事後取得時間戳，證明的是取得時間戳的時點之前已存在，所以**越早補越有價值**。誠實寫法：離線期間的時間只有本機時鐘。
- 最小版本：每次 seal 匯出時，若有網路，對 checkpoint 的 hash 取一個 RFC 3161 token（或 OTS pending 證明，日後 upgrade 寫回）；token 放進匯出，不放進 log 本身（Rekor v2 的教訓：時間與日誌分離）。離線時在 manifest 寫明 `timeSource: "local-clock"`。

---

## 3. 可驗證的匯出容器

### 3.1 各系統做法

- **TUF**（spec 1.0.37，2026-10-08；https://theupdateframework.github.io/specification/latest/）：targets metadata 對每個 target 列 `length` + `hashes`，且本身被簽；snapshot 列出所有 targets metadata 的版本以防 mix-and-match；timestamp 頻繁重簽以防 freeze；每份 metadata 有遞增 `version` 與 `expires`，客戶端「不得接受比已信任者更低的版本」——這是**以單調版本號偵測回滾**。未知欄位必須納入簽章驗證並在重序列化時保留。
- **OCI descriptor**（https://github.com/opencontainers/image-spec/blob/main/descriptor.md）：`{mediaType, digest, size}` 皆必填；digest 格式 `alg:hex`（演算法名在值裡）；建議先檢查 size 再算 digest；manifest 本身也以 descriptor 被引用，所以只要信任最上層 digest，整棵樹都被綁定。
- **BagIt**（RFC 8493）：`manifest-<alg>.txt` 每個 payload 檔恰好出現一次；`tagmanifest-<alg>.txt` 涵蓋 manifest 與其他 tag 檔；`bagit.txt` 宣告版本；區分 complete（檔案都在）與 valid（checksum 都對）。**明說 manifest 不防主動攻擊、不含簽章**——只是完整性，要另外簽。
- **in-toto Statement v1 + DSSE**（https://github.com/in-toto/attestation/blob/main/spec/v1/statement.md、README.md；https://github.com/secure-systems-lab/dsse/blob/master/protocol.md）：Statement `{_type, subject[{name, digest{alg:hex}}], predicateType, predicate}`；subject 純以 digest 比對。DSSE 信封 `{payload(base64), payloadType, signatures[{keyid, sig}]}`，簽 `PAE = "DSSEv1" SP len(type) SP type SP len(body) SP body`。
- **SLSA provenance v1**（https://slsa.dev/spec/v1.0/provenance）：見 §6。
- **Sigstore bundle**（protobuf-specs）：`mediaType` 帶版本；`verificationMaterial`（公鑰 hint／憑證／tlog entries 含 inclusion proof／RFC 3161 timestamps）；`content` 為 message signature 或 DSSE；DSSE 必須恰好一個簽章；公鑰 hint 必須與信封一致。
- **AFF4**（https://github.com/aff4/Standard/blob/master/inprogress/AFF4StandardSpecification-v1.0a.md）：ZIP64 容器；`information.turtle`（RDF）記錄案件 metadata 與 `aff4:hash`（多演算法）；`version.txt` 記 major/minor。我讀到的部分未見簽章機制。
- **EWF/E01**：一手文件讀取被截斷。就記憶（未驗證）：chunk 級 Adler-32、section CRC、hash section（MD5）與 digest section（MD5+SHA1）、header 含案號／檢驗者；無公鑰簽章。
- **CASE/UCO**（https://caseontology.org/ontology/start.html）：JSON-LD 本體，用例含 chain of custody 與 provenance；只是描述語彙，不提供完整性機制。`InvestigativeAction`、`ProvenanceRecord` 的細節未讀到，未驗證。
- **C2PA 2.2**（https://spec.c2pa.org/specifications/specifications/2.2/specs/C2PA_Specification.html）：claim 以 hashed URI 引用每個 assertion；claim 以確定性 CBOR 編碼並用 COSE_Sign1 簽；hard binding（`c2pa.hash.data` 等）把資產位元組綁進 claim，一個 manifest 只能有一個 hard binding。

### 3.2 四個子問題的收斂答案

(a) **內容清單本身被認證**：TUF targets、OCI manifest、in-toto subject、C2PA claim、CloudTrail digest 都一致——**簽的是清單，不是檔案**；清單每項有長度與帶演算法名的 digest。BagIt 是反例（有清單、無簽章），其 RFC 明說不防主動攻擊。

(b) **附件綁定**：content addressing（digest + size）列在被簽清單中。OCI 建議先驗 size 再算 hash；CloudTrail 另把「位置」簽進去並要求驗證取得位置。

(c) **合法省略 vs 竄改**（C2PA 最完整，§6.8、§15.10.3.1）：
- 遮蔽時，被遮蔽 assertion 的 URI（含 label，因此**被遮蔽的資料類型仍可知**）列入**後續** claim 的 `redacted_assertions`；原 claim 的 hashed URI 仍在。
- 驗證：在遮蔽清單中的 URI 視為有效、不檢查存在；不在清單而無法解析 → `assertion.missing`；hash 不符 → `assertion.hashedURI.mismatch`；標為已遮蔽但內容非全零 → `assertion.notRedacted`；claim 不得遮蔽自己的 assertion → `assertion.selfRedacted`；actions 與 hard binding 不可遮蔽（`assertion.action.redacted`、`assertion.dataHash.redacted`）。
- 對應到 Merkle：Crosby–Wallach 的 Merkle aggregation 與 RFC 9162 的 inclusion proof 讓匯出只帶部分紀錄仍可對 root 驗證；被省略者以葉 hash 或子樹 hash 出現。
- 隱私注意（推論，未找到專門來源）：若省略紀錄的內容可被猜測（例如短指令），裸 `H(0x00‖entry)` 可被暴力確認；對需要遮蔽的欄位應在葉內使用每筆隨機 salt 的承諾。SD-JWT 等 selective disclosure 用 salt 的做法我未讀原文，未驗證。

(d) **版本與未知欄位**：三種立場——
- in-toto：「Consumers MUST ignore unrecognized fields」，因 monotonic 原則；TypeURI 只帶主版本。
- TUF：未知欄位必須包含在簽章驗證中並保留。
- C2PA §5.1：不支援的構造可忽略，或整份標 `manifest.unknownProvenance`；§18.6.1 對已棄用的 bmff hash 直接要求忽略。
- DSSE：`payloadType` 被簽、不支援即拒絕（驗證步驟 4）。git：用 repository format version 讓舊版拒讀。
- 收斂：**主版本放進被簽的型別識別字，未知主版本 fail closed；次版本新增欄位因被簽而已被認證，可忽略但不得用來放寬判定。**

(e) **兩個驗證器一致**：
- Wycheproof（https://github.com/C2SP/wycheproof）：JSON 測試向量 + JSON Schema，針對已知攻擊與規格不一致；已移至 C2SP。
- sigstore-conformance（https://github.com/sigstore/sigstore-conformance）：每個客戶端實作一個 CLI 協定，測試以 asset 參數化（多數新案例不需寫程式），以 `xfail` 列出刻意不支援的功能。
- TUF conformance：未讀到一手來源，未驗證。
- 收斂：**資料驅動的向量 + 預期結果（含錯誤碼） + 薄 CLI 介面**；C2PA 的命名狀態碼讓兩實作可比對「為何失敗」而非只比對 true/false。

### 3.3 對本系統

- 可轉移：DSSE 信封（PAE 很短，可手寫）；TUF/OCI 式清單項 `{path, size, digest, mediaType}`；C2PA 的三態判定與命名狀態碼；sigstore-conformance 的向量目錄結構；CloudTrail 把位置／前一簽章納入被簽字串。
- 不轉移：TUF 的四角色、委派、閾值簽章（沒有多個簽署者、沒有鏡像）；Sigstore 的 Fulcio／OIDC；C2PA 的 JUMBF／資產內嵌；AFF4 的 RDF；EWF 的磁碟映像分段。

---

## 4. 本機簽署者的金鑰管理

### 4.1 儲存

- Secure Enclave：一手頁面未讀到內文（只有標題）。就記憶（未驗證）：僅支援 P-256、私鑰不可匯出、不可匯入、可要求 userPresence／biometry、綁定單一裝置。若要用它，簽章演算法需選 ECDSA P-256 而非 Ed25519。
- TPM：未讀到一手來源，未驗證。
- minisign（https://jedisct1.github.io/minisign/）：私鑰以 scrypt 衍生的密碼加密存檔；這是「無硬體」時的實際基準。
- 對「同使用者本機程序」：OS keychain 或硬體鑰能防止**金鑰被複製走**，但同一使用者的程序通常仍能**要求簽章**（除非每次需要 user presence）。這點各來源未直接處理，屬推論。

### 4.2 輪替與舊紀錄可驗證

- CloudTrail：每個 digest 帶公鑰指紋；公鑰依有效時間窗查詢，可重疊。
- TUF：root N+1 必須同時由 N 的閾值鑰與自己的閾值鑰簽；客戶端逐版走鏈，版本必須恰好 +1。
- signify（https://www.openbsd.org/papers/bsdcan-signify.html）：release N 內含 N+1 的公鑰；新鑰不被另一把鑰簽，而是因為隨已簽的 release 出貨而被信任；**刻意沒有撤銷**（作者認為撤銷「probably a cure worse than the disease」），靠排程輪替限制外洩影響。
- OpenSSH `UpdateHostKeys`（https://man.openbsd.org/ssh_config）：伺服器在已以受信任鑰認證後送出額外 host key，客戶端加入 known_hosts——「用舊信任引入新鑰」。
- OpenTimestamps 的原始動機之一正是：證明簽章在金鑰過期／撤銷前就已存在。
- 收斂：**每份簽章帶 key id；新鑰由舊鑰背書（或隨已簽物發佈）；驗證者保留歷史公鑰集合**。

### 4.3 把公鑰交給驗證者

- DSSE：`keyid` 是未認證提示，「MUST NOT be used for security decisions」。Sigstore bundle 的公鑰 hint 同理，金鑰需帶外取得；憑證鏈則需驗證者「獨立信任的 CA」。
- minisign：key id 8 bytes；公鑰是一行 base64，未規定帶外分發方式。signify：公鑰 56 字元，可電話念出；公開於網站、社群、光碟封面。
- SSH TOFU：`accept-new` 自動加入新 host key，但**拒絕已改變的 key**；`ask`（預設）首次需確認。
- Key Transparency（draft-ietf-keytrans-architecture-11，2026-11）：讓所有人看到同一份 key 視圖、擁有者可監看自己的 label；明說在無第三方／gossip 時分叉可能偵測不到、用戶端狀態遺失會削弱偵測、被分發的用戶端軟體被竄改可擊敗整個協定。
- age（https://github.com/C2SP/C2SP/blob/main/age.md）：只有加密，**沒有寄件者認證**——任何持有 file key 者（含收件者）都能做出有效檔案；所以不能拿 age 當簽章。但其 STREAM 以最後一塊的 nonce 旗標偵測截斷，是「明確結尾標記」的另一例。
- 收斂：**bundle 內的公鑰只證明 bundle 自洽**；信任來自帶外指紋（signify/minisign/SSH）、驗證者已持有的鑰（TOFU accept-new、TUF root）、或公開透明日誌（KT）。

### 4.4 寫得好的威脅模型（可作範本）

- Sigstore（https://docs.sigstore.dev/about/threat-model/）：以問句開頭（「我該信任哪些部分」）；具名角色（Alice/Bob/Charlie/Deborah）；**逐元件「若被攻陷，攻擊者能做什麼」的表格，含組合攻陷列**；明確列出範圍外（storage）與假設（至少一個誠實 monitor）。
- CT（RFC 9162 §1）：直說 split view 可繞過稽核，相關機制不在範圍內。
- journald FSS（LWN）：列出 interval 內窗口、刪檔、舊鑰安全刪除依賴檔案系統、時鐘是開放問題。
- Schneier–Kelsey §1「Limits on Useful Solutions」：三句話界定「能說的只有 compromise 前的紀錄」。
- Key Transparency 架構草案：「不保證什麼」單獨成清單。
- Signal sealed sender（https://signal.org/blog/sealed-sender/）：稱之為「incremental step」，明說時序與 IP 關聯仍是進行中工作。

---

## 5. 為雜湊而做的正規化

來源：DSSE background（https://github.com/secure-systems-lab/dsse/blob/master/background.md）、Latacora（https://www.latacora.com/blog/2019/07/24/how-not-to-sign-json/）、RFC 8785、RFC 8949 §4.2、TUF issue #92（https://github.com/theupdateframework/specification/issues/92）、git hash transition。

- **後悔的案例**：
  - TUF/in-toto 舊信封依賴 canonical JSON；DSSE 背景文件稱之為「unnecessarily large attack surface」，並指出驗證者必須在驗章前先解析 payload。TUF 採用的 OLPC canonical JSON 只跳脫兩個位元組，可能產出標準 JSON 解析器拒絕的輸出（issue #92，2020 年開，至今未在規格中解決）。
  - JWS：DSSE 背景文件稱其實作漏洞史源自規格複雜且不精確（如未檢查 `alg` 與金鑰型別一致）。
  - CBOR：RFC 7049 的「Canonical CBOR」採長度優先排序，RFC 8949 改為純位元組排序並保留長度優先作為相容變體，且刻意不再用「canonical」一詞——長期系統若綁定舊規則就會分歧。
  - git：被簽 payload 不帶雜湊演算法名稱。
- **RFC 8785 JCS** 的坑：數字必須是 IEEE-754 double，以 ECMAScript 演算法輸出；大整數必須包成字串；不做 Unicode 正規化；以 UTF-16 code unit 排序（非 UTF-8 位元組序）；輸入不得有重複鍵。
- **確定性 CBOR**：最短整數／浮點、禁止不定長、鍵依位元組排序；NaN、−0、整數與浮點互換須由協定另訂；重複鍵 well-formed 但 not valid，協定須定義處理。
- **收斂**：DSSE、Latacora、Sigstore bundle 都主張「**簽實際傳輸的位元組，驗章後才解析，且交給應用的就是被驗過的那份位元組**」；DSSE 另外把 `payloadType` 簽進去防型別混淆。若必須重建（例如資料庫中只存欄位），就固定一個自訂、簡單、可逐位元組重現的編碼（CloudTrail 的 `\n` 連接字串、C2SP checkpoint 的三行文字都是此類），避免通用 JSON 正規化。
- 對本系統：每筆紀錄在寫入時就把「被雜湊的位元組」存下來（或以 DSSE 式 length-prefixed 編碼由欄位決定性重建）；永遠不要用 `JSON.stringify(parsed)` 的結果去重算 hash；hash 值一律帶演算法前綴（`sha256:`）。

---

## 6. 寫入者的權限與身分

### 6.1 各系統

- **Sentry DSN**（https://docs.sentry.io/concepts/key-terms/dsn-explainer/）：只能提交事件、不能讀；可公開；每專案一個；可輪替／撤銷；濫用以 IP 封鎖處理。與 auth token 的比較頁面未提及。
- **Kubernetes bound service account token**（https://kubernetes.io/docs/reference/access-authn-authz/service-accounts-admin/）：綁定到 Pod/Secret/Node 物件；物件名稱與 UID 寫入 JWT private claims；物件不存在或 UID 不符就不通過認證。頁面明說 node 資訊**在認證時不被驗證**、只供整合者檢視——一個「哪些宣稱有被檢查」的誠實標示。舊式 Secret token 的問題段落未讀到（截斷），記憶：長效、不綁定，未驗證。
- **GitHub App installation token**（docs.github.com）：1 小時過期；建立時可縮小到特定 repo 與權限子集，且「cannot be granted permissions that the app was not granted」。fine-grained PAT 未讀，未驗證。
- **Macaroons**（Google Research 頁面）：巢狀 HMAC 鏈的 caveat，持有者可衰減權限；第一／第三方 caveat 細節頁面未涵蓋。驗證需 root secret（記憶，未驗證）。
- **Biscuit**（https://doc.biscuitsec.org/getting-started/introduction.html）：公鑰簽、可離線附加 block 衰減權限、Datalog 檢查，「只能限縮、不會增加權限」。
- **SLSA provenance v1**：`externalParameters`（使用者可控，「MUST be verified downstream」）vs `internalParameters`（平台設定）；信任依 `builder.id`。v0.2→v1 改名正是為了「reduce misinterpretation」——把「誰說的」寫進欄位名。
- **in-toto/C2PA**：C2PA 區分 `created_assertions`（歸屬簽署者）與 `gathered_assertions`（簽署者收錄但不背書）——同一份 claim 內區分「我證實的」與「我轉述的」。

### 6.2 收斂

- **身分由憑證決定，由接收端蓋章**（K8s claims 由 apiserver 寫入；GitHub token 權限在發行時決定）；用戶端自述欄位與接收端蓋章欄位分開命名（SLSA external/internal、C2PA created/gathered）。
- 寫入憑證應**只能寫**（Sentry DSN）、**範圍最小**（GitHub）、**可輪替**。
- macaroons/Biscuit 解決的是跨服務委派與離線衰減——本系統只有一個接收端（主程序），不需要。

---

## 7. 不轉移的部分（明說）

- 多方 gossip、witness 網路、monitor、MMD、SCT、tiles、sharding、CDN 快取、antispam：都是為「不可信的公開伺服器服務很多客戶端」設計。本系統的寫入者、儲存者、第一個讀者是同一人，無對等者可比對。
- TUF 多角色與閾值簽章、Fulcio/OIDC 身分、KT 的 label 監控：沒有多個簽署者或身分目錄。
- Schneier–Kelsey／journald 的對稱 MAC 金鑰演進：它們假設驗證者是持有秘密的可信機器；本系統的驗證者是收件的第三方，需要公鑰簽章。不過「金鑰前向演進」的思路可用於「本機 compromise 前的紀錄不可被重簽」——代價是金鑰管理大幅複雜化，建議不採用。
- C2PA 資產內嵌與 JUMBF、AFF4 RDF、EWF 分段：格式負擔遠超所需。

---

## 8. 最小可採用版本（具體）

### 8.1 匯出封印（export seal）

1. 計算 RFC 9162 Merkle root：葉 = `H(0x00 ‖ record_bytes)`，以紀錄序號排序；節點 `H(0x01 ‖ L ‖ R)`。現有 hash chain 保留，作為寫入順序與即時檢查。
2. checkpoint 文字（C2SP 風格）：
   ```
   <origin: 專案 store 的隨機 ID>
   <tree_size>
   <base64 root>
   ```
3. manifest（JSON，但**簽其 exact bytes**）：`{formatVersion, checkpoint, records:[{index, leafHash}] 或 range, attachments:[…], withheld:[…], timeSource, keyFingerprint, previousExport:{checkpoint} | null}`。
4. 以 DSSE 包裝：`payloadType = "application/vnd.<名稱>.export.v1+json"`，簽 `PAE(type, manifest_bytes)`，Ed25519（或為硬體鑰用 P-256）。
5. 驗證順序：先驗章 → 拒絕未知主版本 → 解析 → 逐項驗附件 → 驗 inclusion → 若收件者有上次 checkpoint 則驗 consistency。
6. 共享測試向量：`vectors/<case>/{bundle, expected.json}`，`expected` 為狀態碼列表；兩個驗證實作都跑；不支援的功能以 xfail 列出。

### 8.2 附件綁定

- 每個附件：`{path, mediaType, size, digest: "sha256:<hex>"}` 列在被簽 manifest 中（OCI/TUF）；檔案以 digest 命名存放。
- 驗證：先比 size，再算 digest（OCI 建議）；列出但不在 → `attachment.missing`；在但未列出 → `attachment.undeclared`（C2PA 的 `assertion.undeclared` 類比）；不符 → `attachment.mismatch`。
- 紀錄本身引用附件時，紀錄位元組中就含其 digest，所以附件也經由 Merkle 葉被綁定。

### 8.3 截斷／回滾偵測

無網路：
- 型別化的鏈事件：`store.start`（previous=null，CloudTrail starting digest）、`session.close.normal`、`session.close.abnormal`（下次啟動時偵測到未正常關閉就寫一筆，Schneier–Kelsey）、固定間隔 `heartbeat`（即使無活動，CT 重簽／CloudTrail 空 digest）。尾端缺 close 且最後 heartbeat 很舊 → 標示為「可能截斷」，而不是靜默通過。
- 每份匯出含 `previousExport.checkpoint`；**收件者保存其收過的最新 checkpoint**（Go sumdb 的 `latest` 檔），下次要求 consistency proof；不一致 → 失敗。這是唯一真正能對抗同使用者重寫的離線機制，因為舊 checkpoint 已在對方手中。
- 本機另存「最後 checkpoint」於 store 以外的位置（例如 OS keychain 項目）只能偵測意外或粗糙的回滾，對同使用者惡意程序無效——要在威脅模型寫明。

有網路：
- 每次匯出（以及可選的每 N 分鐘）對 checkpoint hash 取 RFC 3161 token 或 OpenTimestamps 證明；OTS pending 可之後 upgrade 並以新紀錄寫回。時間證明放在匯出／旁檔，不放進紀錄雜湊範圍（Rekor v2：時間與日誌分離）。
- 可選：以 checkpoint hash 作 Roughtime nonce，保存簽過的回應（推論用法，非 Roughtime 原定用途）。

### 8.4 威脅模型大綱（依 Sigstore／KT／journald 的寫法）

1. 問句式導言：這份紀錄能讓第三方相信什麼？不能相信什麼？
2. 角色：操作者（寫入者兼簽署者）、收件第三方（驗證者）、本機同使用者程序、本機其他使用者、取得硬碟者、網路攻擊者（僅限時間錨定與更新）。
3. 資產：紀錄位元組、附件、簽章私鑰、已交出的 checkpoint、ingest token。
4. 假設：OS 帳號未被他人控制；收件者以帶外方式核對過公鑰指紋；雜湊與簽章演算法未被攻破。
5. 逐元件攻陷表（含組合）：簽章鑰外洩 → 可偽造任何未來與**未曾交出過**的歷史；store 被同使用者改寫 → 本機偵測不到，僅能由收件者手上的舊 checkpoint 與外部時間戳偵測；ingest token 外洩 → 可以該 producer 名義注入紀錄，但無法冒充其他 producer、無法修改既有紀錄；本機時鐘被改 → 時間戳不可信，除非有外部 token。
6. 明確不保證：紀錄內容的真實性（只保證未被事後修改）；compromise 之後的紀錄（Schneier–Kelsey）；離線期間的時間；完整性 ≠ 完整性之外的「沒漏記」。
7. 已知限制與未來工作（Signal 式的「incremental step」寫法）。

### 8.5 每個 producer 的 write-only 憑證與蓋章

- 主程序為每個 producer（shell hook、proxy、agent tailer、截圖器）在每個專案產生一個隨機 token，只授權「追加到此專案的此類紀錄」（Sentry DSN）；不可讀、不可刪；可輪替。
- 主程序收到寫入時，依 token 查出並**蓋章** `producer: {id, kind, tokenGeneration}` 與 `receivedAt`（主程序時鐘）；用戶端自述（hostname、pid、自報時間）全部放在 `claimed.*`（SLSA external vs internal；C2PA created vs gathered；K8s 對未驗證 claim 的標示）。
- UI 與匯出只把蓋章欄位當身分；`claimed.*` 顯示為「producer 自述」。
- 限制要寫進威脅模型：同使用者程序可讀到 token 檔，故 token 防的是**誤歸屬與越權（例如 tailer 寫成 proxy 紀錄）**，不是防惡意本機程序。

---

## 9. 未能驗證的事項

- RFC 9162 §11.3 misbehaving logs 與 §8.3 之後內容（頁面截斷）；RFC 6962 v1 雜湊是否有被認為錯誤的地方。
- `go.dev/ref/mod` 的 sumdb 章節（`SECURITY ERROR`、`GONOSUMDB`、`GOPRIVATE`、key 格式）——只讀到設計文件，其餘為記憶。
- Roughtime 正式 RFC 10049 本文：僅讀 datatracker 頁面摘要。
- EWF/E01 的 Adler-32、MD5／SHA1 section 細節（文件截斷）；AFF4 是否有簽章機制（讀到的部分未見）。
- CASE/UCO 的 `InvestigativeAction`、`ProvenanceRecord`、Hash facet 細節。
- Apple Secure Enclave 頁面內文未讀到；P-256-only、不可匯出等為記憶。TPM 未查。
- Macaroons 的第一／第三方 caveat 與 root secret 驗證細節；Biscuit 的第三方 block 與 revocation id。
- Kubernetes 舊式 Secret token 的問題段落（截斷）；GitHub fine-grained PAT。
- TUF conformance 測試套件；Wycheproof 向量的 `valid/invalid/acceptable` 結構細節。
- auditd 的完整性機制（推定沒有，未查一手）。
- 以加 salt 的葉承諾防止被省略紀錄被暴力猜測、以 checkpoint 作 Roughtime nonce——兩者是我的推論，沒有一手來源採用此確切做法。
- 同使用者程序能否在 keychain／Secure Enclave 不需互動下要求簽章——推論，未找到來源直接說明。
