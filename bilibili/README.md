# bilibili

B 站音源，可匿名使用，也可用 QR 碼登入。行為以 FMP 舊專案的 `lib/data/sources/bilibili_source.dart` 為規格，改用 JS 重寫。

## 能力

- `search`：搜尋影片（`/x/web-interface/search/type`，綜合排序，每頁 20 筆）。課堂這類不是影片的結果沒有 `bvid`，會被略過，所以一頁可能不到 20 筆。標題會去掉 `<em>` 標籤並解 HTML 實體（命名的與 `&#39;`、`&#x27;` 這類數字的）。封面回傳 `@160w`、`@480w` 兩個縮圖（標寬度）加原圖（不標寬度），宿主依顯示大小挑。
- `login`：QR 碼登入，見下方〈登入〉。
- `resolveStream`：沒給 `cid` 時先以 WBI 簽名呼叫 `/x/web-interface/wbi/view` 取得預設分 P 的 `cid`，再呼叫 `/x/player/playurl`。
  - 優先 DASH 音訊。平台能播的音軌依頻寬由高到低排，`quality` 選中的那一個放最前面：`high` 最高、`low` 最低、`medium` 取中間（第 `⌊n / 2⌋` 個，只有兩個時是低的那個；與舊專案 `selectByQualityLevel` 相同）。其他音軌當備援，先往下降、沒有更低的才往上：接著是比它低的（由高到低），最後是比它高的（由低到高）。例如三軌選 `low` 是低、中、高，選 `medium` 是中、低、高。沒給 `quality` 時當 `high`。每個音軌的主網址排在前面，備用網址排在後面。
  - 沒有平台能播的 DASH 音訊時，改用 durl（影音混流），只取第一段；只有一條，`quality` 不適用。
  - 候選串流只帶 `Referer` 與 `User-Agent`，不帶 Cookie。
  - `expiresAt` 從網址本身讀：upos 取 `deadline`，Akamai 鏡像取 `hdnts=exp=`。

## 登入（QR）

manifest 宣告 `login: { methods: ['qr'] }`（還沒有 `refresh`，刷新之後再加）。流程由宿主驅動：

1. `loginQrStart`：`GET passport.bilibili.com/x/passport-login/web/qrcode/generate`，`data.url` 是 QR 碼內容，`data.qrcode_key` 是 token。
2. `loginQrPoll(token)`：`GET …/web/qrcode/poll?qrcode_key=`，狀態在 `data.code`：`86101` 等待、`86090` 已掃描、`86038` 過期、`0` 成功。成功時憑證的 cookie 取自**這次回應的 `Set-Cookie`**，`refresh_token` 取自 body。
3. `loginVerify(credentials)`：`GET api.bilibili.com/x/web-interface/nav`，自己用傳入的憑證組 `Cookie`（不帶匿名 `buvid*`），請求標 `auth: 'never'`。

- 存的 cookie（只看名稱）：`SESSDATA`、`bili_jct`、`DedeUserID`、`DedeUserID__ckMd5`（可缺）；`extra.refresh_token`（可缺）。值原樣保存，不 URL 解碼。
- 用到的網域：`passport.bilibili.com`（QR 兩個請求）、`api.bilibili.com`（verify）。
- QR 兩個請求不帶任何 cookie、標 `auth: 'never'`。`search`、`resolveStream` 的請求標 `auth: 'userPreference'`：使用者開著「以登入身分瀏覽與播放」時宿主才帶憑證（ADR 0012）。
- `data.code` 為 `0` 卻沒有 `SESSDATA`、`bili_jct`、`DedeUserID`，回 `ParseError`（舊專案在這種情況會假成功）；不認得的 `data.code` 回 `UnexpectedError`，不當成「還在等」。
- `loginVerify` 的頂層 `code`：`-101`、`-111` → `CredentialInvalid`（憑證無效）；其他照下方錯誤對應。沒有 `SESSDATA` 也是 `CredentialInvalid`，不發請求。
- 輪詢逾時、連續錯誤幾次放棄，都是宿主端的事。

## 匿名狀態

- `buvid3`、`buvid4`、`b_nut` 第一次使用時在本機亂數產生，存進插件的 storage，之後的 API 請求以 Cookie 帶上。不另外向 B 站領取。
- WBI 的 `img_key`、`sub_key` 從 `/x/web-interface/nav` 取得（未登入時回 `-101`，但仍附 `wbi_img`），存進 storage，北京時間換日後重新取得。

## 錯誤對應

| B 站回應 | FMP 錯誤 |
|---|---|
| HTTP 412；業務碼 `-352`、`-412`、`-509`、`-799`（風控） | `RateLimited` |
| HTTP 5xx；業務碼 `-503` | `NetworkError` |
| 業務碼 `-101`、`-111`（csrf 驗證失敗）、`-403` | `AuthRequired`（`loginVerify` 的 `-101`、`-111` 改為 `CredentialInvalid`） |
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

指令見 repo 根目錄的 `README.md`。錄製會真的連 B 站：`search` 發 1 個請求，`resolveStream` 發 3 個（nav、view、playurl）。`login` 的案例標 `requiresLogin`，命令列錄製略過；它的 fixture（`fixtures/login/001.json`）是手寫的（`meta.edited`），憑證與帳號都是假的，body 的形狀照 nav 的真實回應。

## 測試

`npm test`（`node --test`，不需要安裝依賴）測 `test/` 裡的純函式與以假宿主 API 跑的登入流程：實體解碼與封面尺寸（`helpers.test.js`），QR 狀態碼、`Set-Cookie` 解析、缺 cookie、verify 對應與請求形狀（`login.test.js`，cookie 值都是 `fake-…`）。`bilibili.js` 匯出 `decodeHtmlEntities`、`artwork`、`parseSetCookies`、`qrCredentials`、`verifyCookie` 只為了這個；宿主只認能力名稱的匯出，其他名稱忽略。
