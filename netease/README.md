# netease

網易雲音樂音源，可匿名使用，也可用 QR 碼登入。行為以 FMP 舊專案的 `lib/data/sources/netease_source.dart` 為規格，用宿主 API v1 重寫；不需要 VIP 的歌可播。

## 能力

- `search`：`POST music.163.com/api/cloudsearch/pc`（明文 form），每頁 20 筆。舊專案收了 `order` 卻沒用，這裡不帶。封面是方形，給 120、200、400 三個檔位（`?param=NyN`，舊專案 `thumbnail_url_utils` 的做法）。
- `resolveStream`：`POST interface3.music.163.com/eapi/song/enhance/player/url/v1`，body 是 eapi 加密的 `params`。
  - 加密：`/api/song/enhance/player/url/v1`、JSON、`md5("nobody" + 路徑 + "use" + JSON + "md5forencrypt")` 以 `-36cd479b6b5-` 相接，AES-128-ECB（PKCS7），大寫 hex。AES 是 `src/aes.js`（自己寫的 FIPS 197 實作，只做加密，`test/aes.test.js` 與 `node:crypto` 逐位元組比對），MD5 用宿主的 `fmp.crypto.md5`。
  - 音質：`high` → `exhigh`；`medium`、`low` → `standard`。不送 `lossless`（VIP 音質）。一個請求只回一個串流，所以只有一個候選。
  - 回應的 `type`（`mp3`、`flac`、`m4a`）對應宿主的容器與編碼（`mp3/mp3`、`flac/flac`、`mp4/aac`），不在 `formats` 裡就 `NotFound`。
  - 回應的 `freeTrialInfo` 不為空（只有試聽片段）時回 `previewOnly: true`，由宿主依「跳過試聽片段」處理。
  - 網易回 `http://` 的串流網址，插件改成 `https://` 才交給宿主（CDN 兩者都接受；2026-10-08 在 Android 與 Windows 實機播放 `m701`、`m801` 的 https 網址都正常）。
  - `expiresAt` 是收到回應的時間加上 API 回報的有效秒數 `expi`（約 1200 秒）：網址本身沒有期限參數，所以 `checks.json` 沒有 `expiresAtPattern`。
  - 候選的 header 只有 `Origin`、`Referer`、`User-Agent`，不帶 Cookie。

- `login`：QR 碼登入，見下方〈登入〉。

## 登入（QR）

manifest 宣告 `login: { methods: ['qr'] }`（網易的 `MUSIC_U` 有效期長，沒有刷新）。

1. `loginQrStart`：`POST music.163.com/weapi/login/qrcode/unikey`，回應的 `unikey` 是 token，QR 碼內容是 `https://music.163.com/login?codekey=<unikey>`。
2. `loginQrPoll(token)`：`POST music.163.com/weapi/login/qrcode/client/login`，狀態在頂層 `code`：`801` 等待、`802` 已掃描、`800` 過期、`803` 成功。成功時 `MUSIC_U`、`__csrf` 取自回應的 `Set-Cookie`；沒有 `MUSIC_U` 時退到 body 的 `cookie` 字串。
3. `loginVerify(credentials)`：`GET music.163.com/api/nuser/account/get`（HTTP 不是 200 時改打 `POST /api/w/nuser/account/get`，舊專案的做法），自己用傳入的憑證組 `Cookie`（`MUSIC_U`、`__csrf`，加 `os=pc`、`deviceId=fmp`），請求標 `auth: 'never'`。

- 存的 cookie（只看名稱）：`MUSIC_U`、`__csrf`（沒有就不放）。沒有 `extra`。
- 用到的網域：只有 `music.163.com`，不需要新增。
- QR 兩個請求都是 weapi：JSON 經雙層 AES-128-CBC（固定金鑰、隨機 16 字元金鑰）加 RSA（無 padding）封裝隨機金鑰，`params`、`encSecKey` 以 form 送出；每次輪詢重新加密。程式在 `src/weapi.js`，AES-CBC 與 base64 在 `src/aes.js`，RSA 用 `BigInt`。隨機金鑰用 `Math.random`：它只保護公開 QR 流程的請求內容，不是憑證。
- QR 兩個請求固定帶舊專案的匿名 `Cookie`（`os=pc; osver=…; appver=2.7.1.198277; channel=netease; __csrf=; MUSIC_U=`，`MUSIC_U`、`__csrf` 是空的），不帶 `X-Real-IP`。
- `search`、`resolveStream` 的請求標 `auth: 'userPreference'`：使用者開著「以登入身分瀏覽與播放」時宿主才帶憑證（ADR 0012）；`os=pc`、`deviceId=fmp` 還沒有加進這兩個請求。
- `803` 卻沒有 `MUSIC_U` 時回 `ParseError`（舊專案當成過期）；不認得的 `code` 照下方錯誤對應（`UnexpectedError`），不當成「還在等」。
- `loginVerify`：頂層 `code` 301、或 200 卻沒有 `profile`、或沒有 `MUSIC_U` → `CredentialInvalid`；其他照下方錯誤對應。
- 輪詢逾時、連續錯誤幾次放棄，都是宿主端的事。

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

接著在 App 實機播放時，兩首歌（`5257138`、`400876427`）都拿不到網址。以 `400876427` 再各發一次取流比對：

| 請求 | 結果 |
|---|---|
| 取流，不帶 header | 200，`data[0].code` 404、`fee` 0、`flag` 257，沒有網址 |
| 取流，帶 `X-Real-IP: 118.88.88.88` | 200，`data[0].code` 200，有網址，320 kbps mp3 |

所以插件**只在取流的請求**送 `X-Real-IP`（網路出口在大陸以外時，有地區限制的歌要靠它）；搜尋不送（`test/resolve.test.js`、`test/search.test.js` 守）。

## 已知限制

- 不登入時 VIP 歌與匿名拿不到網址的歌播不了。匿名時 VIP 歌（`fee` 1）連試聽片段都沒有（`code` -110、沒有 `freeTrialInfo`），`previewOnly` 只會在登入後出現（登入後的取流行為還沒有實測），由 `test/resolve.test.js` 以手寫回應守。
- 一個 `checks.json` 每個能力只有一條案例，所以契約測試只重播成功的 `search`、`resolveStream` 與（手寫 fixture 的）`login`；上表的錯誤對應由 `test/errors.test.js` 以網易實際給的欄位守（`npm test`）。
- fixture 裡的 `NMTID` 等 Cookie 值已被 FMP 的遮蔽名單遮掉；錄製者的 IP 由錄製器換成文件用位址。

## 打包

```sh
cd netease
npm ci
node build.mjs   # 輸出 netease.js（不壓縮，內容固定）
npm test         # 錯誤對應表、AES／weapi、登入流程、取流與搜尋請求的測試（node:test）
```

用 esbuild 把 `src/` 打成單一檔，`netease.js` 與原始碼、`package-lock.json` 一起提交；index 只認這一個 `.js`。`manifest` 寫在 `build.mjs`。

## 契約測試與錄製

指令見 repo 根目錄的 `README.md`。錄製會真的連網易：搜尋與取流各 1 個請求，共 2 個。`login` 的案例標 `requiresLogin`，命令列錄製略過；它的 fixture（`fixtures/login/001.json`）是手寫的（`meta.edited`），憑證與帳號都是假的，body 的形狀照 account/get 的真實回應。

## 測試向量

`test/weapi.test.js` 的向量是現算的：AES-CBC 用 `node:crypto` 的 `createCipheriv`，RSA 用 `publicEncrypt`（`RSA_NO_PADDING`，公鑰由寫死的模數與 65537 組成），base64 用 `Buffer`，另有 NIST SP 800-38A F.2.1 的 CBC 向量；固定隨機金鑰的 `weapiEncrypt` 輸出必須等於 `node:crypto` 的組合，且能反向解回原 JSON。
