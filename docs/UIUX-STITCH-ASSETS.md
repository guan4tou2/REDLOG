# Stitch 設計資產索引

更新日期：2026-11-06（Asia/Taipei）。本表固定內容版本，不代表功能驗收或已發布。

資產目前位於工作區的 `design-reference/`，相對 implementation repo 為 `../design-reference/`；它們不在本 repo 的版本控制內。下列路徑是本機定位資訊，不建立會在 GitHub 失效的連結。跨機交付須同時提供檔案並核對 hash。

整合規則與狀態見 [UIUX-STITCH-DESIGN.md](UIUX-STITCH-DESIGN.md)。原稿只供視覺參考；React 復刻是停用真實寫入的測試快照。

| 資產（相對工作區） | 用途 | SHA-256 |
|---|---|---|
| `design-reference/stitch-originals/activity-2026-11-06.html` | Stitch 原稿；非功能驗收 | `c1aa1d969f640d0bdad262fdd7fd925c00d740541ceefacfd5eb3137e304c8d0` |
| `design-reference/stitch-originals/project-startup-2026-11-06.html` | Stitch 原稿；非功能驗收 | `8a21dd6b533421482d6b8ea2a5f3df583782db7350025674e69148964d9ca15c` |
| `design-reference/stitch-originals/settings-2026-11-06.html` | Stitch 原稿；非功能驗收 | `41183f38396d337d036516a98b0cb8c0cfdbd0ffcb832c9ca47dabf6165bad3d` |
| `design-reference/stitch-originals/transcript-2026-11-06.html` | Stitch 原稿；非功能驗收 | `26886bfd88c8dec1889c4b311f879ec4a2d03d8b151e4915258aafa7058f6ef0` |
| `design-reference/redlog-activity-visual-baseline.html` | 原始視覺基準 | `64f45bfb313125ba11a26c6d53c80959fda416125c283b882c7d429bd1e3061d` |
| `design-reference/redlog-activity.html` | 示例互動原型 | `08209405f7f59951726a0b7823b3dd0029dd8ae0a16aa83c738d829d1312043a` |
| `design-reference/redlog-plugins.html` | React 離線快照 | `ae85048fefaf8d487bb185023438564d83923483fe5fad05a73463dd81528b29` |
| `design-reference/redlog-settings.html` | React 離線快照 | `e4b7e5d733243660829088b0d746c1d55a1fa15c4d5057eae7cb6af289a23ed9` |
| `design-reference/redlog-startup.html` | React 離線快照 | `583855be0facb13b7f4b0cbad74bab840adb7857d56d285130636572caa9c8ae` |
| `design-reference/redlog-transcript.html` | React 離線快照 | `39363070cb141b79dc76a68c57c3f1419c524a0a033d0453b842f30f0f878016` |

## 文件輸入與重建

- 使用者設計草稿 `UIUX-STITCH-DESIGN.md` 的輸入 SHA-256：`fbd7dd3d575803a40b2ba8f56215250dcbf1824fea0596a82cac9378c6cf22f2`。整合文件經核對重整，並非原稿逐字複製。
- 活動原型樣式同步：`design-reference/sync-theme.cjs`；重用正式 tokens／字型。
- React 快照重建：先 build 並跑相應 Electron 測試，再執行 `design-reference/build-react-replicas.cjs`。腳本依賴設定、專案啟動、Transcript、插件的測試快照。
- 導航與版面檢查：`design-reference/visual-check.cjs`、`check-react-replicas.cjs`、`activity-extension-regression.cjs`。需要能啟動 Chrome。
- 本表沒有收錄的儀表板、HTTP、目標、證據、終端或其他精修稿，應標為缺少具名資產，不憑討論中的檔名猜測內容。
- 重新產生 HTML 會改變 hash；更新資產時一併更新本表及適用的驗收紀錄。
