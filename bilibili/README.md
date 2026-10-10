# bilibili

B 站音源，可匿名使用，也可用 QR 碼登入（啟動時自動刷新憑證）。行為以 FMP 舊專案的 `lib/data/sources/bilibili_source.dart` 為規格，改用 JS 重寫。

## 能力

- `search`：搜尋影片（`/x/web-interface/search/type`，綜合排序，每頁 20 筆）。課堂這類不是影片的結果沒有 `bvid`，會被略過，所以一頁可能不到 20 筆。標題會去掉 `<em>` 標籤並解 HTML 實體（命名的與 `&#39;`、`&#x27;` 這類數字的）。封面回傳 `@160w`、`@480w` 兩個縮圖（標寬度）加原圖（不標寬度），宿主依顯示大小挑。
- `login`：QR 碼登入與憑證刷新，見下方〈登入〉〈刷新〉。
- `resolveStream`：沒給 `cid` 時先以 WBI 簽名呼叫 `/x/web-interface/wbi/view` 取得預設分 P 的 `cid`，再呼叫 `/x/player/playurl`。
  - 優先 DASH 音訊。平台能播的音軌依頻寬由高到低排，`quality` 選中的那一個放最前面：`high` 最高、`low` 最低、`medium` 取中間（第 `⌊n / 2⌋` 個，只有兩個時是低的那個；與舊專案 `selectByQualityLevel` 相同）。其他音軌當備援，先往下降、沒有更低的才往上：接著是比它低的（由高到低），最後是比它高的（由低到高）。例如三軌選 `low` 是低、中、高，選 `medium` 是中、低、高。沒給 `quality` 時當 `high`。每個音軌的主網址排在前面，備用網址排在後面。
  - 沒有平台能播的 DASH 音訊時，改用 durl（影音混流），只取第一段；只有一條，`quality` 不適用。
  - 候選串流只帶 `Referer` 與 `User-Agent`，不帶 Cookie。
  - `expiresAt` 從網址本身讀：upos 取 `deadline`，Akamai 鏡像取 `hdnts=exp=`。

## 登入（QR）

manifest 宣告 `login: { methods: ['qr'], refresh: 'onStartup' }`。流程由宿主驅動：

1. `loginQrStart`：`GET passport.bilibili.com/x/passport-login/web/qrcode/generate`，`data.url` 是 QR 碼內容，`data.qrcode_key` 是 token。
2. `loginQrPoll(token)`：`GET …/web/qrcode/poll?qrcode_key=`，狀態在 `data.code`：`86101` 等待、`86090` 已掃描、`86038` 過期、`0` 成功。成功時憑證的 cookie 取自**這次回應的 `Set-Cookie`**，`refresh_token` 取自 body。
3. `loginVerify(credentials)`：`GET api.bilibili.com/x/web-interface/nav`，自己用傳入的憑證組 `Cookie`（不帶匿名 `buvid*`），請求標 `auth: 'never'`。

- 存的 cookie（只看名稱）：`SESSDATA`、`bili_jct`、`DedeUserID`、`DedeUserID__ckMd5`（可缺）；`extra.refresh_token`（可缺）。值原樣保存，不 URL 解碼。
- 用到的網域：`passport.bilibili.com`（QR 兩個請求）、`api.bilibili.com`（verify）。
- QR 兩個請求不帶任何 cookie、標 `auth: 'never'`。`search`、`resolveStream` 的請求標 `auth: 'userPreference'`：使用者開著「以登入身分瀏覽與播放」時宿主才帶憑證（ADR 0012）。
- `data.code` 為 `0` 卻沒有 `SESSDATA`、`bili_jct`、`DedeUserID`，回 `ParseError`（舊專案在這種情況會假成功）；不認得的 `data.code` 回 `UnexpectedError`，不當成「還在等」。
- `loginVerify` 的頂層 `code`：`-101`、`-111` → `CredentialInvalid`（憑證無效）；其他照下方錯誤對應。沒有 `SESSDATA` 也是 `CredentialInvalid`，不發請求。
- 輪詢逾時、連續錯誤幾次放棄，都是宿主端的事。

## 刷新

`loginRefresh(credentials)` 由宿主在啟動時呼叫，照舊專案 `refreshCredentials` 的 5 步，每個請求自己組 `Cookie`（同 verify，四個憑證 cookie）、標 `auth: 'never'`：

1. `GET passport.bilibili.com/x/passport-login/web/cookie/info`：`data.refresh` 不是 `true` → 回 `null`（不需要刷新，不再發請求）。
2. 用寫死的 1024-bit 公鑰對 `refresh_<data.timestamp>` 做 RSA-OAEP（SHA-256），輸出小寫 hex（`correspondPath`）。
3. `GET www.bilibili.com/correspond/1/<correspondPath>`（HTML），取 `<div id="1-name">…</div>` 的內容為 `refresh_csrf`。
4. `POST …/cookie/refresh`（form：`csrf` = `bili_jct`、`refresh_csrf`、`source=main_web`、舊 `refresh_token`）：新 cookie 取自回應的 `Set-Cookie`（沒給的名稱沿用舊值），新 `refresh_token` 取自 `data.refresh_token`。
5. `POST …/confirm/refresh`（form：新 `bili_jct`、**舊** `refresh_token`；`Cookie` 用新的）。失敗（傳輸錯誤、HTTP 非 200、非 0 的 `code`）只寫一筆 warning，照樣回傳新憑證：第 4 步已發出新憑證、用掉舊 `refresh_token`，丟掉新的只會讓下次刷新被拒（舊專案先存新憑證再 confirm，同樣不看 confirm 的結果）。

回傳 `{cookies, extra: {refresh_token}}`（新值），由宿主寫入。

- 用到的網域：`passport.bilibili.com`、`www.bilibili.com`（correspond 頁，這次新增）。
- QuickJS 沒有 `BigInt`、`TextEncoder`、WebCrypto，宿主的 `sha256` 又只吃字串，所以 SHA-256、MGF1、OAEP 是純 JS（`src/oaep.js`），RSA 的大整數運算用 `bn.js`（MIT，固定 5.2.5，esbuild 打包進 `bilibili.js`）。OAEP 的 32 位元組種子用 `Math.random`（QuickJS 沒有 `getRandomValues`）：它只讓同一個明文每次的密文不同，明文是 `refresh_<時間戳>`，不是機密。
- **已知的原子性窗口**：宿主要等 `loginRefresh` 回傳才寫入新憑證（design 的順序）。第 4 步成功到宿主寫入完成之間若寫入失敗，新憑證沒落地、舊 `refresh_token` 已用掉，要重新登入。第 4 步之前的任何失敗，舊憑證仍有效，宿主保留它下次再試。舊專案是先寫入再 confirm，沒有這個窗口。
- 失敗的分類：憑證本身壞了 → `CredentialInvalid`：任一步的頂層 `code` 為 `-101`（未登入）、`-111`（csrf 驗證失敗），或需要刷新卻沒有 `refresh_token`／`bili_jct`／`SESSDATA`。其他一律照下方〈錯誤對應〉，**不會**變成 `CredentialInvalid`：HTTP 非 200（含 correspond 頁的 404）、風控碼、不是 JSON、correspond 頁沒有 `refresh_csrf`、refresh 回應缺新 `refresh_token` 或 `SESSDATA`／`bili_jct`（`ParseError`）、傳輸錯誤。第 4 步的 `86095`（記載是 `refresh_csrf` 錯或 `refresh_token` 與 cookie 對不上）刻意當 `UnexpectedError`：意義沒驗證過，而且第 1 步剛接受了這組 cookie，標失效會要求還能用的登入重新登入；cookie 真的壞了時，帶憑證的請求拿到 `-101` 會再觸發一次刷新，在第 1 步判定。
- 沒有對真實端點驗證過：流程、碼表與 `86095` 的意義來自舊專案與 bilibili-API-collect 的記載，這個 repo 的測試只用假回應。

## 憑證無效的判定

宿主對 `credentialsAttached` 為 `true`（這次請求真的帶了憑證）的回應才容許「憑證無效」；判定集中在 `credentialsRejected(json, credentialsAttached)`（`src/plugin.js`，`test/refresh.test.js` 守）：

| 回應 | `credentialsAttached` | 結果 |
|---|---|---|
| 頂層 `code` `-101`（未登入）或 `-111`（csrf 驗證失敗，cookie 名稱 `SESSDATA` 與 `bili_jct` 對不上） | `true` | `CredentialInvalid` |
| 同一個 body | `false`（匿名，例如 WBI 的 nav） | 照〈錯誤對應〉：`AuthRequired` |
| 風控碼（`-352`、`-412`、`-509`、`-799`）、HTTP 412／5xx、`-503`、其他碼 | 任何 | 照〈錯誤對應〉，不是憑證無效 |

`-111` 與 `-101` 同列是舊專案 `bilibili_auth_interceptor.dart` 的判定。`loginVerify`、`loginRefresh` 自己組 `Cookie`、標 `auth: 'never'`（`credentialsAttached` 一定是 `false`），所以它們直接依碼判定，不看這張表。

## 匿名狀態

- `buvid3`、`buvid4`、`b_nut` 第一次使用時在本機亂數產生，存進插件的 storage，之後的 API 請求以 Cookie 帶上。不另外向 B 站領取。
- WBI 的 `img_key`、`sub_key` 從 `/x/web-interface/nav` 取得（未登入時回 `-101`，但仍附 `wbi_img`），存進 storage，北京時間換日後重新取得。

## 錯誤對應

| B 站回應 | FMP 錯誤 |
|---|---|
| HTTP 412；業務碼 `-352`、`-412`、`-509`、`-799`（風控） | `RateLimited` |
| HTTP 5xx；業務碼 `-503` | `NetworkError` |
| 業務碼 `-101`、`-111`（csrf 驗證失敗）、`-403` | `AuthRequired`（回應帶了憑證時 `-101`、`-111` 改為 `CredentialInvalid`；`loginVerify`、`loginRefresh` 同） |
| 業務碼 `-404`、`62002`、`62004`、`62012` | `NotFound` |
| 業務碼 `-10403` | `Unavailable`（`region`） |
| 業務碼 `87007`、`87008` | `Unavailable`（`membership`） |
| 不是 JSON、缺 `data` 或 `cid`；nav 回 `0` 或 `-101` 卻沒有 `wbi_img` | `ParseError` |
| 其他狀態碼與業務碼 | `UnexpectedError` |

HTTP 429 由 FMP 的網路層轉成 `RateLimited`。DASH 以 `NotFound` 或 `Unavailable` 失敗時會改試 durl。

## 已知限制

- 不登入時拿不到需要登入或大會員的音質（Hi-Res、杜比）。匿名身分被風控（`-352`）時只會回 `RateLimited`；登入後開著「以登入身分瀏覽與播放」可能緩解。登入後的取流行為（含 `dash.flac`）還沒有處理。
- 只取 `view` 回傳的預設分 P；多 P 影片的其他分 P 要由呼叫端給 `cid`。
- `allowedHosts` 列了 `bilivideo.cn`：B 站的 PCDN（`*.mcdn.bilivideo.cn`）在部分網路會出現，但這次錄製沒遇到。網域不在清單內的串流網址（例如其他 PCDN 網域、直接寫 IP 的節點）會被丟掉，並寫一筆 warning log；一個音軌的網址全被丟掉時，那個音軌就不會出現在候選裡。
- fixture 裡串流網址的簽名參數（`upsig`、`e`、`uparams` 等）已經遮蔽，`deadline` 留著（公開的到期時間，FMP 的遮蔽名單不遮它）。`checks.json` 的 `expiresAtPattern` 讓契約檢查核對每個候選的 `expiresAt` 與網址裡的期限一致；Akamai 鏡像的 `hdnts` 整段遮掉（含 `hmac`），沒有 `deadline` 的那種網址重播時 `expiresAt` 是 `null`，不在核對範圍內。
- `quality` 的選擇沒有自動測試：契約每個能力只有一條檢查案例（`high`）。改它時以 fixture 的 playurl 回應另外跑過 `low`、`medium`。

## 契約測試與錄製

指令見 repo 根目錄的 `README.md`。錄製會真的連 B 站：`search` 發 1 個請求，`resolveStream` 發 3 個（nav、view、playurl）。`login` 的案例標 `requiresLogin`，命令列錄製略過（`loginRefresh` 沒有契約案例，每個能力只有一條，ADR 0015）；它的 fixture（`fixtures/login/001.json`）是手寫的（`meta.edited`），憑證與帳號都是假的，body 的形狀照 nav 的真實回應。

## 打包

```sh
cd bilibili
npm ci
node build.mjs   # 輸出 bilibili.js（不壓縮，內容固定）
npm test
```

用 esbuild 把 `src/` 與 `bn.js` 打成單一檔，`bilibili.js` 與原始碼、`package-lock.json` 一起提交；index 只認這一個 `.js`。`manifest` 寫在 `build.mjs`。改 `src/` 後要重打包，否則發佈的 `bilibili.js` 不含改動。

## 測試

`npm test`（`node --test`，要先 `npm ci`）測 `test/` 裡的純函式與以假宿主 API 跑的流程：實體解碼與封面尺寸（`helpers.test.js`）；QR 狀態碼、`Set-Cookie` 解析、缺 cookie、verify 對應與請求形狀（`login.test.js`）；SHA-256、MGF1、RSA-OAEP 以 `node:crypto`（`privateDecrypt`，`oaepHash: 'sha256'`，測試自己生的金鑰）獨立驗證、寫死的公鑰等於舊專案的，以及打包檔不得出現 `BigInt`、`TextEncoder`、`crypto.subtle`、`getRandomValues` 且在 `BigInt` 被清掉時仍能載入（`oaep.test.js`）；憑證無效的判定表與 `loginRefresh` 的 5 步和各種失敗（`refresh.test.js`）。cookie 與 token 的值都是 `fake-…`。`src/plugin.js` 匯出 `decodeHtmlEntities`、`artwork`、`parseSetCookies`、`qrCredentials`、`verifyCookie`、`credentialsRejected`、`refreshCsrfOf` 只為了這個；宿主只認能力名稱的匯出，其他名稱忽略。
