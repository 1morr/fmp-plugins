// Spotify 歌單匯入。行為以 FMP 舊專案 lib/data/sources/playlist_import/spotify_playlist_source.dart 為規格，
// 用宿主 API v1 重寫：抓 `open.spotify.com/embed/playlist/<id>` 的 `__NEXT_DATA__`，匿名、不帶任何憑證。
//
// 與舊專案的差異（2026-10-21 匿名實測，見 README）：
// - 曲目 id 取 `uri`（`spotify:track:<id>`）；舊專案取的 `uid` 是十六進位的內部字串，不是曲目 id。
// - 歌手分隔是 `,` 加 U+00A0（不斷行空白），舊專案用 `, ` 切，實際切不開。
// - embed 頁的 `trackList` 最多 100 首，頁面沒有總數：剛好 100 首時無法確認有沒有被截斷，
//   回 truncated: true（見 importPlaylist）。

const EMBED = 'https://open.spotify.com/embed/playlist';
const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

// 舊專案 SourceUrlPolicy.spotifyHosts／spotifyShortHosts。
const SPOTIFY_HOSTS = ['open.spotify.com'];
const SHORT_HOSTS = ['spotify.link'];
const PLAYLIST_ID = /^[A-Za-z0-9]{1,64}$/;
// embed 頁的 trackList 上限（實測 150 首的官方歌單只回 100 首）。
const EMBED_TRACK_LIMIT = 100;
// 與 manifest 的 allowedHosts 相同：網址不在這些網域就不交給宿主（宿主會拒收整個回傳值）。
const ARTWORK_DOMAINS = ['scdn.co'];
// trackList[].subtitle 的歌手分隔：`,` 加 U+00A0（不斷行空白）。
const ARTIST_SEPARATOR = /,\u00A0+/;

function error(fmpError, message, extra) {
  return { fmpError, message, ...extra };
}

/** 網址 → {host, path, query}（http 與 https 都收，沒有 scheme 當 https）；不是 http(s) 回 null。QuickJS 沒有 URL。 */
function splitUrl(raw) {
  const text = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`;
  const m = /^https?:\/\/([^/?#]+)([^?#]*)(?:\?([^#]*))?(?:#[\s\S]*)?$/i.exec(text);
  if (m === null || m[1].includes('@')) return null;
  return {
    host: m[1].replace(/:\d+$/, '').toLowerCase().replace(/\.+$/, ''),
    path: m[2],
    query: m[3] || '',
  };
}

/**
 * open.spotify.com 的歌單網址 → 歌單 id | null。路徑是 `/playlist/<id>`，或 Spotify 的地區前綴
 * `/intl-<語言>/playlist/<id>`；`?si=…` 之類的 query 忽略。
 */
function playlistIdOfUrl(parts) {
  if (parts === null || !SPOTIFY_HOSTS.includes(parts.host)) return null;
  const segments = parts.path.split('/').filter((s) => s !== '');
  if (segments.length > 0 && /^intl-[a-z]{2,3}(?:-[a-z0-9]+)?$/i.test(segments[0])) segments.shift();
  if (segments.length < 2 || segments[0] !== 'playlist') return null;
  return PLAYLIST_ID.test(segments[1]) ? segments[1] : null;
}

/** 錯誤對應：狀態碼 → 結構化錯誤。429 與傳輸錯誤由宿主的網路層轉換，這裡不處理。 */
function statusError(status, context) {
  const detail = `${context}: HTTP ${status}`;
  if (status === 404) return error('NotFound', detail);
  if (status >= 500) return error('NetworkError', detail);
  return error('UnexpectedError', detail);
}

/**
 * 網址 → {playlistId} | null。`spotify.link` 短網址發一個請求（GET，跟隨轉址，auth never）拿到轉址後的網址再認；
 * 轉址後不是 Spotify 的歌單網址回 null，短網址已失效（404）是 NotFound。
 */
export async function playlistFromUrl(input) {
  const raw = input && typeof input.url === 'string' ? input.url.trim() : '';
  if (raw === '') return null;
  const parts = splitUrl(raw);
  if (parts === null) return null;
  if (!SHORT_HOSTS.includes(parts.host)) {
    const playlistId = playlistIdOfUrl(parts);
    return playlistId === null ? null : { playlistId };
  }
  const response = await fmp.http.request({
    url: `https://${parts.host}${parts.path}${parts.query === '' ? '' : `?${parts.query}`}`,
    method: 'GET',
    headers: { 'User-Agent': USER_AGENT, Accept: 'text/html,*/*' },
    auth: 'never',
  });
  if (response.status !== 200) throw statusError(response.status, 'short url');
  const playlistId = playlistIdOfUrl(typeof response.url === 'string' ? splitUrl(response.url) : null);
  return playlistId === null ? null : { playlistId };
}

/** HTML → `__NEXT_DATA__` 的 JSON 物件；找不到或不是合法 JSON 回 null。 */
function nextDataOf(html) {
  const match = /<script\s+id="__NEXT_DATA__"\s+type="application\/json">([\s\S]*?)<\/script>/.exec(html);
  if (match === null) return null;
  try {
    const json = JSON.parse(match[1]);
    return json !== null && typeof json === 'object' ? json : null;
  } catch (e) {
    return null;
  }
}

function dig(value, path) {
  let current = value;
  for (const key of path) {
    if (current === null || typeof current !== 'object') return undefined;
    current = current[key];
  }
  return current;
}

function nonEmptyString(value) {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

/** 封面：`coverArt.sources[]` 裡在 allowedHosts 的 https 網址；沒有尺寸資訊就不給 width。 */
function artworkOf(coverArt) {
  const sources = dig(coverArt, ['sources']);
  if (!Array.isArray(sources)) return [];
  const result = [];
  for (const source of sources) {
    const url = source !== null && typeof source === 'object' ? source.url : null;
    const host = typeof url === 'string' ? /^https:\/\/([^/?#:]+)(?::\d+)?(?:[/?#]|$)/i.exec(url) : null;
    if (host === null) continue;
    const h = host[1].toLowerCase();
    if (!ARTWORK_DOMAINS.some((d) => h === d || h.endsWith(`.${d}`))) continue;
    const entry = { url };
    if (Number.isInteger(source.width) && source.width > 0) entry.width = source.width;
    result.push(entry);
  }
  return result;
}

/** `trackList` 的一項 → TrackSummary；不是曲目（單集、本機檔案 `spotify:local:…` 等）、沒有 id 或沒有標題回 null。 */
function trackOfItem(item) {
  if (item === null || typeof item !== 'object') return null;
  const id = typeof item.uri === 'string' ? /^spotify:track:([A-Za-z0-9]+)$/.exec(item.uri) : null;
  const title = nonEmptyString(item.title);
  if (id === null || title === null) return null;
  // subtitle 是歌手名，分隔是 `,` 加 U+00A0。只切這個：名字本身的逗號後面是一般空白（Tyler, The Creator），
  // 不能切開；分隔若改成一般空白，整串當一位歌手（匹配仍可用），不會把名字切錯。
  const artists =
    typeof item.subtitle === 'string'
      ? item.subtitle.split(ARTIST_SEPARATOR).map((a) => a.trim()).filter((a) => a !== '')
      : [];
  const track = { sourceId: id[1], title };
  if (artists.length > 0) track.uploader = artists.join(' / ');
  if (Number.isFinite(item.duration) && item.duration >= 0) track.durationMs = Math.trunc(item.duration);
  return track;
}

export async function importPlaylist(input) {
  const { playlistId, cursor } = input || {};
  if (typeof playlistId !== 'string' || !PLAYLIST_ID.test(playlistId)) {
    throw error('ParseError', `playlist: invalid playlistId: ${playlistId}`);
  }
  if (cursor !== undefined && cursor !== null) {
    // 只有一頁，沒有發出過 cursor。
    throw error('ParseError', 'playlist: malformed cursor');
  }

  const response = await fmp.http.request({
    url: `${EMBED}/${playlistId}`,
    method: 'GET',
    headers: { 'User-Agent': USER_AGENT, 'Accept-Language': 'en', Accept: 'text/html,*/*' },
    auth: 'never',
    idempotent: true,
  });
  if (response.status !== 200) throw statusError(response.status, 'playlist embed');
  const data = nextDataOf(typeof response.body === 'string' ? response.body : '');
  if (data === null) throw error('ParseError', 'playlist embed: no __NEXT_DATA__');
  // 歌單不存在（或私人）：HTTP 200，但 pageProps 是 `{status: 404, title: 'Page not found'}`。
  if (dig(data, ['props', 'pageProps', 'status']) === 404) throw error('NotFound', 'playlist embed: page not found');
  const entity = dig(data, ['props', 'pageProps', 'state', 'data', 'entity']);
  if (entity === null || typeof entity !== 'object') throw error('ParseError', 'playlist embed: no entity');
  const title = nonEmptyString(entity.name) ?? nonEmptyString(entity.title);
  if (title === null) throw error('ParseError', 'playlist embed: no name');
  if (!Array.isArray(entity.trackList)) throw error('ParseError', 'playlist embed: no trackList');

  const playlist = { title };
  const owner = nonEmptyString(entity.subtitle);
  if (owner !== null) playlist.ownerName = owner;
  const attributes = Array.isArray(entity.attributes) ? entity.attributes : [];
  const description = attributes.find((a) => a !== null && typeof a === 'object' && a.key === 'episode_description');
  if (description && nonEmptyString(description.value) !== null) playlist.description = description.value.trim();
  const cover = artworkOf(entity.coverArt);
  if (cover.length > 0) playlist.artwork = cover;

  const items = [];
  for (const item of entity.trackList) {
    const track = trackOfItem(item);
    if (track !== null) items.push({ track });
  }
  // 以原始筆數判斷，不是解析出的 items：被略過的項目不能讓截斷看起來像完整。
  const truncated = entity.trackList.length >= EMBED_TRACK_LIMIT;
  fmp.log.debug('playlist embed', { raw: entity.trackList.length, items: items.length, truncated });
  // 頁面沒有總數，所以不給 total（給了就等於聲稱知道）。
  // 只有一頁：cursor 為空；剛好是上限時 truncated: true（遠端可能還有更多）。
  return truncated ? { playlist, items, cursor: null, truncated: true } : { playlist, items, cursor: null };
}
