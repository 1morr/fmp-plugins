# bilibili

B 站音源，可匿名使用，也可用 QR 碼登入（啟動時自動刷新憑證）。行為以 FMP 舊專案的 `lib/data/sources/bilibili_source.dart` 為規格，改用 JS 重寫。

## 能力

- `search`：搜尋影片（`/x/web-interface/search/type`，綜合排序，每頁 20 筆）。課堂這類不是影片的結果沒有 `bvid`，會被略過，所以一頁可能不到 20 筆。標題會去掉 `<em>` 標籤並解 HTML 實體（命名的與 `&#39;`、`&#x27;` 這類數字的）。封面回傳 `@160w`、`@480w` 兩個縮圖（標寬度）加原圖（不標寬度），宿主依顯示大小挑。
- `multiPart`：影片的分 P 列表，`GET api.bilibili.com/x/player/pagelist?bvid=<bvid>`（舊專案取 `view` 的 `pages`；改走 pagelist 是因為舊專案實測它匿名也是 200，且不必簽 WBI，一個請求就夠），請求標 `auth: 'userPreference'`。回應 `data` 是陣列，每筆 `cid`、`page`（→ `index`，從 1）、`part`（→ `title`，去掉頭尾空白；空的或不是字串時用 `P<index>`）、`duration`（秒 → `durationMs`，缺或非整數就不給）。`sourceId` 不是 `BV` 加 10 個英數字就是 `ParseError`，不發請求；沒有分 P 回 `NotFound`；`data` 不是陣列或任何一筆的 `cid` 不是正整數是 `ParseError`（形狀變了不悄悄少一筆）；業務碼照〈錯誤對應〉。回應形狀已對過一次真實匿名回應（`cid`、`ctime`、`dimension`、`duration`、`first_frame`、`from`、`page`、`part`、`vid`、`weblink`）。搜尋回應現在沒有每筆的 `page`（2026-10 的 search fixture 也沒有），所以 `partCount` 多半不給；宿主把它當提示，不知道時也讓使用者展開。
- `trackDetail`：影片詳細，`GET api.bilibili.com/x/web-interface/wbi/view?bvid=<bvid>`（WBI 簽名，與 `resolveStream` 取 `cid` 是同一個請求，共用 `viewData`；不含熱門評論，design §16 第 13 條）。回 `description`（`desc`，去頭尾空白，空的或 B 站當佔位的 `-` 不給）、`publishedAt`（`pubdate` 秒 → 毫秒，非正整數不給）、`uploaderAvatar`（`owner.face`，格式同 `search` 的封面：`@160w`、`@480w` 加原圖，不在 `hdslb.com` 的不給）、`stats`（`stat` 的 `view`、`like`、`favorite`、`reply`→`comment`、`share`、`danmaku`、`coin`；值不是非負整數，例如被隱藏時的 `"--"`，就略過那一項，不補 0；一項都沒有就不給 `stats`）。`allowedHosts` 不變（`api.bilibili.com`、`hdslb.com` 本來就有）。`cid` 不參與（簡介與統計是整支影片的），給了要是正整數。`sourceId` 不是 `BV` 加 10 個英數字或 `cid` 不合法是 `ParseError`，不發請求；請求標 `auth: 'userPreference'`；業務碼照〈錯誤對應〉。
- `search` 的 `partCount`：搜尋結果每筆的 `page`（分 P 數）是正整數才給，否則省略。
- `login`：QR 碼登入與憑證刷新，見下方〈登入〉〈刷新〉。
- `live`：直播間，四個匯出，見下方〈直播〉。
- `resolveStream`：沒給 `cid` 時先以 WBI 簽名呼叫 `/x/web-interface/wbi/view` 取得預設分 P 的 `cid`，再呼叫 `/x/player/playurl`。
  - 優先 DASH 音訊。平台能播的音軌依頻寬由高到低排，`quality` 選中的那一個放最前面：`high` 最高、`low` 最低、`medium` 取中間（第 `⌊n / 2⌋` 個，只有兩個時是低的那個；與舊專案 `selectByQualityLevel` 相同）。其他音軌當備援，先往下降、沒有更低的才往上：接著是比它低的（由高到低），最後是比它高的（由低到高）。例如三軌選 `low` 是低、中、高，選 `medium` 是中、低、高。沒給 `quality` 時當 `high`。每個音軌的主網址排在前面，備用網址排在後面。
  - 沒有平台能播的 DASH 音訊時，改用 durl（影音混流），只取第一段；只有一條，`quality` 不適用。
  - 候選串流只帶 `Referer` 與 `User-Agent`，不帶 Cookie。
  - `expiresAt` 從網址本身讀：upos 取 `deadline`，Akamai 鏡像取 `hdnts=exp=`。

## 直播

`live` 能力的四個匯出（`liveSearch`、`liveRoomFromUrl`、`liveStatus`、`resolveLive`），行為以舊專案 `bilibili_live_client.dart` 為規格。請求一律標 `auth: 'userPreference'`（FMP ADR 0012 §決定 2「電台」）；直播 API 的 `Referer` 是 `https://live.bilibili.com/`。

- `liveSearch`：沿用舊專案 `searchRooms` 的語意，`status` 決定搜什麼。
  - `live`：**直播間搜尋**，`/x/web-interface/search/type?search_type=live_room`（每頁 20 筆），只回開播中的房間，每筆 `status` 都是 `live`。標題與主播名去掉 `<em>` 並解實體。
  - `offline` 與 `null`（全部）：**主播名搜尋**，`search_type=bili_user`，留下 `mid`、`room_id` 都大於 0 的主播，再用**一個**批次請求補房間狀態：`GET https://api.live.bilibili.com/room/v1/Room/get_status_info_by_uids?uids%5B%5D=<mid>&uids%5B%5D=<mid>…`（重複的 `uids[]`，編碼成 `uids%5B%5D`，宿主的 `Uri.parse` 本來也會這樣送；整頁的 `mid` 一次問；舊專案是每位主播一個 `get_info`）。回應 `data` 以 `mid` 字串為鍵，取 `room_id`、`title`、`live_status`、`online`、`cover_from_user`（沒有時 `keyframe`）。`offline` 只留未開播的，`null` 兩種都留（舊專案是 live_room 與 bili_user 兩路合併，bili_user 這路已涵蓋開播中的主播）。主播名用搜尋結果的 `uname`，空的才用批次回應的 `uname`。`hasMore` 由 `numResults` 算，同 `search`。
  - 批次回應裡沒有的 `mid` 直接略過（debug log），不猜狀態；批次請求失敗、某筆缺 `title`／`room_id`、`uid` 與鍵對不上、或 `live_status` 不認得，整個 `liveSearch` 拋錯，不回部分結果。
  - `data` 不是以 `mid` 為鍵的物件（例如 PHP 的空 map `[]`），或問到的 `mid` 一個都不在裡面，是 `ParseError`，不當成空頁：形狀變了不能悄悄變成「沒有結果」。沒有可問的主播時不發批次請求，直接回空頁。
  - 批次端點的形式（GET、以 `mid` 字串為鍵、每筆的 `room_id`、`title`、`live_status`、`online`、`cover_from_user`、`keyframe`、`uid`、`uname`）對過一次真實的匿名回應；一個都對不上時回不回 `[]` 沒驗證過。
- `liveRoomFromUrl`：不連網，只認 `live.bilibili.com/<數字>` 與 `live.bilibili.com/h5/<數字>`（`http`／`https` 可省，後面接結尾、`/`、`?`、`#` 或空白），規則同舊專案 `parseLiveUrl`，只多一條：前面不准緊接 `/`（`https://evil.example/live.bilibili.com/1` 的網域不是 B 站，舊專案會認）；其他一律 `null`。不處理短連結（舊專案也沒有）。回的 `roomId` 是網址裡的號碼，可能是短號，`liveStatus`、`resolveLive` 各自用 `room_init` 換成真實房號；`liveStatus` 回的 `roomId` 是真實房號（舊專案同）。
- `liveStatus`：`room_init`（短號 → 真實房號）、`get_info`（標題、封面、人數、`live_status`）、`get_anchor_in_room`（主播名），三個請求都在 `api.live.bilibili.com`。主播名（`hostName`，契約裡選填）查不到（請求失敗、業務碼不是 0、沒有 `uname`）時照樣回房間資料、不給 `hostName`，只寫一筆 warning。`live_status` `1` → `live`，`0` 與 `2`（輪播）→ `offline`，其他值或缺 → `ParseError`。封面取 `user_cover`、沒有時取 `keyframe`，格式同 `search` 的封面。**查詢失敗一律拋錯，絕不回 `offline`**（FMP design D10）：HTTP 非 200、不是 JSON、業務碼不是 0、`title` 不是字串、缺 `live_status`，全都拋。房間不存在（`room_init` 的 `60004`）→ `NotFound`（`60004` 的意義來自記憶，還沒在真實回應上看過）。
- 標題是空字串（去掉標籤與空白後）時三處都換成 `Unknown`，同 `search`：宿主拒收空白標題，`liveSearch` 會整頁被拒。主播名空的不給。
- `resolveLive`：`room_init` 後呼叫 `/room/v1/Room/playUrl?cid=<真實房號>&platform=web&quality=2&qn=80`，取第一個 `durl`；它的 `backup_url` 排在後面當備援。網址不在 `allowedHosts` 的丟掉並寫 warning，全被丟掉回 `Unavailable`；沒有 `durl` 回 `NotFound`。候選只帶 `Referer`（`live.bilibili.com`）與 `User-Agent`；`container`、`codec` 不標，`formats` 不參與挑選。`expiresAt` 照 `resolveStream` 從網址讀 `deadline`／`hdnts=exp=`，讀不到是 `null`。

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
| 業務碼 `-404`、`62002`、`62004`、`62012`、`60004`（直播間不存在） | `NotFound` |
| 業務碼 `-10403` | `Unavailable`（`region`） |
| 業務碼 `87007`、`87008` | `Unavailable`（`membership`） |
| 不是 JSON、缺 `data` 或 `cid`；nav 回 `0` 或 `-101` 卻沒有 `wbi_img` | `ParseError` |
| 其他狀態碼與業務碼 | `UnexpectedError` |

HTTP 429 由 FMP 的網路層轉成 `RateLimited`。DASH 以 `NotFound` 或 `Unavailable` 失敗時會改試 durl。

## 已知限制

- 不登入時拿不到需要登入或大會員的音質（Hi-Res、杜比）。匿名身分被風控（`-352`）時只會回 `RateLimited`；登入後開著「以登入身分瀏覽與播放」可能緩解。登入後的取流行為（含 `dash.flac`）還沒有處理。
- `resolveStream` 沒給 `cid` 時只取 `view` 回傳的預設分 P；其他分 P 由呼叫端先用 `multiPart` 取得 `cid` 再給。
- `allowedHosts` 列了 `bilivideo.cn`：B 站的 PCDN（`*.mcdn.bilivideo.cn`）在部分網路會出現，但這次錄製沒遇到。網域不在清單內的串流網址（例如其他 PCDN 網域、直接寫 IP 的節點）會被丟掉，並寫一筆 warning log；一個音軌的網址全被丟掉時，那個音軌就不會出現在候選裡。
- fixture 裡串流網址的簽名參數（`upsig`、`e`、`uparams` 等）已經遮蔽，`deadline` 留著（公開的到期時間，FMP 的遮蔽名單不遮它）。`checks.json` 的 `expiresAtPattern` 讓契約檢查核對每個候選的 `expiresAt` 與網址裡的期限一致；Akamai 鏡像的 `hdnts` 整段遮掉（含 `hmac`），沒有 `deadline` 的那種網址重播時 `expiresAt` 是 `null`，不在核對範圍內。
- `quality` 的選擇沒有自動測試：契約每個能力只有一條檢查案例（`high`）。改它時以 fixture 的 playurl 回應另外跑過 `low`、`medium`。

## 契約測試與錄製

指令見 repo 根目錄的 `README.md`。錄製會真的連 B 站：`search` 發 1 個請求，`trackDetail` 發 2 個（nav、`wbi/view`；案例的 `sourceId` 與 `resolveStream` 相同，`BV1xx411c79H`；每次錄製 storage 是新的，所以要先取 WBI key），`multiPart` 發 1 個（`pagelist`；案例的 `sourceId` 是 `BV1YmHx6QEV6`，2026-10 時有 9 個分 P；下架或剩不到 2 個分 P 時換一支），`resolveStream` 發 3 個（nav、view、playurl），`live`（跑 `liveStatus`，房號 `1` 是短號）發 3 個（匿名 cookie 不發請求；`room_init`、`get_info`、`get_anchor_in_room`）。`resolveLive`、`liveSearch`、`liveRoomFromUrl` 沒有契約案例（每個能力一條），只有單元測試。`login` 的案例標 `requiresLogin`，命令列錄製略過（`loginRefresh` 沒有契約案例，每個能力只有一條，ADR 0015）；它的 fixture（`fixtures/login/001.json`）是 2026-10-15 在 FMP 的插件開發工具以測試帳號登入後錄的（FMP #254），再刪減成只剩 `loginVerify` 讀的欄位（`meta.edited`）；憑證、`mid`、`uname`、頭像都是 `***`。

## 打包

```sh
cd bilibili
npm ci
node build.mjs   # 輸出 bilibili.js（不壓縮，內容固定）
npm test
```

用 esbuild 把 `src/` 與 `bn.js` 打成單一檔，`bilibili.js` 與原始碼、`package-lock.json` 一起提交；index 只認這一個 `.js`。`manifest` 寫在 `build.mjs`。改 `src/` 後要重打包，否則發佈的 `bilibili.js` 不含改動。

## 測試

`npm test`（`node --test`，要先 `npm ci`）測 `test/` 裡的純函式與以假宿主 API 跑的流程：實體解碼與封面尺寸（`helpers.test.js`）；QR 狀態碼、`Set-Cookie` 解析、缺 cookie、verify 對應與請求形狀（`login.test.js`）；SHA-256、MGF1、RSA-OAEP 以 `node:crypto`（`privateDecrypt`，`oaepHash: 'sha256'`，測試自己生的金鑰）獨立驗證、寫死的公鑰等於舊專案的，以及打包檔不得出現 `BigInt`、`TextEncoder`、`crypto.subtle`、`getRandomValues` 且在 `BigInt` 被清掉時仍能載入（`oaep.test.js`）；憑證無效的判定表與 `loginRefresh` 的 5 步和各種失敗（`refresh.test.js`）；`trackDetail` 的對應、省略、非法 stat、輸入驗證、錯誤與 `auth`（`track_detail.test.js`）；`multiPart` 的對應（含錄下的 pagelist 回應）、錯誤、無效 bvid 不發請求、`userPreference`，與 `search` 的 `partCount`（`multipart.test.js`）；直播的欄位對應、狀態篩選、批次回應的形狀（`[]`、`{}`、鍵對不上都拋 `ParseError`）、空標題、網址解析與反例（含網域偽裝）、D10（失敗一律拋錯）、playUrl 取第一段、`userPreference`（`live.test.js`）。cookie 與 token 的值都是 `fake-…`。`src/plugin.js` 匯出 `decodeHtmlEntities`、`artwork`、`parseSetCookies`、`qrCredentials`、`verifyCookie`、`credentialsRejected`、`refreshCsrfOf` 只為了這個；宿主只認能力名稱的匯出，其他名稱忽略。
