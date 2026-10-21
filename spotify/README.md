# spotify

Spotify 歌單匯入，匿名、不需要登入。行為以 FMP 舊專案的 `lib/data/sources/playlist_import/spotify_playlist_source.dart` 為規格，用宿主 API v1 重寫。

Spotify 的曲目不能直接播放：插件只提供曲目清單（標題、歌手、時長），宿主把它們拿去其他音源匹配。

## 能力

只宣告 `importPlaylist`，請求一律 `auth: 'never'`（FMP ADR 0012 §決定 7），不讀也不存任何憑證。

- `playlistFromUrl`：認 `open.spotify.com/playlist/<id>`（可帶 `?si=…` 等 query）與地區前綴 `open.spotify.com/intl-<語言>/playlist/<id>`。`spotify.link` 短網址（舊專案支援）發一個 GET 跟隨轉址，轉址後是歌單網址才認。舊專案不認 `spotify:playlist:<id>`，這裡也不認。
- `importPlaylist`：`GET open.spotify.com/embed/playlist/<id>`，解析頁面的 `<script id="__NEXT_DATA__">`，路徑 `props.pageProps.state.data.entity`。
  - 歌單：`name`（缺時 `title`）、`subtitle`（擁有者，官方歌單是 `Spotify`）、`coverArt.sources[].url`（`i.scdn.co`，沒有尺寸）、`attributes` 裡 `episode_description`（官方歌單的簡介，有才給）。
  - 曲目（`trackList[]`）：`sourceId` 是 `uri`（`spotify:track:<id>`）的 `<id>`；`title`；`uploader` 是 `subtitle` 的歌手以 ` / ` 連接；`durationMs` 是 `duration`。沒有封面。`uri` 不是曲目（單集、本機檔案 `spotify:local:…`）或沒有標題的項目略過。
  - 錯誤：歌單不存在或私人時頁面是 **HTTP 200**，`pageProps` 為 `{status: 404, title: 'Page not found'}` → `NotFound`（HTTP 404 也是）；5xx → `NetworkError`；其他非 200 → `UnexpectedError`；找不到 `__NEXT_DATA__`、JSON 壞掉、沒有 `entity`／名稱／`trackList` → `ParseError`。429 與傳輸錯誤由宿主的網路層處理。

## 與舊專案的差異（2026-10-21 匿名實測）

- 舊專案取 `uid` 當曲目 id；`uid` 是十六進位的內部字串（例如 `6e4a782b54436844635930`），不是 Spotify 曲目 id。這裡取 `uri`。
- 歌手分隔是 `,` 加 U+00A0（不斷行空白），舊專案用 `, ` 切，實際切不開（整串當成一位歌手）。這裡只切 `,` 加 U+00A0：名字本身的逗號後面是一般空白（`Tyler, The Creator`），不會被切開。
- 舊專案說 embed 頁「包含完整的曲目列表」，現在不是。

## 完整性：embed 頁最多 100 首

2026-10-21 實測：

| 歌單（Spotify 官方） | `trackList` 筆數 | 頁面上的總數欄位 |
|---|---|---|
| Today's Top Hits（`37i9dQZF1DXcBWIGoYBM5M`） | 50 | 沒有 |
| All Out 2010s（`37i9dQZF1DX5Ejj0EkURtP`，Spotify 的 App 顯示 150 首，頁面本身沒有這個數字） | **100** | 沒有 |

`entity` 沒有任何筆數欄位；超過 100 首的歌單被截在 100 首（實測只有上面這一張，其他歌單未試）。所以插件不給 `total`（給了就是聲稱知道），並且：

- `trackList` 少於 100 筆：整張歌單，回傳 `cursor: null`、不帶 `truncated`。
- `trackList` 剛好 100 筆（以原始筆數判斷，被略過的項目不影響）：回 `cursor: null, truncated: true`，意思是插件讀完了它讀得到的，遠端可能還有更多（`PlaylistPage.truncated`，只能在最後一頁）。宿主匯入這 100 首並提示。
- 沒有第二頁：任何 `cursor` 都是 `ParseError`。
- 剛好 100 首的歌單也會帶 `truncated: true`，因為頁面分辨不出。

要匿名取得 100 首以後的曲目，要用 Spotify 網頁播放器自己的 GraphQL／Web API（`api.spotify.com/v1/playlists/<id>/tracks` 或 `api-partner.spotify.com` 的 `fetchPlaylist`），那需要 bearer token。embed 頁的 `settings.session.accessToken` 是匿名 token，但這是從頁面 scrape 授權，而且 Spotify 對這類 token 的政策與可用範圍會變。本插件沒有做；是否要做是產品決定。

## 固定資料

- `fixtures/importPlaylist/001.json`：Today's Top Hits 的 embed 頁，命令列錄製，未經手工編輯。`accessToken` 與 `Set-Cookie` 的值已由宿主的遮蔽閘門換成 `***`；內容只有 Spotify 官方歌單與曲目，沒有使用者資訊。
- `checks.json` 的 `importPlaylist` 用同一張歌單。

## 建置與測試

```sh
npm ci
npm run build   # 產生 spotify.js（提交）
npm test        # 單元測試（假宿主，不連網）
```
