# fmp-plugins

[FMP](https://github.com/1morr/FMP) 的官方音源插件。**開發中**：FMP 正在重寫（見 FMP 的 `docs/adr/`），插件格式與宿主 API 在重寫完成前仍可能變動。

## 結構

每個插件一個頂層目錄；目錄裡有 `<插件>/<插件>.js` 才算插件。

- `<插件>.js`：安裝檔。開頭的 `/* ==FMP Plugin== … ==/FMP Plugin== */` 是 JSON manifest，其餘是腳本（FMP ADR 0014）。manifest 的 `id` 必須等於目錄名。
- `checks.json`：每個能力一條檢查案例。
- `fixtures/`：錄下的 HTTP 請求與回應，已遮蔽憑證，供契約測試重播。
- `package.json`（選用）：插件有自己的單元測試或建置步驟時才有。

欄位與宿主 API 的型別見 FMP 的 `app/lib/plugins/types/fmp-plugin.d.ts`。

## index.json

`index.json` 是 FMP 插件頁讀的清單（FMP ADR 0030），經 `raw.githubusercontent.com` 從 `main` 讀取：每個插件的 manifest 摘要、`.js` 與 `checks.json` 的網址和 SHA-256。**不要手改**，由腳本產生：

```sh
dart pub get
dart run tool/build_index.dart          # 寫 index.json
dart run tool/build_index.dart --check  # 不是最新就失敗（CI 跑這個）
dart test                               # 腳本本身的單元測試
```

改了任何插件的 `.js` 或 `checks.json` 都要重產 `index.json` 並一起提交。

## 版本

semver。`.js` 一有改動，manifest 的 `version` 就要比 `main` 上的高（CI 在 PR 檢查）；新插件不受限。只改 `checks.json`、fixture 或文件不用升版。

## 新增插件

1. 建 `<id>/<id>.js`，標頭 manifest 的 `id` 等於目錄名，版本從 `1.0.0` 起；寫一句 `description`（≤ 200 字元），插件頁與 index 會顯示。
2. 加 `checks.json`，錄 fixture（真實連線、只限不需要登入的案例）。
3. `dart run tool/build_index.dart`，提交 `index.json`。
4. 開 PR。CI 自動發現新目錄，不用改 workflow。

## CI

`.github/workflows/ci.yml`，在 push 到 `main` 與 PR 上跑：

- `index`：`dart analyze`、`dart test`（含 `requiresLogin` 案例的 fixture 都標了 `meta.edited`）、`build_index.dart --check`。
- `npm`：有 `package.json` 的插件目錄跑 `npm ci && npm test`。
- `contract`：每個插件目錄各一個 job，以 workflow 裡 `FMP_REF`（FMP 的完整 commit SHA）checkout FMP 重播契約，不連網。FMP 的宿主 API 變了，就開 PR 改 `FMP_REF`。
- `version`：PR 裡 `.js` 改了而版本沒升就失敗。

冒煙測試（`--live`）會連網，不進 CI。

## 契約測試

契約執行器在 FMP 裡。checkout FMP 後，在它的 `app/` 目錄執行：

```sh
FMP_PLUGIN_DIR=<本 repo 的絕對路徑>/bilibili flutter test test/plugins/contract/contract_test.dart
```

重播不連網。錄製（真實連線、只限不需要登入的案例）另加 `--run-skipped --tags live` 並改跑 `test/plugins/contract/record_test.dart`，詳見 FMP 的 `app/AGENTS.md`。

`checks.json` 標了 `requiresLogin` 的案例（目前是各插件的 `login`），fixture 一律經人工處理，並在 `meta.edited` 寫明怎麼處理的：手寫（假帳號、照真實回應的形狀），或在 FMP 的插件開發工具錄製後，刪減到只剩插件讀的欄位。登入後的真實回應帶著遮蔽閘門認不得的帳號資訊（email、手機號、等級、地區之類），不原樣提交。閘門：`test/login_fixtures_test.dart`。

## 宿主的依賴

FMP 有幾處程式碼照著插件的輸出寫死，兩個 repo 之間沒有自動的一致性檢查。改到下面這些輸出時，同時到 FMP 改對應的程式碼與測試：

- **`playlistFromUrl` 認得的網址與回傳的遠端 id**（bilibili、youtube、netease）：FMP 匯入舊版資料時不連網，以 `app/lib/legacy_import/remote_playlist_url.dart` 照抄各插件的判斷，把舊版平台歌單的網址換成（插件 id, 遠端 id）。插件改了接受的網址形式或遠端 id 的格式，匯入的歌單就對不上之後的刷新。對照的插件版本寫在 FMP 的 `app/test/legacy_import/remote_playlist_url_test.dart`。
- **bilibili 單 P 影片的曲目不帶 `cid`**（只有 `sourceId`；分 P 才帶 `cid`、`partIndex`、`parentTitle`）：舊版替每首 B 站曲目補了 `cid`，FMP 匯入時對單 P 影片把它去掉，鍵才與插件一致（FMP `app/lib/legacy_import/legacy_track_catalog.dart`）。插件改成單 P 也帶 `cid` 的話，匯入的曲目在第一次完整刷新時會被刪掉再重加。
- **qqmusic、netease 曲目的 `sourceId` 格式**（qqmusic 的歌曲 `mid`、netease 的數字 id）：FMP 只把格式相同的舊版外部匯入來源寫成配對紀錄。

## 授權

MIT，見 `LICENSE`。
