// 網易雲音源。行為以 FMP 舊專案 lib/data/sources/netease_source.dart 為規格，用宿主 API v1
// 重寫：search、resolveStream，加上 QR 登入（login，舊專案 netease_account_service.dart）。

import { aes128EcbEncrypt, hexUpper, utf8Bytes } from './aes.js';
import { credentialsRejected, error, responseCodeError, statusError, streamUnavailableError } from './errors.js';
import { accountOf, qrCredentials, qrStatusOf, verifyCookie } from './login.js';
import { weapiEncrypt } from './weapi.js';

const MUSIC = 'https://music.163.com';
const INTERFACE = 'https://interface3.music.163.com';

// 舊專案 SourceHttpPolicy 的網易 header。
const DESKTOP_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; WOW64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Safari/537.36 Chrome/91.0.4472.164 ' +
  'NeteaseMusicDesktop/3.0.18.203152';
const API_HEADERS = {
  Referer: 'https://music.163.com/',
  Origin: 'https://music.163.com',
  Accept: 'application/json, text/plain, */*',
  'User-Agent': DESKTOP_USER_AGENT,
  'Content-Type': 'application/x-www-form-urlencoded',
};
// 串流只帶播放需要的：不帶 Cookie（ADR 0012：媒體請求不帶憑證）。
const MEDIA_HEADERS = {
  Origin: 'https://music.163.com',
  Referer: 'https://music.163.com/',
  'User-Agent': DESKTOP_USER_AGENT,
};

// 與 manifest 的 allowedHosts 相同：網址不在這些網域就不交給宿主（宿主會拒收整個回傳值）。
const ALLOWED_DOMAINS = ['music.163.com', 'music.126.net'];

const SEARCH_PAGE_SIZE = 20;

// eapi（music.163.com 自己的客戶端用的加密，金鑰與分隔符逐字出自舊專案 NeteaseCrypto）。
const EAPI_KEY = 'e82ckenh8dichen8';
const EAPI_SEPARATOR = '-36cd479b6b5-';
const EAPI_PATH = '/api/song/enhance/player/url/v1';

// ---------------------------------------------------------------- 共用

function hostOf(url) {
  const match = /^https:\/\/([^/?#:]+)(?::\d+)?(?:[/?#]|$)/i.exec(url);
  return match ? match[1].toLowerCase() : null;
}

function isAllowedHttps(url) {
  const host = hostOf(url);
  return host !== null && ALLOWED_DOMAINS.some((d) => host === d || host.endsWith(`.${d}`));
}

/** 網易回 `http://`（舊專案實測）；它的 CDN 也接受 https，宿主只收 https。 */
function toHttps(url) {
  return typeof url === 'string' && url.startsWith('http://') ? `https://${url.slice(7)}` : url;
}

function form(fields) {
  return Object.entries(fields)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
    .join('&');
}

/**
 * 取流要帶的 `X-Real-IP`：網路出口在大陸以外時，有地區限制的歌不給網址（`code` 404、
 * `fee` 0），帶這個大陸位址就給（舊專案的值；2026-10-08 實測，見 README）。只在取流送，
 * 搜尋不需要。
 */
const MAINLAND_IP_HEADERS = { 'X-Real-IP': '118.88.88.88' };

/**
 * 查詢類 POST，語意冪等，暫時失敗時由網路層重試（FMP ADR 0028）。回 {json, credentialsAttached}；
 * 頂層 `code` 留給呼叫端判斷（importPlaylist 要分辨「讀不到」）。
 */
async function postRaw(url, body, context, extraHeaders, auth = 'userPreference') {
  const response = await fmp.http.request({
    url,
    method: 'POST',
    headers: { ...API_HEADERS, ...extraHeaders },
    body,
    auth, // ADR 0012：搜尋與取流依「以登入身分瀏覽與播放」帶憑證
    idempotent: true,
  });
  if (response.status !== 200) throw statusError(response.status, context);
  let json;
  try {
    json = JSON.parse(response.body);
  } catch (e) {
    throw error('ParseError', `${context}: not JSON`);
  }
  if (json === null || typeof json !== 'object') throw error('ParseError', `${context}: not an object`);
  // 憑證無效只在「這次請求真的帶了憑證」的回應上成立（design §6.5）。
  if (credentialsRejected(json, response.credentialsAttached)) {
    throw error('CredentialInvalid', `${context}: code 301 ${json.message || json.msg || ''}`.trim());
  }
  return { json, credentialsAttached: response.credentialsAttached === true };
}

/** 同 postRaw，但頂層 `code` 不是 200（或 0）就拋。 */
async function post(url, body, context, extraHeaders) {
  const { json } = await postRaw(url, body, context, extraHeaders);
  if (typeof json.code === 'number' && json.code !== 200 && json.code !== 0) {
    throw responseCodeError(json.code, json.message || json.msg, context);
  }
  return json;
}

/** eapi 的 params：`path-36cd479b6b5-json-36cd479b6b5-md5` 以 AES-128-ECB 加密，大寫 hex。 */
function eapiParams(path, data) {
  const text = JSON.stringify(data);
  const digest = fmp.crypto.md5(`nobody${path}use${text}md5forencrypt`);
  const payload = `${path}${EAPI_SEPARATOR}${text}${EAPI_SEPARATOR}${digest}`;
  return hexUpper(aes128EcbEncrypt(utf8Bytes(EAPI_KEY), utf8Bytes(payload)));
}

// ---------------------------------------------------------------- search

/** 封面方形檔位（舊專案 thumbnail_url_utils）：`?param=NyN`。 */
const ARTWORK_SIZES = [120, 200, 400];

function artwork(picUrl) {
  const base = toHttps(picUrl);
  if (typeof base !== 'string' || base === '' || !isAllowedHttps(base)) return [];
  const clean = base.split('?')[0];
  return ARTWORK_SIZES.map((size) => ({ url: `${clean}?param=${size}y${size}`, width: size }));
}

/** 搜尋結果與歌單裡的一首歌 → TrackSummary；不是歌曲物件或沒有 id 回 null。 */
function trackOfSong(song) {
  if (song === null || typeof song !== 'object' || song.id === undefined || song.id === null) return null;
  const artists = (song.ar || song.artists || [])
    .map((a) => (a && typeof a.name === 'string' ? a.name : ''))
    .filter((n) => n !== '');
  const album = song.al || song.album;
  const dt = typeof song.dt === 'number' ? song.dt : song.duration;
  return {
    sourceId: String(song.id),
    title: typeof song.name === 'string' && song.name !== '' ? song.name : 'Unknown',
    uploader: artists.length > 0 ? artists.join(', ') : null,
    durationMs: typeof dt === 'number' && dt >= 0 ? Math.trunc(dt) : null,
    artwork: artwork(album && album.picUrl),
  };
}

export async function search({ keyword, page }) {
  const offset = (page - 1) * SEARCH_PAGE_SIZE;
  const json = await post(
    `${MUSIC}/api/cloudsearch/pc`,
    form({ s: keyword, type: 1, limit: SEARCH_PAGE_SIZE, offset, total: true }),
    'search',
  );
  const result = json.result && typeof json.result === 'object' ? json.result : {};
  const songs = Array.isArray(result.songs) ? result.songs : [];
  const songCount = typeof result.songCount === 'number' ? result.songCount : 0;
  const items = [];
  for (const song of songs) {
    const track = trackOfSong(song);
    if (track !== null) items.push(track);
  }
  fmp.log.debug('search results', { count: items.length, total: songCount });
  return { items, hasMore: page * SEARCH_PAGE_SIZE < songCount };
}

// ---------------------------------------------------------------- resolveStream

/** 音質偏好 → eapi 的 level。不送 lossless（VIP 音質，舊專案的 high 才送）。 */
function levelFor(quality) {
  return quality === 'medium' || quality === 'low' ? 'standard' : 'exhigh';
}

/** 回應的 `type` → 宿主的容器與編碼；認不得的回 null。 */
function describe(type) {
  switch (String(type || '').toLowerCase()) {
    case 'mp3':
      return { container: 'mp3', codec: 'mp3' };
    case 'flac':
      return { container: 'flac', codec: 'flac' };
    case 'm4a':
    case 'aac':
      return { container: 'mp4', codec: 'aac' };
    default:
      return null;
  }
}

export async function resolveStream({ sourceId, formats, quality }) {
  if (!/^\d+$/.test(sourceId)) throw error('NotFound', `resolveStream: bad song id ${sourceId}`);
  const payload = { ids: [Number(sourceId)], level: levelFor(quality), encodeType: 'flac' };
  const json = await post(
    `${INTERFACE}/eapi/song/enhance/player/url/v1`,
    form({ params: eapiParams(EAPI_PATH, payload) }),
    'player',
    MAINLAND_IP_HEADERS,
  );
  const item = Array.isArray(json.data) ? json.data[0] : null;
  if (item === null || typeof item !== 'object') throw error('NotFound', 'player: no stream data');
  const url = toHttps(item.url);
  if (typeof url !== 'string' || url === '') throw streamUnavailableError(item, 'player');
  if (!isAllowedHttps(url)) throw error('ParseError', `player: unexpected host ${hostOf(url) || 'not https'}`);

  const format = describe(item.type);
  const wanted = format && (formats || []).some((f) => f.container === format.container && f.codec === format.codec);
  if (!wanted) throw error('NotFound', `player: no playable format (type ${item.type})`);

  const candidate = { url, headers: { ...MEDIA_HEADERS }, ...format };
  if (typeof item.br === 'number' && item.br > 0) candidate.bitrate = item.br;
  // 期限是 API 自己回報的有效秒數（`expi`），網址本身沒有期限參數。
  if (typeof item.expi === 'number' && item.expi > 0) candidate.expiresAt = Date.now() + item.expi * 1000;

  const result = { candidates: [candidate] };
  if (item.freeTrialInfo !== null && item.freeTrialInfo !== undefined) result.previewOnly = true;
  return result;
}

// ---------------------------------------------------------------- trackDetail

/**
 * 歌曲詳細：`POST music.163.com/api/v3/song/detail`（明文 form，`c=[{"id":N}]`，舊專案 `_getSongDetail`
 * 同一個端點），一個請求。只給回應真的有的欄位：`album`（`al.name`）與 `publishedAt`（歌曲的
 * `publishTime`，已經是 epoch 毫秒；多數歌是 0，0 或缺就不給）。這個端點沒有簡介、歌手頭像、統計：
 * 舊專案的頭像（`artist/head/info/get`）、專輯發行日（`album`）、留言數都是另外的請求，M3 不取。
 */
export async function trackDetail({ sourceId }) {
  // 超過 2^53 的 id 轉成 Number 會失真，查到的會是別首歌。
  if (typeof sourceId !== 'string' || !/^\d+$/.test(sourceId) || !Number.isSafeInteger(Number(sourceId))) {
    throw error('ParseError', `detail: bad song id ${sourceId}`);
  }
  const json = await post(
    `${MUSIC}/api/v3/song/detail`,
    form({ c: JSON.stringify([{ id: Number(sourceId) }]) }),
    'detail',
  );
  const song = Array.isArray(json.songs) ? json.songs[0] : null;
  if (song === null || song === undefined) throw error('NotFound', `detail: no song ${sourceId}`);
  if (typeof song !== 'object') throw error('ParseError', 'detail: song is not an object');
  const detail = {};
  const album = song.al || song.album;
  const name = album && typeof album.name === 'string' ? album.name.trim() : '';
  if (name !== '') detail.album = name;
  if (Number.isSafeInteger(song.publishTime) && song.publishTime > 0) detail.publishedAt = song.publishTime;
  return detail;
}

// ---------------------------------------------------------------- importPlaylist

// 規格是舊專案 netease_source.dart 的 parsePlaylist（`api/v6/playlist/detail` 拿 trackIds，
// 再以 `api/v3/song/detail` 每 400 個 id 一批補歌曲資料）、_extractPlaylistId 與 SourceUrlPolicy。
// QuickJS 沒有 URL，網址用正規式拆。

const NETEASE_HOSTS = ['music.163.com', 'y.music.163.com'];
const SHORT_HOSTS = ['163cn.tv'];
const PLAYLIST_ID = /^[1-9]\d{0,17}$/;
// 舊專案 _songDetailBatchSize；一頁就是一批 song/detail。
const PLAYLIST_PAGE_SIZE = 400;
// cursor：`v1:<trackIds 的起點，PLAYLIST_PAGE_SIZE 的倍數>:<0|1>`，後者是「以 required 送」（第一頁靠補登入才讀到的歌單，之後也要帶）。
// 每一頁都重新取 detail（歌單資料與完整的 trackIds 都在裡面），所以 cursor 不用背歌單資料或 id 清單。
const PLAYLIST_CURSOR = /^v1:(0|[1-9]\d{0,6}):([01])$/;
// 歌單讀不到：301 未登入、401／403 沒權限、404 不存在。
const PLAYLIST_DENIED_CODES = [301, 401, 403, 404];
const PLAYLIST_LOGIN_CODES = [301, 401, 403];
// song/detail 的 privilege.st 為 -200 是下架無版權（舊專案 `isAvailable = (st != -200)`）。
const ST_UNAVAILABLE = -200;

/** 網址 → {host, path, query, fragment}（http 與 https 都收，沒有 scheme 當 https）；不是 http(s) 回 null。 */
function splitUrl(raw) {
  const text = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`;
  const m = /^https?:\/\/([^/?#]+)([^?#]*)(?:\?([^#]*))?(?:#([\s\S]*))?$/i.exec(text);
  if (m === null || m[1].includes('@')) return null;
  return {
    host: m[1].replace(/:\d+$/, '').toLowerCase().replace(/\.+$/, ''),
    path: m[2],
    query: m[3] || '',
    fragment: m[4] || '',
  };
}

/** 路徑含 `playlist` 段時的歌單 id：`?id=<數字>`，否則 `playlist` 後面那一段（手機分享的 `/playlist/<id>/<uid>`）。 */
function playlistIdIn(path, query) {
  const segments = path.split('/').filter((s) => s !== '');
  const at = segments.indexOf('playlist');
  if (at < 0) return null;
  const fromQuery = /(?:^|&)id=(\d+)(?:&|$)/.exec(query);
  const id = fromQuery !== null ? fromQuery[1] : segments[at + 1];
  return typeof id === 'string' && PLAYLIST_ID.test(id) ? id : null;
}

/** 網易的網址（非短網址）→ 歌單 id | null。網頁版的歌單網址在 `#/` 後面，路徑與 fragment 都看。 */
function playlistIdOfUrl(parts) {
  if (parts === null || !NETEASE_HOSTS.includes(parts.host)) return null;
  const direct = playlistIdIn(parts.path, parts.query);
  if (direct !== null) return direct;
  const f = /^([^?]*)(?:\?(.*))?$/.exec(parts.fragment);
  return f === null ? null : playlistIdIn(f[1], f[2] || '');
}

/**
 * 網址 → {playlistId} | null。`163cn.tv` 短網址發一個請求（GET，跟隨轉址，auth never）拿到轉址後的網址再認；
 * 轉址後不是網易的歌單網址回 null，短網址已失效（404）是 NotFound。
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
    headers: { 'User-Agent': API_HEADERS['User-Agent'], Accept: 'text/html,*/*' },
    auth: 'never',
  });
  if (response.status === 404) throw error('NotFound', 'short url: HTTP 404');
  if (response.status !== 200) throw statusError(response.status, 'short url');
  const playlistId = playlistIdOfUrl(typeof response.url === 'string' ? splitUrl(response.url) : null);
  return playlistId === null ? null : { playlistId };
}

/** detail 回應是「讀不到」嗎：見 PLAYLIST_DENIED_CODES；200 卻沒有 playlist 也算（舊專案 "Playlist data not found"）。 */
function playlistDenied(json) {
  if (PLAYLIST_DENIED_CODES.includes(json.code)) return true;
  return json.code === 200 && (json.playlist === null || typeof json.playlist !== 'object');
}

/**
 * 詳情只給前幾首完整資料（tracks），其餘的 id 再以一個 song/detail 補（一批就是一頁，至多 PLAYLIST_PAGE_SIZE 個 id）。
 * 回 id（字串）→ 歌曲、id → privilege 兩張表與補了幾首。importPlaylist 與 chart 共用。
 */
async function songsOf(ids, detailTracks, detailPrivileges) {
  const songs = new Map();
  const privileges = new Map();
  const collect = (songList, privilegeList) => {
    for (const song of Array.isArray(songList) ? songList : []) {
      if (song !== null && typeof song === 'object' && song.id !== undefined && song.id !== null) songs.set(String(song.id), song);
    }
    for (const p of Array.isArray(privilegeList) ? privilegeList : []) {
      if (p !== null && typeof p === 'object' && p.id !== undefined && p.id !== null) privileges.set(String(p.id), p);
    }
  };
  collect(detailTracks, detailPrivileges);
  const missing = ids.filter((id) => !songs.has(String(id)));
  if (missing.length > 0) {
    const batch = await post(`${MUSIC}/api/v3/song/detail`, form({ c: JSON.stringify(missing.map((id) => ({ id }))) }), 'song detail');
    collect(batch.songs, batch.privileges);
  }
  return { songs, privileges, fetched: missing.length };
}

export async function importPlaylist(input) {
  const { playlistId, cursor } = input || {};
  if (typeof playlistId !== 'string' || !PLAYLIST_ID.test(playlistId)) {
    throw error('ParseError', `playlist: invalid playlistId: ${playlistId}`);
  }
  let offset = 0;
  let required = false;
  if (cursor !== undefined && cursor !== null) {
    const m = typeof cursor === 'string' ? PLAYLIST_CURSOR.exec(cursor) : null;
    if (m === null || Number(m[1]) % PLAYLIST_PAGE_SIZE !== 0) throw error('ParseError', 'playlist: malformed cursor');
    offset = Number(m[1]);
    required = m[2] === '1';
  }
  const detail = (auth) => postRaw(`${MUSIC}/api/v6/playlist/detail`, form({ id: playlistId }), 'playlist detail', undefined, auth);
  let res = await detail(required ? 'required' : 'userPreference');
  let retried = false;
  // 私人歌單：被拒、這次沒帶憑證、使用者有登入 → 以 required 重送一次（ADR 0032 §決定 2）。已帶憑證被拒不重送。
  if (playlistDenied(res.json) && !res.credentialsAttached && (await fmp.credentials.get()) !== null) {
    retried = true;
    required = true;
    res = await detail('required');
  }
  if (playlistDenied(res.json)) {
    const detailText = `playlist detail: code ${res.json.code} ${res.json.message || res.json.msg || ''}`.trim();
    if (!res.credentialsAttached && PLAYLIST_LOGIN_CODES.includes(res.json.code)) throw error('AuthRequired', detailText);
    throw error('NotFound', detailText);
  }
  if (res.json.code !== 200) throw responseCodeError(res.json.code, res.json.message || res.json.msg, 'playlist detail');
  const info = res.json.playlist;
  if (typeof info.name !== 'string' || info.name.trim() === '') throw error('ParseError', 'playlist detail: no name');
  if (!Array.isArray(info.trackIds)) throw error('ParseError', 'playlist detail: no trackIds');
  const ids = info.trackIds.map((t) => (t !== null && typeof t === 'object' ? t.id : undefined));
  if (!ids.every((id) => Number.isSafeInteger(id) && id > 0)) throw error('ParseError', 'playlist detail: bad trackIds');

  const playlist = { title: info.name.trim() };
  if (typeof info.description === 'string' && info.description.trim() !== '') playlist.description = info.description.trim();
  const cover = artwork(info.coverImgUrl);
  if (cover.length > 0) playlist.artwork = cover;
  const creator = info.creator !== null && typeof info.creator === 'object' ? info.creator : {};
  if (typeof creator.nickname === 'string' && creator.nickname !== '') playlist.ownerName = creator.nickname;

  const slice = ids.slice(offset, offset + PLAYLIST_PAGE_SIZE);
  const { songs, privileges, fetched } = await songsOf(slice, info.tracks, res.json.privileges);
  const items = [];
  for (const id of slice) {
    const track = trackOfSong(songs.get(String(id)));
    if (track === null) continue; // 歌曲資料取不到（已被刪除）：沒有可匯入的內容
    const privilege = privileges.get(String(id));
    items.push(privilege && privilege.st === ST_UNAVAILABLE ? { track, unavailable: true } : { track });
  }
  fmp.log.debug('playlist page', { offset, ids: slice.length, fetched, items: items.length, retried });
  return {
    playlist,
    items,
    cursor: offset + PLAYLIST_PAGE_SIZE < ids.length ? `v1:${offset + PLAYLIST_PAGE_SIZE}:${required ? 1 : 0}` : null,
    // 歌單自己的 id 清單長度；歌曲資料取不到的 id 會讓筆數少於它，宿主就當不完整、不套用移除。
    total: ids.length,
  };
}

// ---------------------------------------------------------------- charts

// 規格是舊專案 netease_source.dart 的 getHotRankingTracks：官方熱歌榜歌單 3778678，取前 50 個 trackId，
// 歌曲資料的取法同 importPlaylist（詳情自帶的前幾首加一個 song/detail 補齊），順序是歌單的順序。
const HOT_PLAYLIST_ID = '3778678';
const HOT_LIMIT = 50;
const CHARTS = [{ chartId: 'hot', title: '熱歌榜' }];

export function chartList() {
  return { charts: CHARTS.map(({ chartId, title }) => ({ chartId, title })) };
}

export async function chart({ chartId }) {
  if (!CHARTS.some((entry) => entry.chartId === chartId)) throw error('NotFound', `chart: no such chart: ${chartId}`);
  const { json } = await postRaw(`${MUSIC}/api/v6/playlist/detail`, form({ id: HOT_PLAYLIST_ID }), 'chart detail');
  if (json.code !== 200) throw responseCodeError(json.code, json.message || json.msg, 'chart detail');
  const info = json.playlist;
  if (info === null || typeof info !== 'object' || !Array.isArray(info.trackIds)) throw error('ParseError', 'chart detail: no trackIds');
  const ids = info.trackIds.slice(0, HOT_LIMIT).map((t) => (t !== null && typeof t === 'object' ? t.id : undefined));
  if (!ids.every((id) => Number.isSafeInteger(id) && id > 0)) throw error('ParseError', 'chart detail: bad trackIds');
  const { songs, fetched } = await songsOf(ids, info.tracks, json.privileges);
  // song/detail 的回傳順序不保證，照榜單的 id 順序排；取不到歌曲資料的 id 略過。
  const tracks = ids.map((id) => trackOfSong(songs.get(String(id)))).filter((track) => track !== null);
  fmp.log.debug('chart', { ids: ids.length, fetched, tracks: tracks.length });
  return { tracks };
}

// ---------------------------------------------------------------- login (QR)

// 舊專案 QR 請求固定帶的匿名 Cookie（偽裝 Windows 客戶端；值都是公開常量，
// `MUSIC_U`、`__csrf` 是空的）。netease_account_service.dart。
const QR_COOKIE =
  'os=pc; osver=Microsoft-Windows-10-Professional-build-10586-64bit; ' +
  'appver=2.7.1.198277; channel=netease; __csrf=; MUSIC_U=';

const QR_LOGIN_URL = `${MUSIC}/login?codekey=`;

/**
 * weapi 請求，回 `{json, headers}`。和 post() 不同：業務碼（800–803 是狀態不是錯誤）留給呼叫端
 * 判斷，回應 header 也交回（要讀 Set-Cookie）。HTTP 非 200 與不是 JSON 照舊拋。
 */
async function weapiPost(path, data, context, idempotent) {
  const { params, encSecKey } = weapiEncrypt(data);
  const response = await fmp.http.request({
    url: `${MUSIC}/weapi/${path}?csrf_token=`,
    method: 'POST',
    headers: { ...API_HEADERS, Cookie: QR_COOKIE },
    body: form({ params, encSecKey }),
    auth: 'never',
    idempotent,
  });
  if (response.status !== 200) throw statusError(response.status, context);
  let json;
  try {
    json = JSON.parse(response.body);
  } catch (e) {
    throw error('ParseError', `${context}: not JSON`);
  }
  if (json === null || typeof json !== 'object') throw error('ParseError', `${context}: not an object`);
  return { json, headers: response.headers || {} };
}

export async function loginQrStart() {
  const { json } = await weapiPost('login/qrcode/unikey', { type: 1 }, 'qr start', true);
  if (json.code !== 200) throw responseCodeError(json.code, json.message || json.msg, 'qr start');
  if (typeof json.unikey !== 'string' || json.unikey === '') {
    throw error('ParseError', 'qr start: no unikey');
  }
  return { qrText: `${QR_LOGIN_URL}${json.unikey}`, token: json.unikey };
}

export async function loginQrPoll(token) {
  // 不重試：803 的回應只有這一次帶 cookie。
  const { json, headers } = await weapiPost(
    'login/qrcode/client/login',
    { type: 1, key: token },
    'qr poll',
    false,
  );
  const status = qrStatusOf(json.code);
  if (status === null) throw responseCodeError(json.code, json.message || json.msg, 'qr poll');
  if (status !== 'done') return { status };
  return { status, credentials: qrCredentials(headers['set-cookie'], json.cookie) };
}

/** 用傳入的憑證自己組 Cookie、不讓宿主注入（auth: never）。 */
// cookie 給了：loginVerify，自己組 Cookie、標 never（宿主規定的注入方式）。沒給：libraryPlaylists 查自己的 uid，
// 憑證交給宿主注入（required），網路紀錄才記得到 credentials。
async function accountRequest(method, path, cookie) {
  const headers = {
    Referer: API_HEADERS.Referer,
    Origin: API_HEADERS.Origin,
    Accept: API_HEADERS.Accept,
    'User-Agent': API_HEADERS['User-Agent'],
  };
  if (cookie !== undefined) headers.Cookie = cookie;
  return fmp.http.request({
    url: `${MUSIC}${path}`,
    method,
    headers,
    auth: cookie === undefined ? 'required' : 'never',
  });
}

/**
 * account/get → LoginAccount（舊專案 GET 失敗就改打 POST）。loginVerify 給 cookie；libraryPlaylists 不給，由宿主注入。
 */
async function fetchAccount(cookie) {
  let response = await accountRequest('GET', '/api/nuser/account/get', cookie);
  // 舊專案 GET 失敗就改打 POST /api/w/nuser/account/get。
  if (response.status !== 200) {
    response = await accountRequest('POST', '/api/w/nuser/account/get', cookie);
  }
  if (response.status !== 200) throw statusError(response.status, 'verify');
  let json;
  try {
    json = JSON.parse(response.body);
  } catch (e) {
    throw error('ParseError', 'verify: not JSON');
  }
  return accountOf(json, responseCodeError, artwork);
}

export async function loginVerify(credentials) {
  return fetchAccount(verifyCookie(credentials));
}

// ---------------------------------------------------------------- libraryRead

// 規格是舊專案 netease_playlist_service.dart 的 getPlaylists：linux forward 的 `user/playlist`（payload 為
// {method, url, params} 以 AES-128-ECB 加密成 eparams，金鑰是舊專案的 _linuxApiKey），回自己建立的與收藏的歌單；
// 建立者是自己的才可寫（舊版 isMine）。舊版 uid 來自登入時存的帳號；這裡的憑證沒有 uid，所以每次先打 account/get。
const LINUX_API_KEY = 'rFgB&h#%2?^eDg:Q';
const LINUX_USER_AGENT =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/60.0.3112.90 Safari/537.36';
const LIBRARY_PAGE_SIZE = 1000; // 舊版的 limit
const LIBRARY_CURSOR = /^v1:([1-9]\d{0,6})$/;

export async function libraryPlaylists(input) {
  const { cursor } = input || {};
  let offset = 0;
  if (cursor !== undefined && cursor !== null) {
    const m = typeof cursor === 'string' ? LIBRARY_CURSOR.exec(cursor) : null;
    if (m === null) throw error('ParseError', 'user playlists: malformed cursor');
    offset = Number(m[1]);
  }
  const credentials = await fmp.credentials.get();
  if (credentials === null || credentials === undefined) throw error('AuthRequired', 'user playlists: not logged in');
  const { userId: uid } = await fetchAccount();
  const payload = JSON.stringify({ method: 'POST', url: `${MUSIC}/api/user/playlist`, params: { uid, limit: LIBRARY_PAGE_SIZE, offset } });
  const eparams = hexUpper(aes128EcbEncrypt(utf8Bytes(LINUX_API_KEY), utf8Bytes(payload)));
  const { json } = await postRaw(
    `${MUSIC}/api/linux/forward`,
    form({ eparams }),
    'user playlists',
    { 'User-Agent': LINUX_USER_AGENT },
    'required',
  );
  if (json.code !== 200) throw responseCodeError(json.code, json.message || json.msg, 'user playlists');
  if (!Array.isArray(json.playlist)) throw error('ParseError', 'user playlists: no playlist list');
  const playlists = [];
  const seen = new Set();
  for (const item of json.playlist) {
    if (item === null || typeof item !== 'object' || item.id === undefined || item.id === null) continue;
    const playlistId = String(item.id);
    if (!PLAYLIST_ID.test(playlistId) || seen.has(playlistId)) continue;
    seen.add(playlistId);
    const title = typeof item.name === 'string' && item.name.trim() !== '' ? item.name.trim() : playlistId;
    const creator = item.creator !== null && typeof item.creator === 'object' ? item.creator : {};
    const entry = { playlistId, title, writable: creator.userId !== undefined && creator.userId !== null && String(creator.userId) === uid };
    const art = artwork(item.coverImgUrl);
    if (art.length > 0) entry.artwork = art;
    if (Number.isInteger(item.trackCount) && item.trackCount >= 0) entry.trackCount = item.trackCount;
    playlists.push(entry);
  }
  fmp.log.debug('user playlists page', { offset, playlists: playlists.length });
  return { playlists, cursor: json.more === true && json.playlist.length > 0 ? `v1:${offset + json.playlist.length}` : null };
}
