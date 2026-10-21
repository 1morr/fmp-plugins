# qqmusic

QQ 音樂的歌單匯入，**只宣告 `importPlaylist`**，不能搜尋也不能播放，也沒有登入（請求一律 `auth: 'never'`）。匯入的曲目是外部歌曲：宿主不把它們寫進 `tracks`，只進匹配流程，去其他音源找可播的版本（FMP ADR 0032 §決定 8、ADR 0012 §決定 7）。行為以 FMP 舊專案的 `qq_music_playlist_source.dart`、`qq_music_sign.dart` 為規格，用宿主 API v1 重寫。

## 能力

- `playlistFromUrl({url})`：辨識 QQ 的歌單網址（舊專案認得的，加上下面兩種新的；沒有 `://` 的輸入當成 https），回 `{playlistId}`，其餘 `null`。
  - `y.qq.com/n/ryqq/playlist/<id>`（也含 `ryqq_v2`）與舊版 `…/playlist/<id>.html`。
  - 分享頁 `i.y.qq.com/n2/m/share/details/taoge.html?id=<id>`。
  - 微信分享頁 `i2.y.qq.com/n3/other/pages/details/playlist.html?id=<id>`（舊專案沒有；`playlist.html` 要在 `details` 段底下）。
  - 與舊專案不同：id 只在 `playlist` 段之後，或兩種分享頁的 `id=` 找；舊專案在整個網址裡找 `[?&]id=`，所以 `…/album/…?id=1` 這類在這裡是 `null`。
  - **短網址** `c.y.qq.com`、`url.cn`（舊專案的 `qqMusicShortHosts`），加上現在 App 分享出的 `c6.y.qq.com/base/fcgi-bin/u?__=…`（舊專案沒有），是唯一會發請求的情況：`GET`（`auth: 'never'`，宿主跟隨轉址），用回應的最終網址（`response.url`）照上面的規則認；最終網址不是 QQ 的歌單網址回 `null`，短網址已失效（404）回 `NotFound`。舊專案是手動逐跳檢查轉址網域，這裡交給宿主的網域規則（`allowedHosts`）。**未實測**：沒有現成可用的短網址，轉址形狀照舊專案的轉址白名單（`y.qq.com`、`i.y.qq.com`）與公開貼文裡的分享連結（2026-10-21 查，`c6` 短網址、`i2` 微信分享頁）推的，`test/import_playlist.test.js` 以手寫的轉址結果守。
- `importPlaylist({playlistId, cursor?})`：`POST u6.y.qq.com/cgi-bin/musics.fcg?sign=<sign>`，body 是 JSON（`music.srfDissInfo.aiDissInfo` 的 `uniform_get_Dissinfo`，`disstid`、`song_begin`、`song_num` 1000），標頭 `User-Agent`（Android 10）與 `Referer: https://y.qq.com/` 同舊專案，`idempotent: true`。`playlistId` 不是正整數字串、`cursor` 格式不對 → `ParseError`，不發請求。

## sign

`src/sign.js`：`zzb` + MD5 十六進位字串的 8 個字元（位置 21、4、9、26、16、20、27、30）+ 摘要逐位元組 XOR 固定金鑰後的 base64（濾掉 `+`、`/`、`=`）+ 另外 8 個字元（位置 18、11、3、2、1、7、6、25），全部小寫。長度因濾掉的字元而浮動。MD5 用宿主的 `fmp.crypto.md5`，不加宿主 API。`test/sign.test.js` 以舊專案 `QQMusicSign.encrypt` 產生的向量逐字守（2026-10-21，`dart run`）。簽名只算 body，所以同一個請求的網址是固定的；舊專案另帶的 `&_=<時間>` 是快取破壞參數，這裡不送（實測不需要），契約重播才比得上 fixture。

## 與舊專案不同：請求的 `comm`

舊專案的 `comm` 是 `{g_tk: 5381, uin: 0, format: 'json', platform: 'android'}`。2026-10-21 匿名實測：這樣**每頁只回 30 首**，不管 `song_num` 給多少（`songlist` 30、`total_song_num` 581、`hasmore` 1）；舊專案的分頁每次起點加 1000，第二個請求就落在歌單之外，所以現在只會收到前 30 首、還當成匯入完成。這裡 `comm` 多帶 `ct: 24, cv: 0`（手機網頁版的值），同一張 581 首的歌單一次回完（`hasmore` 0）。`song_num` 在小值時仍有效（要 5 首給 5 首）。

為了在伺服器日後又限制頁大小時仍然誠實，分頁不假設一頁多大：下一頁的起點是**已收到的筆數**（舊專案是起點加 1000）。

## 分頁與完整性

- `cursor` 是 `v1:<下一頁的起點>`；每一頁都重新取歌單資料（`dirinfo` 就在回應裡），所以 cursor 不背資料。有下一頁的條件：這頁至少收到一首，且起點加收到的筆數還小於 `dirinfo.songnum`。舊專案「最多 10000 首」的上限不保留：靠 `songnum` 收尾，上限會讓超過的歌單被悄悄截斷。
- `total` 給 `dirinfo.songnum`（舊專案的 `totalCount`）。回傳的筆數會因為兩種情況少於它：伺服器中途一頁都不給（停下，不重試，cursor 為空，記一筆 warn）、歌曲缺 `mid` 或標題而被略過。筆數對不上時宿主就當不完整、不套用移除。寧可如此，也不讓缺的歌被當成已完整。
- 任何一頁失敗（網路、非 200、格式不對）都拋錯，不回部分結果當成最後一頁。

## 對應

- `playlist`：`title`（`dirinfo.title`，缺或空 → `ParseError`）、`description`（`desc`，空不給）、`artwork`（`picurl`，`http` 升成 `https`，必須在 `y.qq.com` 底下；原網址帶 `?imageView2/4/w/600/h/600`，原樣保留且不給 `width`）、`ownerName`（`creator.nick`，沒有時 `host_nick`）。
- `items[].track`：
  - **`sourceId` 是歌曲的 `mid`**（如 `002ungyc33fb7x`），也就是舊專案存進 `originalSongId` 的值（`songmid`），不是數字 `id`。缺 `mid` 或含 `:` 的歌略過。
  - `title`：`name`（缺或空白的歌略過）。
  - `uploader`：`singer[].name` 以 ` / ` 連接，空白的名字略過，沒有歌手就不給（舊專案這時是 `unknownArtist`；顯示的語言屬於 App，不是插件）。
  - `durationMs`：`interval`（秒）× 1000，不是非負整數就不給。
  - 沒有 `artwork`（歌曲的封面要另外組網址，這裡不需要）。舊專案的專輯名稱 `TrackSummary` 沒有欄位，不給。
  - 不給 `unavailable`：舊專案沒有判斷，回應沒有明確的下架旗標。

## 錯誤對應

| 情況 | 錯誤 |
|---|---|
| HTTP 5xx | `NetworkError`（傳輸錯誤與 429 由宿主轉換） |
| 其他非 200 | `UnexpectedError` |
| 內容不是 JSON、不是物件、缺 `data`、`dirinfo`、`songlist`、標題或 `songnum` | `ParseError` |
| 頂層或 `req_0` 的 `code` 不是 0 | `UnexpectedError`（簽名被拒是 HTTP 200，兩個 `code` 都是 2000，實測） |
| 歌單不存在：`data.code` 為 -100006，或 `dirinfo` 是空殼（`title` 空、`songnum` 0） | `NotFound` |
| `data.code` 是其他非 0 值 | `UnexpectedError`，訊息帶碼 |

**未實測**：私人歌單與被隱藏的歌單匿名讀取時的實際回應；它們很可能落在最後一列（`UnexpectedError`），或是上一列的空殼（`NotFound`）。

## 實測（2026-10-21，匿名，Windows）

- 簽名仍被接受（舊專案的演算法）；回應形狀見 `fixtures/importPlaylist/001.json`。
- 官方帳號（`creator.nick` 為「QQ音乐」）的公開歌單「0921·王俊凯生日快乐」，`id` `9780162922`，網址 `https://y.qq.com/n/ryqq/playlist/9780162922`，15 首。一頁收完，`total` 15。這是活動歌單，日後可能下架；`checks.json` 的案例是重播用的，換歌單要重錄。
- 分頁（超過一頁）只有單元測試；真實的多頁行為只量到上面的「30 首一頁」（沒帶 `ct`、`cv` 時）與「一次回完 581 首」（帶了之後，一張使用者歌單，只用來量分頁，沒有提交）。
- 壞簽名與不存在的歌單各打一次，用來定錯誤對應。

## 開發

```sh
npm ci
npm test          # node --test
npm run build     # 產生 qqmusic.js（要提交）
```

改了 `src/` 要重新 build 並升 `build.mjs` 裡 manifest 的 `version`（根目錄 README〈版本〉）。
