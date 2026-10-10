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

/** 查詢類 POST，語意冪等，暫時失敗時由網路層重試（FMP ADR 0028）。 */
async function post(url, body, context, extraHeaders) {
  const response = await fmp.http.request({
    url,
    method: 'POST',
    headers: { ...API_HEADERS, ...extraHeaders },
    body,
    auth: 'userPreference', // ADR 0012：搜尋與取流依「以登入身分瀏覽與播放」帶憑證
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
async function accountRequest(method, path, cookie) {
  return fmp.http.request({
    url: `${MUSIC}${path}`,
    method,
    headers: {
      Referer: API_HEADERS.Referer,
      Origin: API_HEADERS.Origin,
      Accept: API_HEADERS.Accept,
      'User-Agent': API_HEADERS['User-Agent'],
      Cookie: cookie,
    },
    auth: 'never',
  });
}

export async function loginVerify(credentials) {
  const cookie = verifyCookie(credentials);
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
