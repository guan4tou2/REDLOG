# Verification

狀態：局部驗證；Spec 061 維持 Draft，完整任務未結。

## 2026-10-30：Mac 手動替換與證據延續

[自動化案例](../../e2e/mac-manual-upgrade.spec.ts) 使用隔離 HOME、實際官方舊版 App 與 DMG 安裝副本，沒有修改日常專案或 `/Applications`。

- 起點：官方 v0.18.3 Apple Silicon DMG，下載 asset digest 與本機 SHA-256 一致：`291cac760196234fd57c8678828d7de32efb2c9e4ca7e49f6b6b198b1873f30c`。
- 終點：v0.18.4，`9e648f7d+local` 加未提交修正；DMG SHA-256 `85608c424ef6a98dc0fe1a140847a36a9adf973bc6bd420a76412a69391c72bc`，app.asar SHA-256 `1d91d43edc420b2c3c4495bd959e1e4beb9b2c799d8e1e844896b836cd720e9c`。完整來源綁定見 [063 verification](../063-long-recording-segments/verification.md)。
- 舊版建立專案、透過真實 managed proxy 保存 HTTP；關閉 App 後將舊 App 留作 `.previous`，以候選替換。
- 新版以同一 HOME 開啟，實際 `app.getVersion()` 從 0.18.3 變成 0.18.4，原 HTTP Event IDs 全部可讀；再啟動 proxy 並保存新的 HTTP response。
- 此案包含在最終安裝副本驗收：合計 5 PASS／0 SKIP／0 FAIL，25.6 秒；同 report validator 通過。完整 unit suite 4,480 PASS／31 SKIP／0 FAIL，包含既有 update-flow／status／anchor／marker／prefs 回歸。

這是 T030–T032 的 Mac 手動替換子案例與更新前後證據延續，不表示 Windows 自動更新、Linux 套件更新、候選下載／稍後／取消、原生退出確認、錨定故障重試或所有 live sources 已實測。E2E 的退出不代替操作者 quit confirmation。T001–T032 的完整 checkbox、Spec 062 T012／T013 與跨平台 gate 保留；未發布新版。
