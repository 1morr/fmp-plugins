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
- `trackDetail`：歌曲詳細，`POST music.163.com/api/v3/song/detail`（明文 form，`c=[{"id":<sourceId>}]`，舊專案 `_getSongDetail` 同一個端點），**一個請求**；與 `search` 一樣標 `auth: 'userPreference'`、`idempotent: true`，不帶 `X-Real-IP`，錯誤對應同上。
  - 只給回應真的有的欄位：`album`（`songs[0].al.name`，沒有時讀 `album.name`，去頭尾空白，空的不給）、`publishedAt`（`songs[0].publishTime`，已是 epoch 毫秒；多數歌是 `0`，`0`、負數或缺就不給）。
  - **沒有** `description`、`stats`、`uploaderAvatar`：這個端點沒有簡介與統計，`ar[]` 也沒有歌手頭像。舊專案的歌手頭像（`api/artist/head/info/get`）、專輯發行日（`api/v1/album/<id>`，歌曲本身沒有 `publishTime` 時的備援）、留言數與熱門評論都是另外的請求，為了維持一個請求沒有取（熱門評論本來就不做，design §16 第 13 條）。要補頭像或備援發行日時各加一個請求，`music.126.net` 已在 `allowedHosts`。
  - `sourceId` 不是純數字（或大到轉成數字會失真，超過 2^53）→ `ParseError`，不發請求（`resolveStream` 對同樣的輸入回 `NotFound`，是它原本的行為）；回應沒有歌（`songs` 空或缺）→ `NotFound`；`songs[0]` 不是物件 → `ParseError`。

- `importPlaylist`：匯入歌單，兩個匯出（FMP ADR 0032 §決定 2）。規格是舊專案 `netease_source.dart` 的 `parsePlaylist`（`api/v6/playlist/detail` 拿 `trackIds`，再以 `api/v3/song/detail` 每 400 個 id 一批補歌曲資料）、`_extractPlaylistId` 與 `SourceUrlPolicy`。
  - `playlistFromUrl({url})`：網域限舊專案的 `music.163.com`、`y.music.163.com`，沒有 `://` 的輸入當成 https。路徑或 `#` 後面（網頁版 `#/playlist?id=…`）要有 `playlist` 段（舊版 `isPlaylistUrl` 同），id 取 `?id=<數字>`，沒有就取 `playlist` 後面那一段（手機分享的 `/playlist/<id>/<uid>`）；回 `{playlistId}`，其餘 `null`。與舊版不同：舊版用 `[?&]id=(d+)` 與 `/playlist[?/].*?(d{5,})` 在整個網址裡找，這裡限定在 `playlist` 段之後，所以 `song?id=…` 這類回 `null`，id 也不再要求至少 5 位。
  - **短網址**：`163cn.tv`（舊版 `neteaseShortHosts`，`allowedHosts` 為此加了它）是唯一會發請求的情況：`GET https://163cn.tv/<碼>`（`auth: 'never'`，宿主跟隨轉址），用回應的最終網址（`response.url`）照上面的規則認；最終網址不是網易的歌單網址回 `null`，短網址已失效（HTTP 404）回 `NotFound`，其他非 200 照〈錯誤對應〉。舊版先 HEAD 再 GET，這裡只 GET（宿主 `HttpRequest` 沒說 HEAD 的轉址行為，頁面本身是小的殼）。**未實測**：沒有現成可用的 `163cn.tv` 網址，轉址形狀（最終網址的網域與路徑）是照舊版的轉址白名單（`music.163.com`、`y.music.163.com`）推的，`test/import_playlist.test.js` 以手寫的轉址結果守。
  - `importPlaylist({playlistId, cursor?})`：`POST music.163.com/api/v6/playlist/detail`（明文 form `id=<id>`，舊版同），拿歌單資料與**全部** `trackIds`；詳情自己附的 `tracks` 只有前幾首完整資料，這一頁要的 id 裡不在其中的，再以 `POST api/v3/song/detail`（`c=[{"id":…}]`，與 `trackDetail` 同一個端點）**一次**補齊。兩個請求都標 `auth: 'userPreference'`、`idempotent: true`，不帶 `X-Real-IP`。`playlistId` 不是正整數字串、`cursor` 格式不對 → `ParseError`，不發請求。
  - **分頁**：一頁 400 個 id（舊版 `_songDetailBatchSize`，一批就是一頁）；`cursor` 是 `v1:<起點>:<0|1>`，起點必須是 400 的倍數，後者是「以 `required` 送」。**每一頁都重新取 detail**（歌單資料與完整的 `trackIds` 都在裡面），所以 cursor 不用背歌單資料或 id 清單；代價是每頁多一個 detail 請求，而且歌單在兩頁之間被改過時，頁界會跟著移（少數重複或漏掉；`total` 對不上時宿主不套用移除）。`items` 依 `trackIds` 的順序；`song/detail` 沒回的 id（歌曲資料取不到）略過。
  - `playlist`：`title`（`name`，缺或空 → `ParseError`）、`description`（空不給）、`artwork`（`coverImgUrl`，格式同 `search` 的封面，方形 120、200、400）、`ownerName`（`creator.nickname`）。**不給 `writable`**：回應沒有「這張是登入者自己的」旗標，要比 `creator.userId` 得先知道登入者的 uid（只在 `loginVerify` 取得），留到 FMP M4 PR 13（`libraryPlaylists`）一起決定。
  - `items`：`track` 欄位同 `search`（共用同一個映射，`test/import_playlist.test.js` 守）。**`unavailable`**：`privileges` 裡該首的 `st` 為 `-200` 才標 `true`（舊版 `isAvailable = (st != -200)`）；**實測的榜單歌單沒有 `-200`**（沒驗過），倒是匿名時 100 首裡有 77 首 `st` 是 `-100`（歌單是官方榜單，不可能多數下架），所以不當失效。
  - **`total`**：給歌單 `trackIds` 的長度（每頁相同，實測等於 `trackCount`）。`song/detail` 沒回的 id 會讓回傳筆數少於它，宿主就當不完整、不套用移除；寧可如此也不讓缺的歌被當成已完整。
  - **不給 `remoteItemId`**：網易歌單的新增與移除（`playlist/manipulate/tracks`）直接用歌曲 id，沒有獨立的項目 id（舊版 `netease_playlist_service.dart` 的 `_manipulateTracks`；這次沒有實測）。
  - **私人歌單**：請求一律 `userPreference`。detail 的 `code` 為 301、401、403、404，或 200 卻沒有 `playlist`（舊版 "Playlist data not found"）視為讀不到；這次沒帶憑證（`credentialsAttached` 為假）且 `fmp.credentials.get()` 不是 `null` 時，以 `required` 重送一次；已帶憑證被拒、或重送後還被拒都不再送。靠重送讀到的歌單，後續頁的 detail 也以 `required` 送（記在 cursor）；`song/detail` 一律 `userPreference`（歌曲資料是公開的）。最後還讀不到：沒帶憑證的 301、401、403 → `AuthRequired`，其餘（404、沒有 `playlist`、已帶憑證被拒）→ `NotFound`；帶了憑證的 301 是 `CredentialInvalid`（既有的判定表）。**未實測**：匿名讀私人歌單與不存在的歌單的實際回應（`code` 與訊息），上面的碼是照舊版 `_checkResponse` 與網易網頁行為推的，`test/import_playlist.test.js` 用手寫的碼守邏輯。
  - **實測**（2026-10-15，匿名，Windows，FMP 的錄製器）：官方帳號（`creator.nickname` 為「网易云音乐」）的榜單歌單「飙升榜」，`id` `19723756`，網址 `https://music.163.com/#/playlist?id=19723756`。`trackCount` 100、`trackIds` 100 個；**詳情一次給 10 首完整資料**（`tracks` 10 筆），其餘 90 首以一批 `song/detail` 補齊（1 批，90 首都回來了；`privileges` detail 與 `song/detail` 各 10、90 筆，合計 100），所以一頁收完、`cursor` 為 `null`、`total` 100。`code` 全是 200，沒有觸發風控。錄製發了 2 個請求（detail 一個、`song/detail` 一個）。`163cn.tv` 沒有實測（見上）。分頁（超過 400 首）只有單元測試。
- `charts`：一個榜單 `hot`（「熱歌榜」），兩個匯出（FMP ADR 0032 §決定 5）。規格是舊專案 `netease_source.dart` 的 `getHotRankingTracks`：官方熱歌榜歌單 `3778678`，取前 50 個 `trackIds`，順序就是歌單的順序（不排序）。
  - `chartList()`：常數，不發請求。`chart({chartId})`：`POST api/v6/playlist/detail`（`id=3778678`）取 `trackIds`，歌曲資料的取法同 `importPlaylist`（共用 `songsOf`：詳情自帶的前幾首，其餘的以一個 `song/detail` 補，50 個 id 遠小於一批 400），`track` 欄位同 `search`。`song/detail` 的回傳順序不保證，所以依榜單的 id 順序排；沒回來的 id 略過。兩個請求都標 `auth: 'userPreference'`、`idempotent: true`，不帶 `X-Real-IP`；榜單沒有「下架」的概念，`privileges` 不看。
  - `chartId` 不認得 → `NotFound`，不發請求；detail 的 `code` 不是 200 照〈錯誤對應〉，沒有 `playlist.trackIds` 或 id 不是正整數 → `ParseError`。
  - 舊專案取了 `limit`（`request.limit ?? 50`）；契約沒有這個參數，固定 50。
- `login`：QR 碼登入，見下方〈登入〉。

## 登入（QR）

manifest 宣告 `login: { methods: ['qr'] }`（網易的 `MUSIC_U` 有效期長，沒有刷新，不匯出 `loginRefresh`）。

1. `loginQrStart`：`POST music.163.com/weapi/login/qrcode/unikey`，回應的 `unikey` 是 token，QR 碼內容是 `https://music.163.com/login?codekey=<unikey>`。
2. `loginQrPoll(token)`：`POST music.163.com/weapi/login/qrcode/client/login`，狀態在頂層 `code`：`801` 等待、`802` 已掃描、`800` 過期、`803` 成功。成功時 `MUSIC_U`、`__csrf` 取自回應的 `Set-Cookie`；沒有 `MUSIC_U` 時退到 body 的 `cookie` 字串。
3. `loginVerify(credentials)`：`GET music.163.com/api/nuser/account/get`（HTTP 不是 200 時改打 `POST /api/w/nuser/account/get`，舊專案的做法），自己用傳入的憑證組 `Cookie`（`MUSIC_U`、`__csrf`，加 `os=pc`、`deviceId=fmp`），請求標 `auth: 'never'`。

- 存的 cookie（只看名稱）：`MUSIC_U`、`__csrf`（沒有就不放）。沒有 `extra`。
- 用到的網域：只有 `music.163.com`，不需要新增。
- QR 兩個請求都是 weapi：JSON 經雙層 AES-128-CBC（固定金鑰、隨機 16 字元金鑰）加 RSA（無 padding）封裝隨機金鑰，`params`、`encSecKey` 以 form 送出；每次輪詢重新加密。程式在 `src/weapi.js`，AES-CBC 與 base64 在 `src/aes.js`，RSA 的大整數運算用 `bn.js`（MIT，固定 5.2.5，esbuild 打包進 `netease.js`）：FMP 的 QuickJS 沒有 `BigInt`，所以不用它。打包檔不得出現 `BigInt`、`TextEncoder`、`atob`、`btoa`、`getRandomValues`（`test/weapi.test.js` 守）。隨機金鑰用 `Math.random`：它只保護公開 QR 流程的請求內容，不是憑證。
- QR 兩個請求固定帶舊專案的匿名 `Cookie`（`os=pc; osver=…; appver=2.7.1.198277; channel=netease; __csrf=; MUSIC_U=`，`MUSIC_U`、`__csrf` 是空的），不帶 `X-Real-IP`。
- `search`、`resolveStream` 的請求標 `auth: 'userPreference'`：使用者開著「以登入身分瀏覽與播放」時宿主才帶憑證（ADR 0012）；`os=pc`、`deviceId=fmp` 還沒有加進這兩個請求。
- `803` 卻沒有 `MUSIC_U` 時回 `ParseError`（舊專案當成過期）；不認得的 `code` 照下方錯誤對應（`UnexpectedError`），不當成「還在等」。
- `loginVerify`：頂層 `code` 301、或 200 卻沒有 `profile`、或沒有 `MUSIC_U` → `CredentialInvalid`；其他照下方錯誤對應。
- 輪詢逾時、連續錯誤幾次放棄，都是宿主端的事。

## 憑證無效的判定

宿主對 `credentialsAttached` 為 `true`（這次請求真的帶了憑證）的回應才容許「憑證無效」；判定集中在 `credentialsRejected(json, credentialsAttached)`（`src/errors.js`，`test/errors.test.js`、`test/search.test.js` 守）：

| 回應 | `credentialsAttached` | 結果 |
|---|---|---|
| 頂層 `code` 301（未登入；cookie 名稱 `MUSIC_U`） | `true` | `CredentialInvalid` |
| 同一個 body | `false`（匿名） | 照下方〈錯誤對應〉：`AuthRequired` |
| `-460`（風控）、HTTP 460／462／5xx、其他碼 | 任何 | 照下方〈錯誤對應〉，不是憑證無效 |

只看頂層 `code`。取流項目（`data[0]`）的 `code` 301 與「404 且 `fee` 0」仍是 `AuthRequired`：後者匿名請求也會出現，不能當憑證無效。`loginVerify` 自己組 `Cookie`、標 `auth: 'never'`（`credentialsAttached` 一定是 `false`），直接依 `code` 301 判定。

## 錯誤對應

| 條件 | FMP 錯誤 |
|---|---|
| HTTP 460、462，或回應的 `code` 為 `-460` | `VerificationRequired` |
| HTTP 5xx | `NetworkError` |
| 回應的 `code` 為 301（回應帶了憑證時改為 `CredentialInvalid`），或串流項目的 `code` 為 301 | `AuthRequired` |
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
- 一個 `checks.json` 每個能力只有一條案例，所以契約測試只重播成功的 `search`、`resolveStream`、`trackDetail`、`importPlaylist`、`charts` 與 `login`（錄製後刪減的 fixture）；上表的錯誤對應由 `test/errors.test.js` 以網易實際給的欄位守（`npm test`）。
- fixture 裡的 `NMTID` 等 Cookie 值已被 FMP 的遮蔽名單遮掉；錄製者的 IP 由錄製器換成文件用位址。

## 打包

```sh
cd netease
npm ci
node build.mjs   # 輸出 netease.js（不壓縮，內容固定）
npm test         # 錯誤對應表、AES／weapi、登入流程、取流、搜尋、trackDetail 與 importPlaylist 的測試（node:test）
```

用 esbuild 把 `src/` 與 `bn.js` 打成單一檔，`netease.js` 與原始碼、`package-lock.json` 一起提交；index 只認這一個 `.js`。`manifest` 寫在 `build.mjs`。

## 契約測試與錄製

指令見 repo 根目錄的 `README.md`。錄製會真的連網易：搜尋、取流與 `trackDetail`（案例的 `sourceId` 是 `139774`，與 `resolveStream` 相同）各 1 個請求，`importPlaylist`（`playlistFromUrl` 不發請求，再讀第一頁：detail 與一批 `song/detail`）2 個，`charts`（detail 與一批 `song/detail`）2 個，共 7 個。`charts` 的 fixture（`fixtures/charts/001.json`、`002.json`）是 2026-10-16 錄的熱歌榜，未刪減（detail 約 60 KB：200 個 `trackIds`，自帶 10 首完整資料；`song/detail` 補 40 首，約 85 KB）。`importPlaylist` 的 fixture（`fixtures/importPlaylist/001.json`、`002.json`）是 2026-10-15 錄的飙升榜，刪減到只剩插件讀的欄位（`meta.edited`；原始回應 44 KB 與 192 KB，歌曲的音質檔位、專輯詳情等都刪了），所以命令列錄製會略過它；要重錄時先拿掉 `meta.edited`。榜單內容天天變，案例只檢查第一頁至少 50 首。`login` 的案例標 `requiresLogin`，命令列錄製略過；它的 fixture（`fixtures/login/001.json`）是 2026-10-15 在 FMP 的插件開發工具以測試帳號登入後錄的（FMP #254），再刪減成只剩 `loginVerify` 讀的欄位（`meta.edited`）：`account/get` 的 `userName` 是手機號的格式，頭像檔名是可推回原圖的圖片 id，都刪掉或換成 `***`。

## 測試向量

`test/weapi.test.js` 的向量是現算的：AES-CBC 用 `node:crypto` 的 `createCipheriv`，RSA 用 `publicEncrypt`（`RSA_NO_PADDING`，公鑰由寫死的模數與 65537 組成），base64 用 `Buffer`，另有 NIST SP 800-38A F.2.1 的 CBC 向量；固定隨機金鑰的 `weapiEncrypt` 輸出必須等於 `node:crypto` 的組合，且能反向解回原 JSON。
