# netease

網易雲音樂音源，匿名使用（不登入）。行為以 FMP 舊專案的 `lib/data/sources/netease_source.dart` 為規格，用宿主 API v1 重寫；不需要 VIP 的歌可播。

## 能力

- `search`：`POST music.163.com/api/cloudsearch/pc`（明文 form），每頁 20 筆。舊專案收了 `order` 卻沒用，這裡不帶。封面是方形，給 120、200、400 三個檔位（`?param=NyN`，舊專案 `thumbnail_url_utils` 的做法）。
- `resolveStream`：`POST interface3.music.163.com/eapi/song/enhance/player/url/v1`，body 是 eapi 加密的 `params`。
  - 加密：`/api/song/enhance/player/url/v1`、JSON、`md5("nobody" + 路徑 + "use" + JSON + "md5forencrypt")` 以 `-36cd479b6b5-` 相接，AES-128-ECB（PKCS7），大寫 hex。AES 是 `src/aes.js`（自己寫的 FIPS 197 實作，只做加密，`test/aes.test.js` 與 `node:crypto` 逐位元組比對），MD5 用宿主的 `fmp.crypto.md5`。
  - 音質：`high` → `exhigh`；`medium`、`low` → `standard`。不送 `lossless`（VIP 音質）。一個請求只回一個串流，所以只有一個候選。
  - 回應的 `type`（`mp3`、`flac`、`m4a`）對應宿主的容器與編碼（`mp3/mp3`、`flac/flac`、`mp4/aac`），不在 `formats` 裡就 `NotFound`。
  - 回應的 `freeTrialInfo` 不為空（只有試聽片段）時回 `previewOnly: true`，由宿主依「跳過試聽片段」處理。
  - 網易回 `http://` 的串流網址，插件改成 `https://` 才交給宿主（CDN 兩者都接受；實機播放要確認）。
  - `expiresAt` 是收到回應的時間加上 API 回報的有效秒數 `expi`（約 1200 秒）：網址本身沒有期限參數，所以 `checks.json` 沒有 `expiresAtPattern`。
  - 候選的 header 只有 `Origin`、`Referer`、`User-Agent`，不帶 Cookie。

## 錯誤對應

| 條件 | FMP 錯誤 |
|---|---|
| HTTP 460、462，或回應的 `code` 為 `-460` | `VerificationRequired` |
| HTTP 5xx | `NetworkError` |
| 回應的 `code` 為 301，或串流項目的 `code` 為 301 | `AuthRequired` |
| 串流項目沒有網址，`fee` 為 1 或 4（VIP、數位專輯） | `Unavailable`（`membership`） |
| 串流項目沒有網址，`code` 為 `-110` 或 `flag & 256`（版權、地區） | `Unavailable`（`copyright`） |
| 串流項目沒有網址，`code` 為 404 且 `fee` 為 0 | `AuthRequired`（匿名請求；登入後可播，舊專案 #87） |
| 串流項目沒有網址，其他 | `NotFound` |
| 其他非 200 的 HTTP 與回應 `code` | `UnexpectedError` |
| 不是 JSON、不是物件 | `ParseError` |

判斷只看 `fee`、`code`、`flag`，不比對訊息文字。`flag & 4` 不是 VIP 標記。HTTP 429 與傳輸錯誤由 FMP 的網路層轉成 `RateLimited`、`NetworkError`。地區限制沒有獨立的欄位，與版權一起歸 `copyright`。

查詢用的 POST（搜尋、取流）都標 `idempotent: true`，暫時失敗時由網路層重試（FMP ADR 0028）。

## `X-Real-IP`

舊專案對部分請求帶 `X-Real-IP: 118.88.88.88`（讓海外 IP 看起來在大陸）。2026-10-08 以匿名真實連線各測一次，**不帶 header**：

| 請求 | 結果 |
|---|---|
| `POST music.163.com/api/cloudsearch/pc`（搜尋「周杰伦」） | 200，`code` 200，有結果 |
| `POST interface3.music.163.com/eapi/song/enhance/player/url/v1`（歌曲 139774，`exhigh`） | 200，`code` 200，有網址，320 kbps mp3 |

兩個都成功，所以插件**不送** `X-Real-IP`。測的網路出口在大陸以外；若之後某地區的取流被地區限制擋下，再只在取流的請求加這個 header，並更新這一節。

## 已知限制

- 沒有登入：VIP 歌與匿名拿不到網址的歌播不了。
- 一個 `checks.json` 每個能力只有一條案例，所以契約測試只重播成功的 `search` 與 `resolveStream`；上表的錯誤對應由 `test/errors.test.js` 以網易實際給的欄位守（`npm test`）。
- fixture 裡的 `NMTID` 等 Cookie 值已被 FMP 的遮蔽名單遮掉；錄製者的 IP 由錄製器換成文件用位址。

## 打包

```sh
cd netease
npm ci
node build.mjs   # 輸出 netease.js（不壓縮，內容固定）
npm test         # 錯誤對應表與 AES 的測試（node:test）
```

用 esbuild 把 `src/` 打成單一檔，`netease.js` 與原始碼、`package-lock.json` 一起提交；index 只認這一個 `.js`。`manifest` 寫在 `build.mjs`。

## 契約測試與錄製

指令見 repo 根目錄的 `README.md`。錄製會真的連網易：搜尋與取流各 1 個請求，共 2 個。
