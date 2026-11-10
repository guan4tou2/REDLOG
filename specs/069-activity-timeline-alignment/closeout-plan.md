# macOS workflow and architecture closeout

基準：main `3dd84052`。維持已確認的 Stitch 外觀、單欄閱讀、獨立 Timeline 與既有資料保存契約。

## 本批交付

- [x] 整合 #662 的現況／驗收文件及 #663 的測試收斂；保留完整 CI，不以快速選取取代門檻。
- [x] #591：由核心內容描述導出有內容、空內容、未擷取、無法讀取與截斷；各 Reader 共用判斷，缺檔不說未擷取，空 stderr 不新增區塊。
- [ ] #589／#590／#593：補齊非預設來源／Session／Find／閱讀位置的往返、來源故障恢復與 macOS 安裝候選流程；紀錄 fixture、實際來源與原生人工驗收的界線。
- [x] #661 Timeline：資料分頁與增量、選取與 Reader／返回、viewport 分責任抽離；保留過期回應與跨專案防護。
- [x] #661 export：有界讀取／核准重檢與串流交付；Bundle／HAR 重工作移出 UI 主程序，保留 snapshot、遮蔽、附件、取消／專案切換與證據一致性。
- [x] #661 source contract：沿用既有 core／adapter／Reader，統一服務、連線、保存、完整性與讀取的狀態，不建立第二套儲存或開放任意第三方 UI。
- [ ] 跑依序 gates、完整單元、受影響 Electron 與 macOS 安裝驗證；更新實際證據、commit 與 push 獨立分支。

## 不得誤標的驗收

#660 原 Windows 約 200k 事件／Defender／相同硬體的完整效能重測、原生 Windows／WSL 人工操作、真實使用者無人協助成功率，不能由 macOS 或合成資料替代。需要互動式帳號、原設備或人工操作的格子維持 NOT RUN，保留對應工單。

本輪授權包含完成與 push；直接合併 main 曾被自動審核拒絕。完成可審查 PR 後另取得合併授權。

執行證據與六條流程對照見 [本批紀錄](../../docs/records/2026-11-10/MACOS-WORKFLOW-CLOSEOUT.md)；保留原生人工／原 Windows 的 NOT RUN。
