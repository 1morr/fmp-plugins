# youtube

YouTube 音源，匿名可用，也可以登入。以 [YouTube.js](https://github.com/LuanRT/YouTube.js)（`youtubei.js` 18.1.0）為底，esbuild 打成單一檔 `youtube.js`；可行性驗證見 FMP 的 M1 探針報告（`.trellis/tasks/archive/2026-09/09-30-youtubejs-probe/research/youtubejs-probe.md`）。

## 能力

- `search`：搜尋影片（`yt.search`，type 為 video）。只收影片；頻道、播放清單、Shorts 欄位，以及沒有長度的直播與首播都略過，所以一頁可能不到 20 筆。續頁只接得在同一個關鍵字的上一頁後面（continuation 存在記憶體，插件重啟後第 2 頁起回空）。
- `resolveStream`：不需要 PO token，player 請求一律不帶登入憑證（見「登入」）。依序試 `VISIONOS`、`IOS` 兩個 client，取第一個有音訊的（`ANDROID_VR` 自 2026-08-26 起沒帶 token 只給約 60 秒，不用）。
  - 只取純音訊的 adaptive format；多語言配音的影片只留預設音軌。網址是明文，不需要下載 player JS（`retrieve_player: false`）。
  - 候選依 `formats` 的先後分組（使用者的格式偏好），同一組內依 `quality` 排：選中的在最前面（`high` 最高碼率、`low` 最低、`medium` 取中間 `⌊n / 2⌋`），接著是比它低的（由高到低），最後是比它高的（由低到高）。平台不能播的格式不出現。
  - 候選不帶 header：不帶 Cookie，googlevideo 也不需要 Referer。
  - `expiresAt` 從網址的 `expire` 參數讀（unix 秒 → 毫秒）。`expire` 不在 FMP 的遮蔽名單內，fixture 裡留著，`checks.json` 的 `expiresAtPattern` 核對它。

## 錯誤對應

只看 `playabilityStatus`；兩個 client 都不能播時，丟第一個 client 的結果。

| playabilityStatus | FMP 錯誤 |
|---|---|
| reason 含 `not a bot`（「確認你不是機器人」） | `VerificationRequired` |
| `LOGIN_REQUIRED`，reason 含 `age` 或 `inappropriate` | `Unavailable`（`age`） |
| 其他 `LOGIN_REQUIRED`（私人影片等） | `AuthRequired` |
| `UNPLAYABLE`，reason 含 `country`、`region`、`location` | `Unavailable`（`region`） |
| `UNPLAYABLE`，reason 含 `copyright` | `Unavailable`（`copyright`） |
| `UNPLAYABLE`，reason 含 `member`、`join this channel` | `Unavailable`（`membership`） |
| `ERROR`（影片不存在、已刪除） | `NotFound` |
| 其他 `UNPLAYABLE` 與未知的 status | `UnexpectedError` |
| OK 但沒有純音訊，或沒有平台能播的格式 | `NotFound` |

HTTP 429 與傳輸錯誤由 FMP 的網路層轉成 `RateLimited`、`NetworkError`，插件不處理。reason 文字用英文比對（innertube 的預設語言）；YouTube 改文案時對不上的會落到 `UnexpectedError`。

## 網路

- innertube 的 POST（搜尋、player、config）都是查詢，標 `idempotent: true`，暫時失敗時由網路層重試（FMP ADR 0028）。
- `Innertube.create` 的會話資料（visitor data 等）存在插件的 storage，之後的啟動不再打 `sw.js_data` 與 `config`。
- QuickJS 沒有 Web API：`src/shims.js` 以 `fmp.http.request` 為底補上 fetch、Headers、Request、Response，並補 URL、TextEncoder/TextDecoder、crypto、atob/btoa、timers。宿主 API v1 只傳字串 body，二進位的 request body 一律拋錯。
- 宿主的網路紀錄沒有 body：innertube 回 4xx／5xx 時插件另記一筆 warn（`innertube error`），只含路徑、client 名稱、有沒有帶憑證，以及 Google API 錯誤物件的 `status` 與 `message`。

## 已知限制

- 年齡限制與會員影片播不了，登入也一樣：player 請求不帶憑證（見「登入」）。匿名身分被要求驗證時只會回 `VerificationRequired`。
- 哪個 client 能用由 YouTube 決定，`VISIONOS` 也可能被加上同樣的限制。換 client 只要改 `src/clients.js` 的 `CLIENTS` 並重新打包，不必發新版 App；新 client 收不收 cookie 要對 `COOKIELESS_CLIENT_NAMES`。
- 一個 `checks.json` 每個能力只有一條案例，所以契約測試只重播成功的 `search`、`resolveStream` 與 `login`；上表的錯誤對應由 `test/errors.test.js` 以 YouTube 實際給的 `playabilityStatus` 文字守（`npm test`）。player 請求不用 YouTube.js 的 `getBasicInfo`：它遇到 `ERROR` 直接拋例外，走不到 `NotFound`；`test/resolve.test.js` 以錄好的 fixture 跑整條 `resolveStream` 守這點（測試裡用 esbuild 在記憶體打包 `src/`）。
- fixture 裡有匿名的 `visitorData` 與 `x-goog-visitor-id`（YouTube 發的匿名識別，不是憑證）。
- 錄製者的公網 IP 會出現在 `sw.js_data` 回應、請求 body 的 `remoteHost`、`hlsManifestUrl` 路徑的 `/ip/…/`：FMP 的錄製器把 fixture 裡的 IP 一律換成文件用位址，掃描也會擋（FMP `app/test/plugins/contract/ip_scrub.dart`）。`hlsManifestUrl` 路徑式的 `/sig/…/`、`/lsig/…/` 遮蔽名單遮不到，現有 fixture 已手動換成 `***`（已過期、重播只比對方法與網址）；重錄後要再換一次。

## 登入

宣告 `login` 能力，方式是 App 內網頁登入（`webView`）與貼上 cookie（`cookie`）；`automationRisk: true`（以登入身分大量請求可能被視為自動化行為，推測）。

- 登入頁 `https://accounts.google.com/ServiceLogin?service=youtube&continue=https://www.youtube.com/`，從 `https://www.youtube.com` 取 cookie，下列三個都出現就算完成：`SAPISID`、`__Secure-1PSID`、`__Secure-3PSID`。貼上 cookie 時這三個也是必要的。
- `loginVerify(credentials)`：以傳進來的 cookie 自己組 `Cookie`，加上 `Authorization: SAPISIDHASH …`，`auth: 'never'` 打一次 innertube `account/account_menu`（R1 實測過會回帳號區塊）。取選中的帳號（`isSelected`，沒有就第一個）：名稱 → `displayName`，頭像 → `avatar`（只留 `ggpht.com`、`ytimg.com`，其餘網域不在 `allowedHosts`），`userId` 依序取回應裡的 datasync id（純數字）、頻道 handle、帳號名稱。缺必要 cookie、HTTP 401、或回應沒有帳號項（登出狀態）都是 `CredentialInvalid`。
- `SAPISIDHASH`：`SHA1("{秒} {SAPISID} https://www.youtube.com")`，算法同舊版 `lib/services/account/youtube_credentials.dart`；宿主的 `fmp.crypto` 沒有 SHA-1，所以 `src/sapisid.js` 自己實作（`test/sapisid.test.js` 對 `node:crypto`）。innertube 請求（`/youtubei/`）標 `auth: 'userPreference'` 並附 `authHeaders`（`Authorization`、`X-Origin`）；宿主只在已登入且「以登入身分瀏覽與播放」開著時才帶 Cookie 與這兩個 header，其餘情況丟掉。`sw.js_data` 不標，避免匿名 visitor data 被快取成某個帳號的。
- 不收 cookie 的 client（請求 body 的 `clientName` 是 `VISIONOS`、`iOS`、Android 系，`src/clients.js`）不標：2026-10-10 Windows 實測，`VISIONOS` 的 player 帶 Cookie 與 `SAPISIDHASH` 回 HTTP 400 `INVALID_ARGUMENT`（「Request contains an invalid argument.」），yt-dlp 也把這些 client 標成不支援 cookie。所以登入只影響搜尋與帳號資訊，`resolveStream` 的 player 請求都是匿名的。
- 收 cookie 的 client 同日實測都不能用：`WEB_EMBEDDED`（帶嵌入頁的 `encryptedHostFlags`）回 `ERROR`「This video is unavailable」，`TV` 回 `UNPLAYABLE`「The page needs to be reloaded.」（yt-dlp #17389）。它們的網址還要下載並解析 player JS 解 n／簽章（QuickJS 裡首次約 10 秒）。
- 憑證無效：回應的 `credentialsAttached` 為 `true` 且 HTTP 401 → `CredentialInvalid`（`src/errors.js` 的 `credentialInvalidError`）；沒帶憑證的 401、403、429 維持原本的處理。沒有宣告 `refresh`（Cookie 有效期約兩年）。
- 沒有實測：`account_menu` 的真實回應形狀（`userId` 的取法是依 YouTube.js 的 `AccountItem` 欄位推的；契約的 `login` fixture 是手寫的，`meta.edited` 有註明）。

## 打包

```sh
cd youtube
npm ci
node build.mjs   # 輸出 youtube.js，內容固定（同樣的輸入產生同樣的檔案）
npm test         # 錯誤對應表的測試（node:test）
```

`youtube.js` 與原始碼（`src/`）、`package-lock.json` 一起提交；index 只認這一個 `.js`。`youtubei.js`、`esbuild`、`core-js` 的版本釘死在 `package.json`，升版後要重新打包並重錄 fixture。`manifest` 寫在 `build.mjs`。

## 契約測試與錄製

指令見 repo 根目錄的 `README.md`。錄製會真的連 YouTube：每個案例各發 3 個請求（`sw.js_data`、`config`，再來 `search` 或 `player`），共 6 個。

`login` 案例（`fixtures/login/001.json`）是手寫的，不錄：輸入是假憑證，回應照 `account_menu` 的形狀寫成已遮蔽的形式，錄製模式略過它。
