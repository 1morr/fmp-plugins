# youtube

YouTube 音源，匿名可用，也可以登入。以 [YouTube.js](https://github.com/LuanRT/YouTube.js)（`youtubei.js` 18.1.0）為底，esbuild 打成單一檔 `youtube.js`；可行性驗證見 FMP 的 M1 探針報告（`.trellis/tasks/archive/2026-09/09-30-youtubejs-probe/research/youtubejs-probe.md`）。

## 能力

- `search`：搜尋影片（`yt.search`，type 為 video）。只收影片；頻道、播放清單、Shorts 欄位，以及沒有長度的直播與首播都略過，所以一頁可能不到 20 筆。續頁只接得在同一個關鍵字的上一頁後面（continuation 存在記憶體，插件重啟後第 2 頁起回空）。
- `resolveStream`：不需要 PO token，player 請求一律不帶登入憑證（見「登入」）。依序試 `VISIONOS`、`IOS` 兩個 client，取第一個有音訊的（`ANDROID_VR` 自 2026-08-26 起沒帶 token 只給約 60 秒，不用）。
  - 只取純音訊的 adaptive format；多語言配音的影片只留預設音軌。網址是明文，不需要下載 player JS（`retrieve_player: false`）。
  - 候選依 `formats` 的先後分組（使用者的格式偏好），同一組內依 `quality` 排：選中的在最前面（`high` 最高碼率、`low` 最低、`medium` 取中間 `⌊n / 2⌋`），接著是比它低的（由高到低），最後是比它高的（由低到高）。平台不能播的格式不出現。
  - 候選不帶 header：不帶 Cookie，googlevideo 也不需要 Referer。
  - `expiresAt` 從網址的 `expire` 參數讀（unix 秒 → 毫秒）。`expire` 不在 FMP 的遮蔽名單內，fixture 裡留著，`checks.json` 的 `expiresAtPattern` 核對它。
- `mix`：以一首曲目開始 Mix（YouTube 的 `RD<videoId>` 播放清單），`{seed:{sourceId}}` 開始、`{mixId, cursor}` 續取。`mixId` 就是 `RD<videoId>`，整個 Mix 不變。
  - 直接 POST innertube `/next`（WEB client）並讀原始 JSON，同舊版 `youtube_source.dart` 的請求。不用 `getInfo`／`music.getUpNext`：`getInfo` 會解析整個觀看頁，而這裡只要 `playlist.playlist`；`music.getUpNext` 是 YTMUSIC client，網域是 `music.youtube.com`，不在 `allowedHosts`。
  - 開始：body `{videoId, playlistId: 'RD<id>', racyCheckOk, contentCheckOk}`，回應 `playlist.playlist` 約 25 首。
  - `cursor`（不透明字串，`null` 表示沒有更多，宿主改以最後一首當種子再開一批）只有插件自己的 `v1:<最後一首的 videoId>:<它的索引>`，續取送 `{videoId: <最後一首>, playlistId, playlistIndex: <索引>}`，丟掉視窗裡到最後一首為止的曲目，一首新的都沒有就回 `tracks: []`、`cursor: null`。索引以視窗裡 `selected` 那首的 `currentIndex` 推算，算出來不在 0–999999（cursor 的格式上限）時不給 cursor。回應裡的 `continuations` 不用：匿名 WEB 的回應沒有（2026-10 實測，`fixtures/mix/003.json`），YouTube token 的續取也沒有驗證過。
  - 曲目欄位同 `search`（只收有長度的影片，直播與首播略過，縮圖只留 `ytimg.com`），一批內以 `sourceId` 去重；跨批去重由宿主做。`title` 取回應的播放清單標題，沒有就是 `Mix`（宿主只在 `mixId` 換了才換標題）。
  - 錯誤：開始時影片沒有 Mix 或第一批一首都不能播 → `NotFound`；續取的回應沒有播放清單不算錯，回空的一批與 `cursor: null`，讓宿主換種子（丟錯的話 cursor 停在原地，宿主不會換種子，Mix 就停了）。輸入不合法（`sourceId` 不是 11 碼、`mixId` 不是 `RD` 開頭、`cursor` 不是 `v1:` 格式）→ `ParseError`，不發請求；回應形狀不對也是 `ParseError`。HTTP 4xx 同 `search`，YouTube.js 丟例外，由宿主轉成 `UnexpectedError`。
  - 2026-10 實機（匿名）：25 首的 Mix 跳到第 24 首，以 `v1:…:24` 續取回 24 首新的、`mixId` 不變、cursor 前進到 `:48`，共 2 個 `/next`。
- `trackDetail`：影片詳細，POST innertube `/next`（WEB client，`{videoId, racyCheckOk, contentCheckOk}`，不帶 `playlistId`）並讀原始 JSON，**一個請求**（`src/track_detail.js`）。不用 `getInfo`：它是 `/player` 加 `/next` 兩個請求，而 `/player` 沒有頭像與按讚數，`/next` 本來就帶簡介、日期、頭像、觀看與按讚數；`fixtures/mix/003.json` 就是一份真實的 WEB `/next` 回應，欄位路徑照它定。請求與 `search` 一樣標 `idempotent: true` 與 `auth: 'userPreference'`（WEB client 收 cookie），錯誤對應也相同。
  - `description`：`videoSecondaryInfoRenderer.attributedDescription.content`，沒有時用 `description.runs`，去頭尾空白，空的不給。
  - `uploaderAvatar`：`videoOwnerRenderer.thumbnail.thumbnails`，只留 `https` 且在 `ggpht.com`、`ytimg.com` 的（`allowedHosts` 不變，`yt3.ggpht.com` 在 `ggpht.com` 之下）。
  - `stats`：`view`（`videoViewCountRenderer.originalViewCount`，沒有時讀 `1,234 views` 這種完整數字；直播中（`isLive`）顯示的是正在觀看人數，不給）與 `like`（`likeCountEntity.likeCountIfIndifferentNumber`，沒有時讀 `expandedLikeCountIfIndifferent` 的完整數字；登入且按過讚（`likeStatusEntity.likeStatus` 是 `LIKE`）時改讀 `IfLiked` 那一組，與 YouTube 顯示的相同）。縮寫（`19M`）、`No views`、按讚數被隱藏都略過，不補 0。**沒有 `comment`**：回應裡的留言數只有縮寫（`2.4M`）；`share`、`favorite`、`danmaku`、`coin` YouTube 沒有。
  - `publishedAt`：回應只有 `dateText` 的英文日期（`Oct 25, 2009`，也接 `Premiered …`、`Streamed live on …`），沒有時刻與時區，所以取當天 UTC 正午，只精確到日（宿主以本機時區顯示：取零點的話 UTC 以西會顯示成前一天，正午在 UTC−12 到 UTC+11 都是同一天）；格式不認得或不是真的日期（`Feb 31`）就不給。`hl` 不是插件指定的：YouTube.js 建 session 時以 `Accept-Language: en-US` 取 `sw.js_data`，YouTube 回 `hl` `en`（fixture 裡是 `en`、`gl` 是錄製地的 `TW`），session 存進 storage 沿用；哪天回了別的語言，日期格式認不得，`publishedAt` 就不給，不會給錯的日期。ISO 時間在 `/player` 的 `microformat`，要多一個請求，沒採用。
  - 輸入：`sourceId` 不是 11 碼 → `ParseError`，不發請求；`cid` 不參與。回應沒有 `contents` → `ParseError`；有 `contents` 卻沒有任何影片資訊 renderer → `NotFound`（影片不存在或已刪除的實際回應形狀**沒有實測**，是依 `mix` 同類判斷推的）。

- `importPlaylist`：匯入 YouTube 播放清單，兩個匯出（FMP ADR 0032 §決定 2）。請求與解析在 `src/playlist.js`。
  - `playlistFromUrl({url})`：不發請求。網域限 `youtube.com`、`www.`、`m.`、`music.youtube.com`、`youtu.be`（舊版 `SourceUrlPolicy.youtubeHosts`），沒有 `://` 的輸入當成 https；取 `list=` 參數（`/playlist?list=…`、`watch?v=…&list=…`、`youtu.be/…?list=…` 都是）。`list` 以 `RD` 開頭是 Mix，回 `{mixSeed: {sourceId}}`，種子取 `v`，沒有就取 `RD` 後面的；`mix:<id>` 簡寫（不分大小寫，id 只收 `[A-Za-z0-9_-]`、至多 64 字，舊版 `youtube_mix_shorthand.dart`）同樣回 `mixSeed`。其餘回 `{playlistId}`，不認得回 `null`。種子是否為 11 碼影片 id 由 `mix` 檢查（不是就 `ParseError`）。
  - `importPlaylist({playlistId, cursor?})`：POST innertube `browse`（WEB client），第一頁 `{browseId: 'VL<playlistId>'}`，續取 `{continuation: <token>}`；與 `search` 同樣標 `idempotent: true`、`auth: 'userPreference'`。`playlistId` 以 `RD` 開頭（Mix）或不合法 → `ParseError`，不發請求。
  - **回應形狀與舊版不同**（2026-10-15 匿名實測，Flutter 官方頻道的 181 部公開歌單）：項目是 `lockupViewModel`，不是舊版 `_parsePlaylistViaInnerTube` 認的 `playlistVideoRenderer`（舊版匿名失敗時回退 `youtube_explode_dart`，所以沒看出來）。第一頁 100 部，`tabs[0]…sectionListRenderer.contents[0].itemSectionRenderer.contents` 是 100 個 `lockupViewModel` 加最後一個 `continuationItemViewModel`；第二頁 81 部，在 `onResponseReceivedActions[0].appendContinuationItemsAction.continuationItems`，沒有 continuation 就是最後一頁。`sectionListRenderer.contents` 的最後還有一個 `continuationItemViewModel`，那不是這張歌單的下一頁，不用。
  - `track`（欄位同 `search`）：`sourceId`＝`contentId`；`title`＝`metadata.lockupMetadataViewModel.title.content`；`uploader`＝`metadataRows[0].metadataParts[0].text.content`；`durationMs` 讀縮圖角標 `thumbnailBottomOverlayViewModel.badges[].thumbnailBadgeViewModel.text`（`m:ss`、`h:mm:ss`），角標不是時長（直播、首播、`SHORTS`）或沒有角標的略過；`artwork` 取 `contentImage.thumbnailViewModel.image.sources`，只留 `ytimg.com`。`contentType` 不是影片的略過。同一支影片出現兩次就是兩項，不去重。若某一項是舊版的 `playlistVideoRenderer`（例如帶登入時），也認，欄位規則同舊版（`isPlayable` 為 `false` 或沒有長度的略過）；為它不另發請求。
  - `playlist`（每頁都要給）：`title` 依序取 `pageHeaderRenderer.pageTitle`、標頭 `dynamicTextViewModel`、`metadata.playlistMetadataRenderer.title`；`description` 取 `playlistMetadataRenderer.description`；`artwork` 用第一首的縮圖（舊版 `coverUrl` 也是，標頭沒有可靠的欄位）；`ownerName` 取標頭 `metadataRows` 裡帶頭像的那一格文字 `by Flutter`，去掉 `by `，沒有這個前綴（YouTube 回非英文時）就不給。後續頁的回應沒有標頭，歌單資料因此放在 `cursor` 裡。
  - `cursor`：不透明字串，`v1:<URL 編碼的 JSON {p: 歌單資料, r: 是否以 required 讀到的}>:<YouTube 的 continuation token>`；最後一頁 `null`。讀回時只收 `p` 的 `title`（不空）、`description`、`artwork`（只留 `ytimg.com`）、`ownerName`，`r` 只認 `true`；格式不對 → `ParseError`，不發請求。cursor 不綁 `playlistId`（token 本身帶歌單），宿主原樣傳回；改 `r` 最多讓續取以 `required` 送到 YouTube，憑證不會送到別處。
  - **不給 `total`**：標頭筆數含被隱藏的影片（YouTube 另標「N 部影片已隱藏」），給了會讓每次刷新都「部分完成」。實測這張歌單標頭 181、實際回 181，沒有被隱藏的影片，但不能因此給 `total`。
  - **不給 `remoteItemId`**：匿名回應完全沒有 `setVideoId`（兩頁 181 項的原始 JSON 搜尋 0 次）。只有登入才給的話，切換「以登入身分瀏覽與播放」會讓宿主的比對鍵在有 id、沒 id 兩池之間跳，所以一律不給，即使回應裡出現 `setVideoId` 也不給。移除遠端項目（FMP M4 PR 14）改用影片 id。
  - **不給 `unavailable`**：匿名回應看不到失效項（私人、已刪除）的形狀，未實作；沒有證據就不猜。**不給 `writable`**：匿名判斷不了，回應裡沒有 `isEditable`；帶憑證時的判斷留到 FMP M4 PR 13 實測。
  - **私人歌單**：請求一律 `userPreference`。第一頁被拒（HTTP 401／403／404，或回應沒有項目區塊）、這次沒帶憑證（`credentialsAttached` 為假）、`fmp.credentials.get()` 不是 `null` 時，以 `required` 重送同一個請求一次；已帶憑證被拒、或重送後還被拒都不再送。靠重送讀到的歌單，後續頁也以 `required` 送（記在 cursor 的 `r`）。續取頁同樣的規則。為了知道每次請求的狀態與有沒有帶憑證（YouTube.js 遇到 4xx 直接丟例外），請求帶一個只在插件內用的 header `x-fmp-call`，`src/host_request.js` 讀了就拿掉，不會送出。
  - **錯誤**：被拒且（重送後）仍讀不到：HTTP 401／403，或 200 回應的 alert 提到 `private`、`sign in`、`log in`，且最後一次請求沒帶憑證 → `AuthRequired`；其餘 → `NotFound`（歌單不存在、HTTP 404、已帶憑證仍沒權限）。4xx 的 body 被 YouTube.js 包進例外，不讀。帶了憑證的 HTTP 401 照「憑證無效」判定表是 `CredentialInvalid`（`src/host_request.js` 在 YouTube.js 之前丟），不是 `NotFound`。回應形狀不對（沒有標題、續取沒有項目）→ `ParseError`。其他 HTTP 4xx／5xx 同 `search`，YouTube.js 丟例外，由宿主轉成 `UnexpectedError`。**未實測**：匿名讀不存在的歌單與私人歌單的實際回應（HTTP 狀態與 alert 文字），所以這幾個判斷是照舊版與 YouTube.js 的行為推的；`test/import_playlist.test.js` 用手寫的 alert 與 403 守邏輯。
  - 實測（2026-10-15，匿名，Windows，Node 模擬宿主）：歌單 `PLjxrf2q8roU23XGwz3Km7sQZFTdB996iG`（Flutter 官方頻道的 "Flutter Widget of the Week"）標頭 181 部，兩頁 100 加 81 共 181 筆，差 0，`setVideoId` 0/181。請求 4 個：`sw.js_data`、`config`、第一頁、第二頁。

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

- innertube 的 POST（搜尋、player、mix 的 `/next`、config）都是查詢，標 `idempotent: true`，暫時失敗時由網路層重試（FMP ADR 0028）。
- `Innertube.create` 的會話資料（visitor data 等）存在插件的 storage，之後的啟動不再打 `sw.js_data` 與 `config`。
- QuickJS 沒有 Web API：`src/shims.js` 以 `fmp.http.request` 為底補上 fetch、Headers、Request、Response，並補 URL、TextEncoder/TextDecoder、crypto、atob/btoa、timers。宿主 API v1 只傳字串 body，二進位的 request body 一律拋錯。
- 宿主的網路紀錄沒有 body：innertube 回 4xx／5xx 時插件另記一筆 warn（`innertube error`），只含路徑、client 名稱、有沒有帶憑證，以及 Google API 錯誤物件的 `status` 與 `message`。

## 已知限制

- 年齡限制與會員影片播不了，登入也一樣：player 請求不帶憑證（見「登入」）。匿名身分被要求驗證時只會回 `VerificationRequired`。
- 哪個 client 能用由 YouTube 決定，`VISIONOS` 也可能被加上同樣的限制。換 client 只要改 `src/clients.js` 的 `CLIENTS` 並重新打包，不必發新版 App；新 client 收不收 cookie 要對 `COOKIELESS_CLIENT_NAMES`。
- 一個 `checks.json` 每個能力只有一條案例，所以契約測試只重播成功的 `search`、`resolveStream`、`mix`、`trackDetail`、`importPlaylist` 與 `login`；上表的錯誤對應由 `test/errors.test.js` 以 YouTube 實際給的 `playabilityStatus` 文字守（`npm test`）。player 請求不用 YouTube.js 的 `getBasicInfo`：它遇到 `ERROR` 直接拋例外，走不到 `NotFound`；`test/resolve.test.js` 以錄好的 fixture 跑整條 `resolveStream` 守這點；`test/mix.test.js` 以手寫與錄好的（`fixtures/mix/003.json`）`/next` 回應跑整條 `mix`；`test/track_detail.test.js` 以同一份錄好的 `/next` 加手寫變體跑整條 `trackDetail`（欄位對應、省略、直播與按過讚的計數、日期的時區、輸入驗證、錯誤、`idempotent` 與 `auth`）；`test/import_playlist.test.js` 以 `fixtures/importPlaylist/003.json`（第一頁）、`test/data/playlist-page2.json`（續取頁）加手寫變體跑整條 `importPlaylist`（網址辨識、`mixSeed`、解析、續取、略過、cursor 驗證、私人歌單重送 `required` 的各種情況（含續取頁）、`x-fmp-call` 不送出、錯誤對應）（測試裡用 esbuild 在記憶體打包 `src/`）。
- fixture 裡有匿名的 `visitorData` 與 `x-goog-visitor-id`（YouTube 發的匿名識別，不是憑證）。
- 錄製者的公網 IP 會出現在 `sw.js_data` 回應、請求 body 的 `remoteHost`、`hlsManifestUrl` 路徑的 `/ip/…/`：FMP 的錄製器把 fixture 裡的 IP 一律換成文件用位址，掃描也會擋（FMP `app/test/plugins/contract/ip_scrub.dart`）。`hlsManifestUrl` 路徑式的 `/sig/…/`、`/lsig/…/` 遮蔽名單遮不到，現有 fixture 已手動換成 `***`（已過期、重播只比對方法與網址）；重錄後要再換一次。

## 登入

宣告 `login` 能力，方式是 App 內網頁登入（`webView`）與貼上 cookie（`cookie`）；`automationRisk: true`（以登入身分大量請求可能被視為自動化行為，推測）。

- 登入頁 `https://accounts.google.com/ServiceLogin?service=youtube&continue=https://www.youtube.com/`，從 `https://www.youtube.com` 取 cookie，下列三個都出現就算完成：`SAPISID`、`__Secure-1PSID`、`__Secure-3PSID`。貼上 cookie 時這三個也是必要的。
- `loginVerify(credentials)`：以傳進來的 cookie 自己組 `Cookie`，加上 `Authorization: SAPISIDHASH …`，`auth: 'never'` 打一次 innertube `account/account_menu`（R1 實測過會回帳號區塊）。取選中的帳號（`isSelected`，沒有就第一個）：名稱 → `displayName`，頭像 → `avatar`（只留 `ggpht.com`、`ytimg.com`，其餘網域不在 `allowedHosts`），`userId` 依序取回應裡的 datasync id（純數字）、頻道 handle、帳號名稱。缺必要 cookie、HTTP 401、或回應沒有帳號項（登出狀態）都是 `CredentialInvalid`。
- `SAPISIDHASH`：`SHA1("{秒} {SAPISID} https://www.youtube.com")`，算法同舊版 `lib/services/account/youtube_credentials.dart`；宿主的 `fmp.crypto` 沒有 SHA-1，所以 `src/sapisid.js` 自己實作（`test/sapisid.test.js` 對 `node:crypto`）。innertube 請求（`/youtubei/`）標 `auth: 'userPreference'` 並附 `authHeaders`（`Authorization`、`X-Origin`）；宿主只在已登入且「以登入身分瀏覽與播放」開著時才帶 Cookie 與這兩個 header，其餘情況丟掉。`sw.js_data` 不標，避免匿名 visitor data 被快取成某個帳號的。
- 不收 cookie 的 client（請求 body 的 `clientName` 是 `VISIONOS`、`iOS`、Android 系，`src/clients.js`）不標：2026-10-10 Windows 實測，`VISIONOS` 的 player 帶 Cookie 與 `SAPISIDHASH` 回 HTTP 400 `INVALID_ARGUMENT`（「Request contains an invalid argument.」），yt-dlp 也把這些 client 標成不支援 cookie。所以登入只影響搜尋、Mix 與帳號資訊，`resolveStream` 的 player 請求都是匿名的。
- 收 cookie 的 client 同日實測都不能用：`WEB_EMBEDDED`（帶嵌入頁的 `encryptedHostFlags`）回 `ERROR`「This video is unavailable」，`TV` 回 `UNPLAYABLE`「The page needs to be reloaded.」（yt-dlp #17389）。它們的網址還要下載並解析 player JS 解 n／簽章（QuickJS 裡首次約 10 秒）。
- 憑證無效：回應的 `credentialsAttached` 為 `true` 且 HTTP 401 → `CredentialInvalid`（`src/errors.js` 的 `credentialInvalidError`）；沒帶憑證的 401、403、429 維持原本的處理。沒有宣告 `refresh`（Cookie 有效期約兩年）。
- `account_menu` 的真實回應（2026-10-15 以測試帳號實測）：目前帳號在 `activeAccountHeaderRenderer`，那裡沒有 `datasyncIdToken` 也沒有 `channelHandle`，所以 `userId` 退回帳號名稱，改名後會被當成另一個帳號。回應另一處（`responseContext`）有 `datasyncId`，要改取法時再決定。

## 打包

```sh
cd youtube
npm ci
node build.mjs   # 輸出 youtube.js，內容固定（同樣的輸入產生同樣的檔案）
npm test         # 錯誤對應表的測試（node:test）
```

`youtube.js` 與原始碼（`src/`）、`package-lock.json` 一起提交；index 只認這一個 `.js`。`youtubei.js`、`esbuild`、`core-js` 的版本釘死在 `package.json`，升版後要重新打包並重錄 fixture。`manifest` 寫在 `build.mjs`。

## 契約測試與錄製

指令見 repo 根目錄的 `README.md`。錄製會真的連 YouTube：每個案例各發 3 個請求（`sw.js_data`、`config`，再來 `search`、`player` 或 `next`），共 12 個（`search`、`resolveStream`、`mix`、`trackDetail`，不含手改過而略過的 `importPlaylist`；`trackDetail` 的第三個是 `next`，案例的 `sourceId` 是 `dQw4w9WgXcQ`，與 `resolveStream`、`mix` 相同）。

`importPlaylist` 案例（`fixtures/importPlaylist/`）：`001`、`002` 是 `mix` 錄製的 `sw.js_data` 與 `config` 複本，`003` 是 2026-10-15 匿名 `browse` 第一頁的真實回應，刪減到只剩插件讀的路徑並把續取 token 遮成 `***`（`meta.edited`；原始回應 1.3 MB）；請求的 body 與標頭、回應的標頭沿用 `mix` 同一次 session 的錄製（2026-10-14）。所以命令列錄製會略過它，要重錄時把 `meta.edited` 拿掉再錄，並注意第一頁 100 部加上 session 共 3 個請求。續取頁 `test/data/playlist-page2.json` 同樣是真實回應刪減而成，不是 fixture（契約案例只跑第一頁）。

`login` 案例（`fixtures/login/001.json`）是 2026-10-15 在 FMP 的插件開發工具以測試帳號登入後錄的（FMP #254），再刪減成只剩通往 `activeAccountHeaderRenderer` 的路徑與名稱、頭像（`meta.edited`）：真實回應帶 Google 帳號的 email、頻道 id 與 `datasyncId`。命令列錄製略過它（`requiresLogin`）。
