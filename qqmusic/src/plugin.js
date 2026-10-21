// QQ 音樂歌單匯入。行為以 FMP 舊專案 lib/data/sources/playlist_import/qq_music_playlist_source.dart
// 與 qq_music_sign.dart 為規格，用宿主 API v1 重寫。只宣告 importPlaylist，不登入、請求一律 auth: 'never'
// （FMP ADR 0012 §決定 7、ADR 0032 §決定 8）：外部歌曲只進匹配流程，不能播。

import { signOf } from './sign.js';

const ENDPOINT = 'https://u6.y.qq.com/cgi-bin/musics.fcg';
// 舊專案的 header。
const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Linux; Android 10) AppleWebKit/537.36',
  Referer: 'https://y.qq.com/',
  'Content-Type': 'application/json',
};

// 要求每頁 1000 首（舊專案同）。伺服器可能給得更少（見 buildBody 的 ct/cv），所以下一頁的起點永遠是
// 「已收到的筆數」，不是起點加 1000。
const PAGE_SIZE = 1000;
const PLAYLIST_ID = /^[1-9]\d{0,15}$/;
// cursor：`v1:<下一頁的起點>`。每一頁都重新取 dirinfo，所以不用背歌單資料。
const CURSOR = /^v1:([1-9]\d{0,6})$/;

// i2.y.qq.com 與 c6.y.qq.com 是舊專案沒有的：現在的 App 分享出的是 `c6.y.qq.com/base/fcgi-bin/u?__=…` 短網址，
// 分享到微信的是 `i2.y.qq.com/n3/other/pages/details/playlist.html?…&id=<id>`（2026-10-21 查公開的分享連結）。
const QQ_HOSTS = ['y.qq.com', 'i.y.qq.com', 'i2.y.qq.com'];
// 與 manifest 的 allowedHosts 相同（含子網域）：封面網址不在這裡就不交給宿主（宿主會拒收整個回傳值）。
const ARTWORK_DOMAIN = 'y.qq.com';
const SHORT_HOSTS = ['c.y.qq.com', 'c6.y.qq.com', 'url.cn'];

// ---------------------------------------------------------------- 錯誤

function error(fmpError, message) {
  return { fmpError, message };
}

/** HTTP 狀態碼不是 200。 */
function statusError(status, context) {
  const detail = `${context}: HTTP ${status}`;
  return error(status >= 500 ? 'NetworkError' : 'UnexpectedError', detail);
}

// ---------------------------------------------------------------- 網址

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
 * QQ 網域的網址 → 歌單 id | null。舊專案認得三種：
 * `y.qq.com/n/ryqq/playlist/<id>`、舊版 `…/playlist/<id>.html`、分享頁 `…/taoge.html?id=<id>`；
 * 另加微信分享頁 `…/details/playlist.html?id=<id>`。
 * 與舊專案不同：id 只在 `playlist` 段之後或分享頁的 `id=` 找，不在整個網址裡找 `[?&]id=`。
 */
function playlistIdOfUrl(parts) {
  if (parts === null || !QQ_HOSTS.includes(parts.host)) return null;
  const segments = parts.path.split('/').filter((s) => s !== '');
  const at = segments.indexOf('playlist');
  if (at >= 0) {
    const id = (segments[at + 1] || '').replace(/\.html$/i, '');
    return PLAYLIST_ID.test(id) ? id : null;
  }
  const page = segments[segments.length - 1];
  if (page === 'taoge.html' || (page === 'playlist.html' && segments[segments.length - 2] === 'details')) {
    const m = /(?:^|&)id=(\d+)(?:&|$)/.exec(parts.query);
    return m !== null && PLAYLIST_ID.test(m[1]) ? m[1] : null;
  }
  return null;
}

/**
 * 網址 → {playlistId} | null。短網址（`c.y.qq.com`、`c6.y.qq.com`、`url.cn`；舊專案的 qqMusicShortHosts 沒有 c6）發一個請求
 * （GET，跟隨轉址，auth never）拿到轉址後的網址再認；轉址後不是 QQ 的歌單網址回 null，短網址失效（404）是 NotFound。
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
    headers: { 'User-Agent': HEADERS['User-Agent'], Accept: 'text/html,*/*' },
    auth: 'never',
  });
  if (response.status === 404) throw error('NotFound', 'short url: HTTP 404');
  if (response.status !== 200) throw statusError(response.status, 'short url');
  const playlistId = playlistIdOfUrl(typeof response.url === 'string' ? splitUrl(response.url) : null);
  return playlistId === null ? null : { playlistId };
}

// ---------------------------------------------------------------- importPlaylist

function buildBody(playlistId, songBegin) {
  return JSON.stringify({
    req_0: {
      module: 'music.srfDissInfo.aiDissInfo',
      method: 'uniform_get_Dissinfo',
      param: {
        disstid: Number(playlistId),
        enc_host_uin: '',
        tag: 1,
        userinfo: 1,
        song_begin: songBegin,
        song_num: PAGE_SIZE,
      },
    },
    // ct/cv 是舊專案沒有的：缺了它們匿名請求每頁只回 30 首（2026-10-21 實測，songlist 30、total 581、hasmore 1），
    // 舊專案的「起點加 1000」就此只收到第一頁。加了 ct 24、cv 0（手機網頁版的值）後一次回完。
    comm: { g_tk: 5381, uin: 0, format: 'json', platform: 'android', ct: 24, cv: 0 },
  });
}

/** 歌單封面。QQ 回的網址有 `?imageView2/4/w/600/h/600`（600 見方），原樣保留；不是 y.qq.com 底下的 https 網址就不給。 */
function artworkOf(picurl) {
  const url = typeof picurl === 'string' && picurl.startsWith('http://') ? `https://${picurl.slice(7)}` : picurl;
  const parts = typeof url === 'string' && url.startsWith('https://') ? splitUrl(url) : null;
  if (parts === null || !(parts.host === ARTWORK_DOMAIN || parts.host.endsWith(`.${ARTWORK_DOMAIN}`))) return [];
  return [{ url }];
}

/** 一首歌 → TrackSummary；缺 mid（舊專案的 originalSongId）或標題的略過回 null。 */
function trackOfSong(song) {
  if (song === null || typeof song !== 'object') return null;
  const mid = typeof song.mid === 'string' ? song.mid.trim() : '';
  if (mid === '' || mid.includes(':')) return null;
  const title = typeof song.name === 'string' ? song.name.trim() : '';
  if (title === '') return null;
  const singers = (Array.isArray(song.singer) ? song.singer : [])
    .map((s) => (s !== null && typeof s === 'object' && typeof s.name === 'string' ? s.name.trim() : ''))
    .filter((n) => n !== '');
  const track = { sourceId: mid, title };
  if (singers.length > 0) track.uploader = singers.join(' / ');
  if (Number.isSafeInteger(song.interval) && song.interval >= 0) track.durationMs = song.interval * 1000;
  return track;
}

export async function importPlaylist(input) {
  const { playlistId, cursor } = input || {};
  if (typeof playlistId !== 'string' || !PLAYLIST_ID.test(playlistId) || !Number.isSafeInteger(Number(playlistId))) {
    throw error('ParseError', `playlist: invalid playlistId: ${playlistId}`);
  }
  let begin = 0;
  if (cursor !== undefined && cursor !== null) {
    const m = typeof cursor === 'string' ? CURSOR.exec(cursor) : null;
    if (m === null) throw error('ParseError', 'playlist: malformed cursor');
    begin = Number(m[1]);
  }

  const body = buildBody(playlistId, begin);
  const response = await fmp.http.request({
    // 簽名只算 body，所以同一個請求的網址是固定的（舊專案另帶的 `_=<時間>` 是快取破壞參數，這裡不送）。
    url: `${ENDPOINT}?sign=${signOf(body, fmp.crypto.md5)}`,
    method: 'POST',
    headers: HEADERS,
    body,
    auth: 'never',
    idempotent: true, // 查詢，語意冪等
  });
  if (response.status !== 200) throw statusError(response.status, 'playlist');
  let json;
  try {
    json = JSON.parse(response.body);
  } catch (e) {
    throw error('ParseError', 'playlist: not JSON');
  }
  if (json === null || typeof json !== 'object' || Array.isArray(json)) throw error('ParseError', 'playlist: not an object');
  // 簽名被拒：HTTP 200，頂層與 req_0 的 code 都是 2000（2026-10-21 實測）。
  const req = json.req_0;
  if (json.code !== 0 || req === null || typeof req !== 'object' || req.code !== 0) {
    throw error('UnexpectedError', `playlist: code ${json.code}, req_0 code ${req && req.code}`);
  }
  const data = req.data;
  if (data === null || typeof data !== 'object') throw error('ParseError', 'playlist: no data');
  const info = data.dirinfo;
  // 不存在的歌單：data.code -100006、dirinfo 是空殼（title 空、songnum 0）。
  if (data.code === -100006 || (info !== null && typeof info === 'object' && info.title === '' && info.songnum === 0)) {
    throw error('NotFound', `playlist: data code ${data.code} ${data.msg || ''}`.trim());
  }
  if (data.code !== 0) throw error('UnexpectedError', `playlist: data code ${data.code} ${data.msg || ''}`.trim());
  if (info === null || typeof info !== 'object') throw error('ParseError', 'playlist: no dirinfo');
  if (typeof info.title !== 'string' || info.title.trim() === '') throw error('ParseError', 'playlist: no title');
  if (!Number.isSafeInteger(info.songnum) || info.songnum < 0) throw error('ParseError', 'playlist: bad songnum');
  if (!Array.isArray(data.songlist)) throw error('ParseError', 'playlist: no songlist');

  const playlist = { title: info.title.trim() };
  if (typeof info.desc === 'string' && info.desc.trim() !== '') playlist.description = info.desc.trim();
  const cover = artworkOf(info.picurl);
  if (cover.length > 0) playlist.artwork = cover;
  const creator = info.creator !== null && typeof info.creator === 'object' ? info.creator.nick : info.host_nick;
  if (typeof creator === 'string' && creator.trim() !== '') playlist.ownerName = creator.trim();

  const received = data.songlist.length;
  const items = [];
  for (const song of data.songlist) {
    const track = trackOfSong(song);
    if (track !== null) items.push({ track });
  }
  const next = begin + received;
  // 還有就繼續；伺服器這頁一首都沒給就停（否則 cursor 不前進），筆數對不上 total，宿主當不完整。
  const more = received > 0 && next < info.songnum;
  if (!more && next < info.songnum) {
    fmp.log.warn('playlist page empty before the end', { begin, songnum: info.songnum });
  }
  fmp.log.debug('playlist page', { begin, received, items: items.length, songnum: info.songnum });
  return {
    playlist,
    items,
    cursor: more ? `v1:${next}` : null,
    // 歌單標頭的筆數；跳過的歌（缺 mid）或伺服器沒給齊會讓回傳筆數少於它，宿主就不套用移除。
    total: info.songnum,
  };
}
