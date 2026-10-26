# Data model / ownership

無 schema migration。Event／Evidence 保持現有來源、tier、hash。Activity、query coverage、ContentRef／Anchor、Export selection 為 C1–C5 的投影／參照，不取代原件。

Terminal origin 是本機觀測：App ID、程序／出生識別、祖先鏈及驗證狀態；環境提示不升級為 verified。錄製 binding／generation 沿 C6，project 不隨 UI 前景改歸。任何快取不得因 policy 改變而繼續收取被拒內容。

新增欄位／IPC 只在實際使用處增加；canonical 型別與實作同步，unknown／failed 不用空成功值代替。
