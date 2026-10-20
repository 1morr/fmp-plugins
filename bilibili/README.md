# bilibili

B 站音源，可匿名使用，也可用 QR 碼登入（啟動時自動刷新憑證）。行為以 FMP 舊專案的 `lib/data/sources/bilibili_source.dart` 為規格，改用 JS 重寫。

## 能力

- `search`：搜尋影片（`/x/web-interface/search/type`，綜合排序，每頁 20 筆）。課堂這類不是影片的結果沒有 `bvid`，會被略過，所以一頁可能不到 20 筆。標題會去掉 `<em>` 標籤並解 HTML 實體（命名的與 `&#39;`、`&#x27;` 這類數字的）。封面回傳 `@160w`、`@480w` 兩個縮圖（標寬度）加原圖（不標寬度），宿主依顯示大小挑。
- `multiPart`：影片的分 P 列表，`GET api.bilibili.com/x/player/pagelist?bvid=<bvid>`（舊專案取 `view` 的 `pages`；改走 pagelist 是因為舊專案實測它匿名也是 200，且不必簽 WBI，一個請求就夠），請求標 `auth: 'userPreference'`。回應 `data` 是陣列，每筆 `cid`、`page`（→ `index`，從 1）、`part`（→ `title`，去掉頭尾空白；空的或不是字串時用 `P<index>`）、`duration`（秒 → `durationMs`，缺或非整數就不給）。`sourceId` 不是 `BV` 加 10 個英數字就是 `ParseError`，不發請求；沒有分 P 回 `NotFound`；`data` 不是陣列或任何一筆的 `cid` 不是正整數是 `ParseError`（形狀變了不悄悄少一筆）；業務碼照〈錯誤對應〉。回應形狀已對過一次真實匿名回應（`cid`、`ctime`、`dimension`、`duration`、`first_frame`、`from`、`page`、`part`、`vid`、`weblink`）。搜尋回應現在沒有每筆的 `page`（2026-10 的 search fixture 也沒有），所以 `partCount` 多半不給；宿主把它當提示，不知道時也讓使用者展開。
- `trackDetail`：影片詳細，`GET api.bilibili.com/x/web-interface/wbi/view?bvid=<bvid>`（WBI 簽名，與 `resolveStream` 取 `cid` 是同一個請求，共用 `viewData`；不含熱門評論，design §16 第 13 條）。回 `description`（`desc`，去頭尾空白，空的或 B 站當佔位的 `-` 不給）、`publishedAt`（`pubdate` 秒 → 毫秒，非正整數不給）、`uploaderAvatar`（`owner.face`，格式同 `search` 的封面：`@160w`、`@480w` 加原圖，不在 `hdslb.com` 的不給）、`stats`（`stat` 的 `view`、`like`、`favorite`、`reply`→`comment`、`share`、`danmaku`、`coin`；值不是非負整數，例如被隱藏時的 `"--"`，就略過那一項，不補 0；一項都沒有就不給 `stats`）。`allowedHosts` 不變（`api.bilibili.com`、`hdslb.com` 本來就有）。`cid` 不參與（簡介與統計是整支影片的），給了要是正整數。`sourceId` 不是 `BV` 加 10 個英數字或 `cid` 不合法是 `ParseError`，不發請求；請求標 `auth: 'userPreference'`；業務碼照〈錯誤對應〉。
- `search` 的 `partCount`：搜尋結果每筆的 `page`（分 P 數）是正整數才給，否則省略。
- `login`：QR 碼登入與憑證刷新，見下方〈登入〉〈刷新〉。
- `live`：直播間，四個匯出，見下方〈直播〉。
- `importPlaylist`：匯入收藏夾，兩個匯出（FMP ADR 0032 §決定 2）。規格是舊專案 `bilibili_source.dart` 的 `parsePlaylist` 與 `import_service.dart` 的 `_expandMultiPageVideos`。
  - `playlistFromUrl({url})`：不發請求。網域限舊專案的 `bilibili.com`、`www.`、`m.`、`space.bilibili.com`（`b23.tv` 短網址舊版也不支援），沒有 `://` 的輸入當成 https；認 `fid=<數字>`（`space.bilibili.com/<mid>/favlist?fid=…`）與路徑裡整段的 `ml<數字>`（`/medialist/detail/ml…`、`/list/ml…`），回 `{playlistId}`＝這個數字；其餘 `null`。與舊版不同：舊版在整個網址裡找 `ml\d+`，這裡限定整段；`favlist` 沒有 `fid` 的（只是某人的收藏夾總覽）舊版也解不出 id，回 `null`。**`fid` 要用完整 id**：`folder/created/list-all` 回的 `fid`（短）不是 `media_id`，拿去問 `fav/resource/list` 會得到另一個人的收藏夾；完整 id 是 `id`（短 `fid` × 100 加 `mid` 末兩碼），網頁網址的 `fid=` 帶的就是完整的（實測見下）。
  - `importPlaylist({playlistId, cursor?})`：`GET api.bilibili.com/x/v3/fav/resource/list?media_id=<id>&pn=<頁>&ps=20&platform=web`（舊版的參數；`ps` 上限 20），`auth: 'userPreference'`；匿名可讀公開收藏夾，**不用 WBI 簽名**。`cursor` 是 `v1:<下一頁頁碼>:<0|1>`，後者是「以 `required` 送」；`data.has_more` 為真且這頁有項目才給，否則 `null`。`playlistId` 不是正整數字串、`cursor` 格式不對 → `ParseError`，不發請求。
  - `playlist`（每頁都有，因為 `data.info` 每頁都回）：`title`（`info.title`，缺或空 → `ParseError`）、`description`（`info.intro`，空不給）、`artwork`（`info.cover`，格式同 `search` 的封面，空或不在 `hdslb.com` 不給）、`ownerName`（`info.upper.name`）。**`writable` 只在這次請求真的帶了憑證時給**：收藏夾擁有者 `info.upper.mid` 對登入帳號的 `DedeUserID` 相等才是 `true`，不等是 `false`；匿名、憑證沒有 `DedeUserID` 或 `mid` 不是整數時不給（帶憑證的判斷只有單元測試，沒有真實連線驗過）。
  - `items`：`track` 欄位同 `search`（`sourceId`＝`bvid`、`title`、`uploader`＝`upper.name`、`durationMs`＝`duration` 秒、`artwork`＝`cover`）；`media.page` 是正整數時也給 `partCount`。沒有 `bvid` 的（音訊 `type` 12、合集）與 `type` 不是 2 的略過。
  - **多 P 展開**：`page` 大於 1 的影片對它呼叫 `multiPart`（`pagelist`，一支一個請求，依序，限流由宿主的 `rateLimit` 處理；舊版取 `view` 的 `pages`，這裡沿用 `multiPart` 已驗過的 pagelist），回 ≥ 2 個分 P 時展開成各 P：`sourceId` 同影片、`cid`、`title`＝分 P 標題（舊版 `toTrack` 也只放分 P 標題）、`durationMs`＝該 P 的長度、`partIndex`、`parentTitle`＝影片標題（原標題，去頭尾空白）、`partCount`＝分 P 數，`uploader`、`artwork` 沿用影片的。pagelist 只回 1 個分 P 就當單 P（不帶 `cid`、`partIndex`、`parentTitle`）；單 P 影片不發 pagelist 請求。pagelist 回 `NotFound` 時整頁失敗（丟 `UnexpectedError`，不原樣丟 `NotFound`：那會讓宿主把整個收藏夾標成來源失效）——收藏夾沒以 `attr` 標失效、分 P 列表卻說不見了，多半是審核中這類暫時狀態，標失效會讓宿主移除先前展開的各 P、之後再加回來；其他錯誤（風控、網路、形狀不對）同樣整頁失敗，不悄悄少展開。舊版是留原筆、標這次刷新不完整，新契約沒有「不完整」旗標，丟錯讓宿主記「部分完成」、不套用移除是等價的。
  - **不給 `total`**：`info.media_count` 含失效與被略過的項目，展開後筆數也不同（design §4.3）。完整性只剩「每一頁成功、最後 `cursor` 為空」。
  - **`unavailable`**：項目的 `attr` 是 `9`（UP 主自己刪除）或 `1`（其他原因刪除）時標 `true`，這種項目不展開、不發 pagelist；數值來自 B 站網頁端的慣例與社群整理的 API 文件，舊版沒有判斷（失效影片當一般曲目匯入，標題是「已失效视频」），**實測的收藏夾沒有失效項目，沒驗過**，只有單元測試。
  - **不給 `remoteItemId`**：收藏夾的新增與移除以影片的 `aid` 指項目（舊版 `bilibili_favorites_service.dart`：`fav/resource/deal` 的 `rid`＋`type` 2，批次移除 `fav/resource/batch-del` 的 `resources` 是 `<aid>:2`；這次沒有實測），沒有歌單內的項目 id，而且 `bvid` 換 `aid` 是插件在 `libraryWrite` 內做的（ADR 0032 §決定 4），所以不需要。
  - **私人收藏夾**：請求一律 `userPreference`。業務碼 `-101`、`-403`、`-404` 視為讀不到；這次請求沒帶憑證（`credentialsAttached` 為假）且 `fmp.credentials.get()` 不是 `null` 時，以 `required` 重送同一個請求一次；已帶憑證被拒、或重送後還被拒都不再送。靠重送讀到的收藏夾，後續頁也以 `required` 送（記在 cursor）；續取頁同樣的規則。最後還讀不到：`-404`，或已帶憑證 → `NotFound`；沒帶憑證的 `-101`／`-403` → `AuthRequired`。帶了憑證的 `-101`／`-111` 是 `CredentialInvalid`（既有的判定表）。風控碼 → `RateLimited`。**未實測**：匿名讀私人收藏夾與不存在的收藏夾的實際回應（業務碼與訊息），所以上面的碼是照舊版 `BilibiliApiException` 與 B 站網頁行為推的，`test/import_playlist.test.js` 用手寫的碼守邏輯。
  - **實測**（2026-10-15，匿名，Windows，FMP 的錄製器）：官方帳號「哔哩哔哩弹幕网」（`mid` 8047632）的公開收藏夾「B站 × WAIC AI会客厅」，`media_id` `4026748432`，網址 `https://space.bilibili.com/8047632/favlist?fid=4026748432`；`media_count` 10，一頁 20 筆就收完，`has_more` 為假，`medias` 10 筆、`attr` 全是 0、`page` 全是 1，所以**沒有多 P 影片，展開沒有實測**（多 P 的 pagelist 形狀見 `fixtures/multiPart/001.json` 的真實回應；展開邏輯由單元測試用手寫的 `fav/resource/list` 與 pagelist 回應守）。匿名請求沒有觸發風控（`code` 0），沒有要 WBI。錄製發了 1 個請求（`fav/resource/list`，匿名 cookie 不發請求）。查收藏夾清單用了 `folder/created/list-all?up_mid=8047632` 一個請求；其間拿短 `fid`（`40267484`）當 `media_id` 問了兩次，得到的是別人的收藏夾（`medias` 為 `null`），因而發現上面的完整 id 規則——那份回應沒有存進 fixture 或文件。
- `libraryRead`：`libraryPlaylists({cursor?})`，列出登入帳號的收藏夾（FMP ADR 0032 §決定 3）。規格是舊專案 `bilibili_favorites_service.dart` 的 `getFavFolders`。
  - 請求：`GET api.bilibili.com/x/v3/fav/folder/created/list?up_mid=<mid>&type=2&pn=<頁>&ps=20`（舊版的參數；沒有 `rid`），`auth: 'required'`，不用 WBI 簽名。`mid` 取 `fmp.credentials.get()` 的 `cookies.DedeUserID`（舊版 `getUserMid`）；缺或不是正整數 → `AuthRequired`，不發請求。
  - `playlistId` 是回應的 `id`（完整 `media_id`，不是短的 `fid`），等於 `importPlaylist` 收的 id。`title` 空白時退回 `ml<id>`；`artwork` 是 `cover`（格式同 `importPlaylist`）；`trackCount` 是 `media_count`（非負整數才給）。
  - **`writable` 一律 `true`**：`created/list` 只回自己建立的收藏夾。舊版沒有列「收藏的收藏夾」（`created/list` 以外的端點），這裡也不列。
  - **分頁**：`cursor` 是 `v1:<下一頁頁碼>`；`data.has_more` 為真且這頁有項目才給，否則 `null`。`cursor` 格式不對 → `ParseError`，不發請求。同一頁內重複的 `id` 只留第一個。
  - 錯誤沿用既有的對應：帶了憑證的 `-101`／`-111` 是 `CredentialInvalid`（判定表），`-403` → `AuthRequired`，風控碼 → `RateLimited`。2026-10-20 以登入帳號實測（FMP M4 PR 13）：列出、匯入私人收藏夾、關掉「以登入身分瀏覽與播放」後刷新（先不帶憑證被拒、以 `required` 重送）都成功；`checks.json` 的 `libraryRead` 案例的 fixture 是那次的錄製刪減而成（`meta.edited`）。
- `libraryLiveRooms`：`libraryLiveRooms() → {rooms}`，`libraryRead` 的選填匯出（FMP ADR 0032 §決定 3；bilibili 同時宣告 `live`），帳號區「從帳號匯入電台」用它列出勳章牆上主播的直播間。規格是舊專案 `bilibili_account_service.dart` 的 `fetchMedalWall`（line 522）與 `bilibili_live_client.dart` 的 `getMedalWallRooms`（line 339），電台的建立見 `radio_controller.dart` 的 `loadAccountImportCandidates`（line 673）與 `importAccountStations`。**沒有實測**，要等擁有者的真實測試；沒有 `checks.json` 案例（每能力一案，`libraryRead` 已由 `libraryPlaylists` 佔用）也沒有 fixture，只有 `test/library_live_rooms.test.js` 用手寫的假回應守。
  - 請求（都是 `GET`、`auth: 'required'`、直播 API 的標頭，不用 WBI）：先 `api.live.bilibili.com/xlive/web-ucenter/user/MedalWall?target_id=<mid>`（舊版的端點與參數，不分頁，一次回完整勳章牆），`mid` 取 `fmp.credentials.get()` 的 `cookies.DedeUserID`（同 `libraryPlaylists`；缺或不是正整數 → `AuthRequired`，不發請求）；再把去重後的主播 uid 每 50 個一組送 `…/room/v1/Room/get_status_info_by_uids?uids[]=…`（`liveAnchorSearch` 用的同一個端點）。**與舊版不同**：舊版對每個 uid 問一次 `getRoomInfoOld?mid=<uid>` 取房號（N+1），而且勳章牆沒有標題，舊版的候選只有名稱與頭像；這裡改用批次端點，一次拿到房號、標題、封面、開播狀態與觀看人數，因為宿主匯入後不會再呼叫 `liveStatus`。
  - 對應：`roomId`＝`room_id`（真實房號，字串；與 `liveSearch`、`liveStatus` 同格式，也是 `liveRoomFromUrl` 回的格式，宿主以它比對重複）；`title`＝`title`（同 `liveSearch`：去 `<em>`、解實體，空的是 `Unknown`）；`hostName`＝勳章牆的 `target_name`，空白時退回批次回應的 `uname`；`artwork`＝`cover_from_user`，沒有時 `keyframe`，再沒有時勳章牆的 `target_icon`（主播頭像，舊版候選顯示的就是頭像）；`status`＝`live_status` 為 1 是 `live`，其餘（0、2 輪播、缺）都是 `offline`（不像 `liveStatus` 對未知值拋 `ParseError`：這裡一個房間的怪值不該讓整份匯入清單失敗）；`online`＝`online`（非負整數才給，否則 `null`）。
  - 略過（同舊版）：沒有 `medal_info.target_id`（或 0）的項目、批次回應沒有這個 uid 或 `room_id` 為空／0（沒有直播間）的主播；同一個主播的多個勳章、不同主播指到同一個房號只留第一個。勳章牆為空不發批次請求；批次回空陣列（沒有人有直播間，PHP 的空 map）是空清單。
  - 錯誤：帶了憑證的 `-101`／`-111` 是 `CredentialInvalid`，`-403` → `AuthRequired`，風控碼 → `RateLimited`（既有的對應）；任何一個請求失敗都整個拋，不回部分結果（舊版單一 uid 失敗只略過那一項，這裡批次失敗就是整批失敗）。
  - **實測**（2026-10-20，擁有者帳號，Windows，FMP M4 PR 15）：一次匯入 90 個直播間：`MedalWall` 1 次、`get_status_info_by_uids` 2 次（50＋40），都成功；房號與電台既有的去重對得上（再匯入一次全部「已在清單」由 FMP 的重播驗）。
  - **未驗證**（實測的帳號沒碰到）：`MedalWall` 的實際回應（`list`／`medal_info.target_id`／`target_name`／`target_icon` 是照舊版讀的欄位）、是否真的不分頁（勳章很多的帳號）、`get_status_info_by_uids` 對一次 50 個 uid 與沒有直播間的 uid 的行為、`cover_from_user` 為空時的封面。
- `libraryWrite`：`createPlaylist`、`addToPlaylist`、`removeFromPlaylist`（FMP ADR 0032 §決定 4，必須同時宣告 `libraryRead`）。規格是舊專案 `bilibili_favorites_service.dart`。**整個能力沒有實測**，要等擁有者的真實測試；`checks.json` 的 `libraryWrite` 案例標 `mutates`，fixture 是手寫的（`meta.edited`）。全部是表單 POST（`application/x-www-form-urlencoded`）、`auth: 'required'`、不標 `idempotent`（寫入不讓網路層重試），`csrf` 取 `fmp.credentials.get()` 的 `cookies.bili_jct`（缺 → `AuthRequired`）。
  - `createPlaylist({title})`：`POST /x/v3/fav/folder/add`（`title`、`intro` 空、`privacy` 1、`csrf`），回 `data.id`（完整 `media_id`，等於 `libraryPlaylists` 與 `importPlaylist` 的 `playlistId`）。**預設私人**；舊版的新增對話框預設公開（`initialPrivacy: false`），宿主契約沒有隱私欄位，所以這是插件的選擇。
  - `addToPlaylist({playlistId, tracks})`：每個不重複的 `bvid` 一次 `POST /x/v3/fav/resource/deal`（`rid`＝aid、`type` 2、`add_media_ids`＝`playlistId`、`del_media_ids` 空；舊版 `updateVideoFavorites`，API 是一支影片一個請求，不能批次）。**bvid→aid**：舊版沒有演算法，走 `wbi/view`（舊版 `getVideoAid`；沒有舊版的 `Track.bilibiliAid` 快取，這裡不存）。**alreadyPresent**：回應 `code` 11201（舊版 `alreadyFavorited`），不做預讀。**分 P（`cid`）**：B 站收藏是整支影片，一律加入整支影片；同一個 `bvid` 在同一次請求出現多次只送一次，後面的項目是 `alreadyPresent`。
  - `removeFromPlaylist({playlistId, items})`：一次 `POST /x/v3/fav/resource/batch-del`（`media_id`、`resources`＝`<aid>:2` 以逗號連接，舊版 `batchRemoveFromFolder`）。以 `sourceId`（bvid）換 aid 指項目，不用 `remoteItemId`（`importPlaylist` 本來就不給）；`cid` 同樣忽略，移除的是整支影片。回應不分項，`code` 0 就整批 `removed`，**偵測不到 `notPresent`**（沒有預讀；舊版也沒有）：只有同一次請求內重複的 `bvid` 後面的項目是 `notPresent`。
  - **錯誤**：每個項目的失敗進 `results`（`fmpError` 依既有業務碼對應；新增 `11010` → `NotFound`，舊版 `contentNotFound`）。帶了憑證的 `-101`／`-111` → `CredentialInvalid`、`-403` → `AuthRequired`、風控碼 → `RateLimited`：這三種對之後的項目也成立，所以停止送請求，剩下的項目標同一個失敗，已完成的結果保留（移除時在換 aid 階段碰到，`batch-del` 也不送，已換好 aid 的項目同樣標這個失敗）；一項都沒完成（`results` 會全是失敗）時改成整個請求拋出該錯誤。網路類錯誤（`NetworkError`）與非結構化例外整個請求往外丟。`batch-del` 失敗時整批的項目都是同一個失敗（上面三種且沒有其他項目成功時同樣拋出，例如 `-403` 沒有權限寫這個收藏夾 → `AuthRequired`）。`results` 裡的 `error` 只留 FmpError 的欄位（`fmpError`、`message`、`reason`、`retryAfterSeconds`）：宿主丟的錯誤（例如 429 的 `RateLimited`）另帶 `hostErrorId`，原樣放進 `results` 宿主會以不認得的欄位拒收整個回傳值（`ParseError`）；整個請求拋出時則原樣拋出。
  - **實測**（2026-10-20，擁有者帳號，Windows，FMP M4 PR 14）：對私人收藏夾「FMP 測試」加入一支影片（`wbi/view` 換 aid → `deal` 回 0）、再移除同一支（`batch-del` 回 0），之後讀收藏夾內容正確；寫後立刻讀就一致。
  - **未驗證**：`deal` 對已在收藏夾的影片是否真的回 11201（舊版映射了這個碼，沒有紀錄回應）、成功回應的 `data`、`batch-del` 對不在收藏夾的影片與一次可送幾支、`created/list` 之外收藏夾（別人的）寫入被拒時的碼。
- `charts`：一個榜單 `music`「音樂排行榜」（FMP ADR 0032 §決定 5）。`chartList()` 是常數、不發請求；`chart({chartId: 'music'})` 以 WBI 簽名 `GET api.bilibili.com/x/web-interface/ranking/v2?rid=1003&type=all&web_location=333.934`（舊專案 `getRankingVideos` 的 `rid`、`type`；音樂區的 `rid` 是 1003，網頁 `/v/popular/rank/music` 用的），`auth: 'userPreference'`，不分頁，照排行順序。曲目：`sourceId`＝`bvid`、`title`（純文字，只去頭尾空白，空的是 `Unknown`；不像 `search` 去 `<em>`、解實體，錄到的回應裡 `&` 沒有轉義）、`uploader`＝`owner.name`、`durationMs`＝`duration` 秒、`artwork`＝`pic`（格式同 `search` 的封面，不在 `hdslb.com` 不給）；`partCount`＝`videos`（分 P 數，正整數才給；舊專案的榜單沒有，這裡與 `search` 一致）；沒有 `bvid` 的略過，`list` 不是陣列 → `ParseError`，空的是空榜單。不認得的 `chartId` → `NotFound`，不發請求。**要簽名**：2026-10-16 不簽的匿名請求連三次都回 `-352`（瀏覽器 UA、匿名 buvid cookie 都有），照網頁版加上 `web_location` 與 WBI 簽名後第一次就是 `code` 0。
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

指令見 repo 根目錄的 `README.md`。錄製會真的連 B 站：`search` 發 1 個請求，`trackDetail` 發 2 個（nav、`wbi/view`；案例的 `sourceId` 與 `resolveStream` 相同，`BV1xx411c79H`；每次錄製 storage 是新的，所以要先取 WBI key），`multiPart` 發 1 個（`pagelist`；案例的 `sourceId` 是 `BV1YmHx6QEV6`，2026-10 時有 9 個分 P；下架或剩不到 2 個分 P 時換一支），`resolveStream` 發 3 個（nav、view、playurl），`live`（跑 `liveStatus`，房號 `1` 是短號）發 3 個（匿名 cookie 不發請求；`room_init`、`get_info`、`get_anchor_in_room`），`importPlaylist`（`playlistFromUrl` 不發請求，再讀第一頁）發 1 個（`fav/resource/list`，另加收藏夾裡每支多 P 影片一個 `pagelist`；案例的收藏夾是 `8047632` 的「B站 × WAIC AI会客厅」，2026-10-15 有 10 支單 P 影片，所以只有 1 個請求；內容會變，重錄前先確認它還在、`minItems` 還成立）。`charts`（`music`）發 2 個（nav、`ranking/v2`）。`resolveLive`、`liveSearch`、`liveRoomFromUrl` 沒有契約案例（每個能力一條），只有單元測試。`login` 的案例標 `requiresLogin`，命令列錄製略過（`loginRefresh` 沒有契約案例，每個能力只有一條，ADR 0015）；它的 fixture（`fixtures/login/001.json`）是 2026-10-15 在 FMP 的插件開發工具以測試帳號登入後錄的（FMP #254），再刪減成只剩 `loginVerify` 讀的欄位（`meta.edited`）；憑證、`mid`、`uname`、頭像都是 `***`。

## 打包

```sh
cd bilibili
npm ci
node build.mjs   # 輸出 bilibili.js（不壓縮，內容固定）
npm test
```

用 esbuild 把 `src/` 與 `bn.js` 打成單一檔，`bilibili.js` 與原始碼、`package-lock.json` 一起提交；index 只認這一個 `.js`。`manifest` 寫在 `build.mjs`。改 `src/` 後要重打包，否則發佈的 `bilibili.js` 不含改動。

## 測試

`npm test`（`node --test`，要先 `npm ci`）測 `test/` 裡的純函式與以假宿主 API 跑的流程：實體解碼與封面尺寸（`helpers.test.js`）；QR 狀態碼、`Set-Cookie` 解析、缺 cookie、verify 對應與請求形狀（`login.test.js`）；SHA-256、MGF1、RSA-OAEP 以 `node:crypto`（`privateDecrypt`，`oaepHash: 'sha256'`，測試自己生的金鑰）獨立驗證、寫死的公鑰等於舊專案的，以及打包檔不得出現 `BigInt`、`TextEncoder`、`crypto.subtle`、`getRandomValues` 且在 `BigInt` 被清掉時仍能載入（`oaep.test.js`）；憑證無效的判定表與 `loginRefresh` 的 5 步和各種失敗（`refresh.test.js`）；`trackDetail` 的對應、省略、非法 stat、輸入驗證、錯誤與 `auth`（`track_detail.test.js`）；`multiPart` 的對應（含錄下的 pagelist 回應）、錯誤、無效 bvid 不發請求、`userPreference`，與 `search` 的 `partCount`（`multipart.test.js`）；直播的欄位對應、狀態篩選、批次回應的形狀（`[]`、`{}`、鍵對不上都拋 `ParseError`）、空標題、網址解析與反例（含網域偽裝）、D10（失敗一律拋錯）、playUrl 取第一段、`userPreference`（`live.test.js`）；`importPlaylist` 的網址辨識與反例、單頁與分頁（`has_more`、cursor）、多 P 展開與 pagelist 的各種結果（單 P、`NotFound`、其他錯誤）、失效與非影片項目、輸入與 cursor 驗證、錯誤對應、私人收藏夾的重送（只在沒帶憑證且已登入時一次、已帶憑證被拒不重送、後續頁跟著 `required`、`CredentialInvalid`）與 `writable`（`import_playlist.test.js`）；`libraryPlaylists` 的欄位對應、分頁、重複與壞項目、cursor 與缺 `DedeUserID` 的驗證、錯誤對應（`library_read.test.js`）；`libraryWrite` 的請求形狀（網址、表單欄位、csrf、`required`）、新增的 `added`／`alreadyPresent`／失敗與同影片多 `cid`、批次移除、整批失敗、停止送請求的錯誤（含換 aid 時碰到不送 `batch-del`）、`results` 裡的宿主錯誤去掉 `hostErrorId` 與輸入驗證（`library_write.test.js`）。cookie 與 token 的值都是 `fake-…`。`src/plugin.js` 匯出 `decodeHtmlEntities`、`artwork`、`parseSetCookies`、`qrCredentials`、`verifyCookie`、`credentialsRejected`、`refreshCsrfOf` 只為了這個；宿主只認能力名稱的匯出，其他名稱忽略。
