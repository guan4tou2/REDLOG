# Windows：從原始碼開發

只想安裝使用，請看 [Windows 安裝指南](windows-setup.md)。以下是開發與本機打包的工具，不是安裝包執行需求。

## 環境

使用專案 lockfile 與 CI 的 Node.js 22。原生模組重新編譯另需 Python 3 與 Visual Studio Build Tools 的「Desktop development with C++」工作負載。

## 開發

```powershell
npm install
npm run rebuild
npm run dev
```

`better-sqlite3` 必須符合目前執行環境的 ABI。單元測試會透過 pretest 還原 Node binding；啟動 Electron 前使用專案 rebuild 流程，不把 ABI 錯誤當作產品缺陷。

## 本機安裝包

```powershell
npm run build
npx electron-builder --win nsis --publish never
```

輸出是 NSIS 安裝包，不發布 portable。code-sign 工具的符號連結若受限制，依 Windows 提示處理權限；不為執行一般安裝包要求開發者模式。

## 驗證

推送前依 CLAUDE.md 執行五道 gate。WSL 的客體接入、PowerShell 5.1／7 與安裝後讀回必須分開記錄，不以主機或單元測試通過代替人工平台驗收。
