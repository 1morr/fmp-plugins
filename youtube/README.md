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
- `libraryRead`：`libraryPlaylists({cursor?})`，列出登入帳號的播放清單（FMP ADR 0032 §決定 3）。請求與解析在 `src/library.js`，規格是舊版 `youtube_playlist_service.dart` 的 `getPlaylists`。
  - 請求：innertube `browse`，`browseId: 'FEplaylist_aggregation'`（舊版同），WEB client，`auth: 'required'`；續取以 `{continuation}`。
  - 解析（舊版 `_tryParsePlaylistItem`／`_findPlaylistsRecursive`）：在 `contents`（續取是 `onResponseReceivedActions`）裡遞迴找 `gridPlaylistRenderer`、`playlistRenderer`、`lockupViewModel`（`contentType` 為 `LOCKUP_CONTENT_TYPE_PLAYLIST`）。`title` 空白的略過；同一個 `playlistId` 只留第一個。`trackCount` 只從 "12 videos"／"1,234 videos" 這類帶單位的文字取（縮寫如 "12K" 不收，省略）。
  - **跳過 importPlaylist 收不了的 id**：`RD…`（Mix，走 `mix`）與不合 `[A-Za-z0-9_-]{1,100}` 的；用 `src/playlist.js` 的 `importable()`，與 `importPlaylist` 的輸入驗證同一個判斷。舊版沒有略過任何項目，`LL`（Liked）、`WL`（Watch Later）若出現在頁面上照列：`importPlaylist` 收它們（私人，靠補登入讀）。
  - **`writable`**：回應沒有「這張是我的」旗標，看項目底下有沒有 `deletePlaylistEndpoint`（自己的清單選單才有「刪除播放清單」）；沒看到就是 `false`，所以 `LL`、`WL` 與收藏別人的都是 `false`。2026-10-20 以登入帳號實測：這個端點在 `lockupViewModel` 底下約 20 層（`metadata` → … → `menuButton` → … → `listItems[]` → … → `deletePlaylistEndpoint`），所以找它的深度上限是獨立的 40，不是解析清單的 15；`fixtures/libraryRead/003.json` 保留了這條完整路徑，`test/library_read.test.js` 以它守。
  - **分頁**：舊版不分頁。這裡取頁面裡最後一個 continuation token（`continuationItemRenderer`／`continuationItemViewModel`），cursor 是 `v1:<token>`（token 不解讀）；沒有 token 是 `null`。續取形狀沒有實測。
  - 錯誤：回應 `responseContext.mainAppWebResponseContext.loggedOut` 為 `true` → `AuthRequired`；沒帶憑證的 HTTP 401／403 → `AuthRequired`；帶了憑證的 401 是 `CredentialInvalid`（判定表），其他 4xx／5xx 原樣往外；續取回應沒有項目 → `ParseError`。沒登入時宿主對 `required` 請求先拋，不會走到這裡。
- `libraryWrite`：`createPlaylist`、`addToPlaylist`、`removeFromPlaylist`（FMP ADR 0032 §決定 4，必須同時宣告 `libraryRead`）。請求與判讀在 `src/library_write.js`，流程在 `src/plugin.js`；規格是舊版 `youtube_playlist_service.dart`。**整個能力沒有實測**，要等擁有者的真實測試；`checks.json` 的 `libraryWrite` 案例標 `mutates`，fixture 是手寫的（`meta.edited`）。請求一律 innertube、WEB client、`auth: 'required'`，且**不標 `idempotent`**（`src/shims.js` 對 `browse/edit_playlist`、`playlist/create` 不標：重試可能多建歌單）。
  - `createPlaylist({title})`：`playlist/create`，body `{title, privacyStatus: 'PRIVATE'}`，回 `playlistId`（要是 `importPlaylist` 收得進來的 id）。**預設私人**；舊版的預設與新增對話框都是 `UNLISTED`，宿主契約沒有隱私欄位，所以這是插件的選擇。
  - `addToPlaylist({playlistId, tracks})`：先逐頁掃 `browse` `VL<playlistId>`（`auth: 'required'`，舊版 `getVideoIdsInPlaylist`；目標都找到就提早停，至多 100 頁），已在清單裡的是 `alreadyPresent`（`edit_playlist` 不去重，會多一份）；其餘每項一個 `browse/edit_playlist` `{playlistId, actions: [{addedVideoId, action: 'ACTION_ADD_VIDEO'}]}`。`edit_playlist` 可以一個請求帶多個 action，但回應只有一個 `status`、分不出哪一項失敗，所以不批次，一項一個請求（舊版也是），換得逐項結果。
  - `removeFromPlaylist({playlistId, items})`：`{playlistId, actions: [{setVideoId, removedVideoId, action: 'ACTION_REMOVE_VIDEO'}]}`。**怎麼認項目**：宿主給了 `remoteItemId` 就當 `setVideoId` 用、不掃清單；沒有的（匿名 `importPlaylist` 拿不到）掃一遍清單找 `videoId` 對應的 `setVideoId`（舊版 `getSetVideoId`，同一支影片出現多次取第一個）。清單裡沒有這支影片 → `notPresent`；有、但掃到的項目找不到 `setVideoId` → 這一項 `failed`（`UnexpectedError`），不猜。舊版沒有用 `ACTION_REMOVE_VIDEO_BY_VIDEO_ID`，這裡也不用。掃描認 `playlistVideoRenderer.setVideoId`（舊版）與 `lockupViewModel` 底下任何位置的 `setVideoId` 字串（新版面的位置是推測：選單的 `playlistEditEndpoint`）。
  - **錯誤**：每個項目的失敗進 `results`。`edit_playlist` 的 2xx 回應有 `error` 物件，或 `status` 不是 `STATUS_SUCCEEDED`（舊版 `_checkResponse`；沒有 `status` 視為成功，同舊版）→ `UnexpectedError`；404 → `NotFound`；403 帶了憑證 → `UnexpectedError`（沒有權限，契約沒有對應的錯誤種類）、沒帶憑證 → `AuthRequired`；帶了憑證的 401 是 `CredentialInvalid`（判定表，`hostRequest` 已轉）。`CredentialInvalid`、`AuthRequired`、`RateLimited` 對之後的項目也成立：停止送請求，剩下的項目標同一個失敗，已完成的結果保留；一項都沒完成（`results` 會全是失敗）時改成整個請求拋出該錯誤。5xx（`NetworkError`）與非結構化的例外整個請求往外丟。掃描讀不到清單（`NotFound`、沒帶憑證的 `AuthRequired` 等）→ 每一項都標同一個失敗、不送任何寫入（`CredentialInvalid`、`RateLimited` 與 `NetworkError` 整個請求拋出）；掃描中途某一頁失敗（含 5xx）不像舊版回傳已掃的部分，而是整個請求失敗，免得把「沒掃到」當成「不在清單裡」。`results` 裡的 `error` 只留 FmpError 的欄位（`fmpError`、`message`、`reason`、`retryAfterSeconds`）：宿主丟的錯誤（例如 429 的 `RateLimited`）另帶 `hostErrorId`，原樣放進 `results` 宿主會以不認得的欄位拒收整個回傳值（`ParseError`）；整個請求拋出時則原樣拋出。
  - 同一次請求內的重複：加入以 `videoId` 去重，第一次之後是 `alreadyPresent`；移除以 `setVideoId`（宿主給的或掃到的）去重，同一格第一次之後是 `notPresent`，所以同一支影片在清單裡出現兩次、宿主給了兩個不同的 `remoteItemId` 時兩格都會移除（沒給的只會移除掃到的第一格）。`cid` 不適用，忽略。
  - **實測**（2026-10-20，擁有者的 Google 測試帳號，Windows，FMP M4 PR 14）：對私人清單「FMP 測試」加入一支、再移除同一支，都成功；登入狀態下的 `VL<id>` 找得到 `setVideoId`（移除走預讀到的 `setVideoId`）。**寫後讀有延遲**：`edit_playlist` 成功後立刻 `browse` 拿到的還是舊內容，約 40 秒後才一致（FMP 端因此把寫後刷新延後 60 秒）。
  - **未驗證**：`edit_playlist` 的真實回應（`STATUS_SUCCEEDED` 之外還有 `playlistEditResults`）與對別人的清單寫入被拒時的狀態碼。
- `charts`：一個榜單 `new-this-week`（「本週新歌」），兩個匯出（FMP ADR 0032 §決定 5）。規格是舊版 `youtube_source.dart` 的 `getTrendingVideos`／`_fetchNewThisWeekPlaylist`／`getRankingTracks`，請求與解析在 `src/chart.js`。
  - `chartList()`：常數，不發請求。`chart({chartId})`：POST innertube `browse`（WEB client），`{browseId: 'VLOLPPnm121Qlcoo7kKykmswKG0IepmDUVpag'}`（YouTube Music 官方策劃的 "New This Week" 歌單，每週更新）；標 `idempotent: true`、`auth: 'userPreference'`，沒有私人榜單，所以被拒不補登入。`chartId` 不認得 → `NotFound`，不是非空字串 → `ParseError`，都不發請求。
  - 曲目的解析沿用 `importPlaylist` 的（`src/playlist.js` 的 `lockupViewModel`／`playlistVideoRenderer`）：只收有長度的影片，縮圖只留 `ytimg.com`。**依觀看次數由高到低排**（舊版在來源裡排，因為歌單的順序不是觀看次數的順序）；同數的維持歌單順序，讀不出次數的當 0、排在最後。
  - **觀看次數的文字**：`lockupViewModel` 的 `metadataRows` 第二列，第一格是次數、第二格是日期。插件實際送的 WEB context（YouTube.js 的 session）回 `"235K"`、`"14M"`（日期 `"7d ago"`），**不帶 "views"**；只送最小 context 時回 `"235K views"`（日期 `"7 days ago"`）。舊版 `_trackFromLockupViewModel` 只認含 "views" 的格子，所以用插件的 context 會讀成全 0、排序失效；這裡兩種都認（`VIEWS_TEXT`：數字加選用的 K／M／B 和 "views"，或 "No views"；第一列是頻道名，不看，以免把名叫 "21" 的頻道當成次數）。數字是四捨五入後的概數（"14M"），解析同舊版 `_parseViewCountText`。舊版面（`playlistVideoRenderer`）取 `videoInfo` 第一格。回應若改版成讀不到次數，榜單退成歌單原順序，不是錯誤。
  - **只讀第一頁**：舊版也沒有續取；2026-10-16 匿名實測回 25 首、沒有 continuation，每首都有次數。
  - 沒有項目區塊或解析後 0 首 → `ParseError`（舊版同：`parse_error`）；HTTP 4xx／5xx 原樣往外（`RateLimited`、`NetworkError` 由宿主的網路層轉換）。

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

- innertube 的 POST（搜尋、player、mix 的 `/next`、config）都是查詢，標 `idempotent: true`，暫時失敗時由網路層重試（FMP ADR 0028）。寫入（`browse/edit_playlist`、`playlist/create`）不標。
- `Innertube.create` 的會話資料（visitor data 等）存在插件的 storage，之後的啟動不再打 `sw.js_data` 與 `config`。
- QuickJS 沒有 Web API：`src/shims.js` 以 `fmp.http.request` 為底補上 fetch、Headers、Request、Response，並補 URL、TextEncoder/TextDecoder、crypto、atob/btoa、timers。宿主 API v1 只傳字串 body，二進位的 request body 一律拋錯。
- 宿主的網路紀錄沒有 body：innertube 回 4xx／5xx 時插件另記一筆 warn（`innertube error`），只含路徑、client 名稱、有沒有帶憑證，以及 Google API 錯誤物件的 `status` 與 `message`。

## 已知限制

- 年齡限制與會員影片播不了，登入也一樣：player 請求不帶憑證（見「登入」）。匿名身分被要求驗證時只會回 `VerificationRequired`。
- 哪個 client 能用由 YouTube 決定，`VISIONOS` 也可能被加上同樣的限制。換 client 只要改 `src/clients.js` 的 `CLIENTS` 並重新打包，不必發新版 App；新 client 收不收 cookie 要對 `COOKIELESS_CLIENT_NAMES`。
- 一個 `checks.json` 每個能力只有一條案例，所以契約測試只重播成功的 `search`、`resolveStream`、`mix`、`trackDetail`、`importPlaylist`、`charts`、`libraryWrite`（手寫 fixture）與 `login`；上表的錯誤對應由 `test/errors.test.js` 以 YouTube 實際給的 `playabilityStatus` 文字守（`npm test`）。player 請求不用 YouTube.js 的 `getBasicInfo`：它遇到 `ERROR` 直接拋例外，走不到 `NotFound`；`test/resolve.test.js` 以錄好的 fixture 跑整條 `resolveStream` 守這點；`test/mix.test.js` 以手寫與錄好的（`fixtures/mix/003.json`）`/next` 回應跑整條 `mix`；`test/track_detail.test.js` 以同一份錄好的 `/next` 加手寫變體跑整條 `trackDetail`（欄位對應、省略、直播與按過讚的計數、日期的時區、輸入驗證、錯誤、`idempotent` 與 `auth`）；`test/chart.test.js` 以 `test/data/chart-new-this-week.json`（`fixtures/charts/003.json` 刪減成前 8 首）加手寫變體跑整條 `chart`（排序、兩種次數文字、同數、略過、舊版面、輸入驗證、錯誤）；`test/import_playlist.test.js` 以 `fixtures/importPlaylist/003.json`（第一頁）、`test/data/playlist-page2.json`（續取頁）加手寫變體跑整條 `importPlaylist`（網址辨識、`mixSeed`、解析、續取、略過、cursor 驗證、私人歌單重送 `required` 的各種情況（含續取頁）、`x-fmp-call` 不送出、錯誤對應）；`test/library_write.test.js` 以手寫的 `VL<id>` 與 `edit_playlist` 回應跑整條 `libraryWrite`（請求形狀、`required`、不標 `idempotent`、掃描去重與續取、`setVideoId` 的來源、逐項結果與順序、停止送請求的錯誤、`results` 裡的宿主錯誤去掉 `hostErrorId`、讀不到清單）（測試裡用 esbuild 在記憶體打包 `src/`）。
- `visitorData`（請求與回應 body 的 JSON 鍵、`serviceTrackingParams` 裡 `key: "visitor_data"` 的 `value`）與 `X-Goog-Visitor-Id` header 的內容編碼了錄製地的國家碼：manifest 的 `redaction` 把 `visitorData`、`X-Goog-Visitor-Id` 加進遮蔽名單，既有 fixture 已改成 `***`（重播只比對方法與網址，不受影響）。`visitor_data` 那一格的值（`{"key": "visitor_data", "value": …}`）名單認不得，重錄後要手動換成 `***`。
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

指令見 repo 根目錄的 `README.md`。錄製會真的連 YouTube：每個案例各發 3 個請求（`sw.js_data`、`config`，再來 `search`、`player` 或 `next`），共 15 個（`search`、`resolveStream`、`mix`、`trackDetail`、`charts`，不含手改過而略過的 `importPlaylist`；`trackDetail` 的第三個是 `next`，案例的 `sourceId` 是 `dQw4w9WgXcQ`，與 `resolveStream`、`mix` 相同）。

`charts` 案例（`fixtures/charts/`，2026-10-16 錄製，未刪減，約 1 MB）：同樣 3 個請求，第三個是 `browse`（`VLOLPPnm121Qlcoo7kKykmswKG0IepmDUVpag`，25 首）。

`importPlaylist` 案例（`fixtures/importPlaylist/`）：`001`、`002` 是 `mix` 錄製的 `sw.js_data` 與 `config` 複本，`003` 是 2026-10-15 匿名 `browse` 第一頁的真實回應，刪減到只剩插件讀的路徑並把續取 token 遮成 `***`（`meta.edited`；原始回應 1.3 MB）；請求的 body 與標頭、回應的標頭沿用 `mix` 同一次 session 的錄製（2026-10-14）。所以命令列錄製會略過它，要重錄時把 `meta.edited` 拿掉再錄，並注意第一頁 100 部加上 session 共 3 個請求。續取頁 `test/data/playlist-page2.json` 同樣是真實回應刪減而成，不是 fixture（契約案例只跑第一頁）。

`login` 案例（`fixtures/login/001.json`）是 2026-10-15 在 FMP 的插件開發工具以測試帳號登入後錄的（FMP #254），再刪減成只剩通往 `activeAccountHeaderRenderer` 的路徑與名稱、頭像（`meta.edited`）：真實回應帶 Google 帳號的 email、頻道 id 與 `datasyncId`。命令列錄製略過它（`requiresLogin`）。
