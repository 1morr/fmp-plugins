// 網易雲音源（匿名）。行為以 FMP 舊專案 lib/data/sources/netease_source.dart 為規格，
// 用宿主 API v1 重寫：search 與 resolveStream，不登入。

import { aes128EcbEncrypt, hexUpper, utf8Bytes } from './aes.js';
import { error, responseCodeError, statusError, streamUnavailableError } from './errors.js';

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

/** 查詢類 POST，語意冪等，暫時失敗時由網路層重試（FMP ADR 0028）。 */
async function post(url, body, context) {
  const response = await fmp.http.request({
    url,
    method: 'POST',
    headers: API_HEADERS,
    body,
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
    if (song === null || typeof song !== 'object' || song.id === undefined || song.id === null) continue;
    const artists = (song.ar || song.artists || [])
      .map((a) => (a && typeof a.name === 'string' ? a.name : ''))
      .filter((n) => n !== '');
    const album = song.al || song.album;
    const dt = typeof song.dt === 'number' ? song.dt : song.duration;
    items.push({
      sourceId: String(song.id),
      title: typeof song.name === 'string' && song.name !== '' ? song.name : 'Unknown',
      uploader: artists.length > 0 ? artists.join(', ') : null,
      durationMs: typeof dt === 'number' && dt >= 0 ? Math.trunc(dt) : null,
      artwork: artwork(album && album.picUrl),
    });
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
