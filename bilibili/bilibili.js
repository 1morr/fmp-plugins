/* ==FMP Plugin==
{
  "id": "bilibili",
  "name": "Bilibili",
  "version": "1.1.0",
  "author": "FMP",
  "description": "搜尋 Bilibili 影片並播放其音訊，可用 QR 碼登入。",
  "apiVersion": 1,
  "capabilities": ["search", "resolveStream", "login"],
  "allowedHosts": [
    "api.bilibili.com",
    "passport.bilibili.com",
    "hdslb.com",
    "bilivideo.com",
    "bilivideo.cn",
    "upos-hz-mirrorakam.akamaized.net"
  ],
  "login": { "methods": ["qr"] },
  "rateLimit": { "maxConcurrentRequests": 2, "minRequestIntervalMs": 300 },
  "redaction": {
    "headerNames": [
      "X-Bili-Metadata-Ip-Region",
      "X-Bili-Metadata-Legal-Region",
      "X-Bili-Gaia-Vvoucher"
    ],
    "keyNames": [
      "buvid",
      "buvid3",
      "buvid4",
      "buvid_fp",
      "_uuid",
      "b_nut",
      "bili_ticket",
      "v_voucher",
      "w_rid",
      "wts",
      "hdnts",
      "ip_region",
      "refresh_token",
      "qrcode_key"
    ]
  }
}
==/FMP Plugin== */

// B 站音源。行為以 FMP 舊專案 lib/data/sources/bilibili_source.dart 為規格，用宿主 API v1
// 重寫：search 與 resolveStream（依「以登入身分瀏覽與播放」帶憑證，沒有就匿名），加上 QR 登入
//（login，舊專案 bilibili_account_service.dart）。

const API = 'https://api.bilibili.com';

// 舊專案 HttpClientFactory.defaultUserAgent（API）與 SourceHttpPolicy.mediaUserAgent（媒體）。
const API_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';
const MEDIA_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

// API 的 Referer 帶結尾斜線，媒體的不帶（舊專案 SourceHttpPolicy 刻意如此）。
const API_HEADERS = {
  Referer: 'https://www.bilibili.com/',
  Origin: 'https://www.bilibili.com',
  Accept: 'application/json, text/plain, */*',
  'User-Agent': API_USER_AGENT,
};
const SEARCH_HEADERS = {
  ...API_HEADERS,
  Referer: 'https://search.bilibili.com/',
  Origin: 'https://search.bilibili.com',
  'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
};
// 串流只帶播放需要的：不帶 Cookie（ADR 0012：媒體請求不帶憑證）。
const MEDIA_HEADERS = {
  Referer: 'https://www.bilibili.com',
  'User-Agent': MEDIA_USER_AGENT,
};

// 與 manifest 的 allowedHosts 相同：串流網址不在這些網域就不交給宿主（宿主會拒收整個回傳值）。
const MEDIA_HOSTS = ['bilivideo.com', 'bilivideo.cn', 'upos-hz-mirrorakam.akamaized.net'];

const SEARCH_PAGE_SIZE = 20;

// playurl 參數（舊專案 _BilibiliApiParams）。
const FNVAL_DASH = 16;
const FNVAL_DURL = 0;
const QN_DEFAULT = 0;
const QN_HIGH = 120;

// ---------------------------------------------------------------- 錯誤

// 風控碼：一律限流，由上層退避（舊專案 BilibiliApiException.riskControlCodes）。
const RISK_CONTROL_CODES = [-352, -412, -509, -799];

function error(fmpError, message, extra) {
  return { fmpError, message, ...extra };
}

/** 業務錯誤碼 → 結構化錯誤。 */
function businessError(code, message, context) {
  const detail = `${context}: code ${code} ${message || ''}`.trim();
  if (RISK_CONTROL_CODES.includes(code)) return error('RateLimited', detail);
  switch (code) {
    case -101: // 未登入
    case -111: // csrf 驗證失敗（憑證的 bili_jct 與 SESSDATA 對不上）
    case -403: // 權限不足
      return error('AuthRequired', detail);
    case -404: // 啥都木有
    case 62002: // 稿件不可見
    case 62004: // 稿件審核中
    case 62012: // 僅 UP 主自己可見
      return error('NotFound', detail);
    case -10403: // 地區限制
      return error('Unavailable', detail, { reason: 'region' });
    case 87007: // 充電專屬
    case 87008:
      return error('Unavailable', detail, { reason: 'membership' });
    case -503: // 服務調用超時
      return error('NetworkError', detail);
    default:
      return error('UnexpectedError', detail);
  }
}

/** HTTP 狀態碼 → 結構化錯誤；429 宿主已經轉成 RateLimited。 */
function statusError(status, context) {
  const detail = `${context}: HTTP ${status}`;
  if (status === 412) return error('RateLimited', detail);
  if (status >= 500) return error('NetworkError', detail);
  return error('UnexpectedError', detail);
}

function parseJson(response, context) {
  if (response.status !== 200) throw statusError(response.status, context);
  try {
    return JSON.parse(response.body);
  } catch (e) {
    throw error('ParseError', `${context}: not JSON`);
  }
}

/** code 不是 0 就拋。 */
function checkCode(json, context) {
  if (json === null || typeof json !== 'object') {
    throw error('ParseError', `${context}: not an object`);
  }
  if (json.code !== 0) throw businessError(json.code, json.message, context);
  if (json.data === null || typeof json.data !== 'object') {
    throw error('ParseError', `${context}: no data`);
  }
  return json.data;
}

// ---------------------------------------------------------------- 匿名 cookie

function randomHex(length) {
  const chars = '0123456789ABCDEF';
  let out = '';
  for (let i = 0; i < length; i++) out += chars[Math.floor(Math.random() * 16)];
  return out;
}

function randomUuid() {
  return `${randomHex(8)}-${randomHex(4)}-${randomHex(4)}-${randomHex(4)}-${randomHex(12)}`;
}

/**
 * 匿名的瀏覽器 cookie（舊專案 _buildBrowserCookie）。第一次在本機亂數產生、存進
 * storage，之後沿用。不向 B 站領 buvid：舊專案實測被風控時兩者結果相同，多一個請求沒有好處。
 */
async function anonymousCookie() {
  let identity = null;
  const stored = await fmp.storage.get('anonymousIdentity');
  if (stored !== null) {
    try {
      identity = JSON.parse(stored);
    } catch (e) {
      fmp.log.warn('discarding an unreadable anonymous identity');
      identity = null;
    }
  }
  if (
    identity === null ||
    typeof identity.buvid3 !== 'string' ||
    typeof identity.buvid4 !== 'string' ||
    typeof identity.bNut !== 'number'
  ) {
    identity = {
      buvid3: `${randomUuid()}infoc`,
      buvid4: randomUuid(),
      bNut: Math.floor(Date.now() / 1000),
    };
    await fmp.storage.set('anonymousIdentity', JSON.stringify(identity));
  }
  const { buvid3, buvid4, bNut } = identity;
  return `buvid3=${buvid3}; buvid4=${buvid4}; b_nut=${bNut}; _uuid=${buvid3}; buvid_fp=${buvid3}`;
}

async function get(url, headers, context) {
  const cookie = await anonymousCookie();
  const response = await fmp.http.request({
    url,
    headers: { ...headers, Cookie: cookie },
    auth: 'userPreference',
  });
  return parseJson(response, context);
}

function query(params) {
  return Object.keys(params)
    .map((key) => `${encodeURIComponent(key)}=${encodeURIComponent(String(params[key]))}`)
    .join('&');
}

// ---------------------------------------------------------------- WBI 簽名

// B 站網頁端的 WBI 簽名：img_key + sub_key 依這張表重排取前 32 字元為 mixin key，
// 參數加 wts 後依鍵排序、去掉 !'()*，w_rid = md5(query + mixin key)。
const MIXIN_KEY_ENC_TAB = [
  46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49, 33, 9, 42, 19, 29, 28,
  14, 39, 12, 38, 41, 13, 37, 48, 7, 16, 24, 55, 40, 61, 26, 17, 0, 1, 60, 51, 30, 4, 22, 25, 54, 21,
  56, 59, 6, 63, 57, 62, 11, 36, 20, 34, 44, 52,
];

function wbiMixinKey(imgKey, subKey) {
  const orig = imgKey + subKey;
  return MIXIN_KEY_ENC_TAB.map((n) => orig[n])
    .join('')
    .slice(0, 32);
}

/** 簽好的 query 字串（含 wts、w_rid）。md5 由宿主算。 */
function wbiSign(params, keys, nowSeconds, md5) {
  const signed = { ...params, wts: nowSeconds };
  const text = Object.keys(signed)
    .sort()
    .map(
      (key) =>
        `${encodeURIComponent(key)}=${encodeURIComponent(String(signed[key]).replace(/[!'()*]/g, ''))}`,
    )
    .join('&');
  return `${text}&w_rid=${md5(text + wbiMixinKey(keys.imgKey, keys.subKey))}`;
}

/** 北京時間的日期：WBI key 每天換，快取以它為界。 */
function chinaDay(nowMs) {
  return new Date(nowMs + 8 * 3600 * 1000).toISOString().slice(0, 10);
}

const WBI_KEY = /^[0-9a-zA-Z]{32}$/;

/** `https://i0.hdslb.com/bfs/wbi/<key>.png` → `<key>`。 */
function keyFromUrl(url) {
  if (typeof url !== 'string') return null;
  const name = url.slice(url.lastIndexOf('/') + 1).split('.')[0];
  return WBI_KEY.test(name) ? name : null;
}

/** WBI 的 img_key、sub_key：當天的存在 storage，否則問 nav（未登入回 -101，但照樣帶 wbi_img）。 */
async function wbiKeys() {
  const today = chinaDay(Date.now());
  const stored = await fmp.storage.get('wbiKeys');
  if (stored !== null) {
    try {
      const keys = JSON.parse(stored);
      if (keys.day === today && WBI_KEY.test(keys.imgKey) && WBI_KEY.test(keys.subKey)) {
        return keys;
      }
    } catch (e) {
      // 壞掉的快取：重新取。
      fmp.log.warn('discarding an unreadable WBI key cache');
    }
  }
  const json = await get(`${API}/x/web-interface/nav`, API_HEADERS, 'nav');
  const image = json && json.data && json.data.wbi_img;
  const imgKey = keyFromUrl(image && image.img_url);
  const subKey = keyFromUrl(image && image.sub_url);
  if (imgKey === null || subKey === null) {
    // 被風控時 nav 回 -352 之類、沒有 wbi_img：照業務錯誤碼對應，不當成格式錯誤。
    const code = json && json.code;
    if (typeof code === 'number' && code !== 0 && code !== -101) {
      throw businessError(code, json.message, 'nav');
    }
    throw error('ParseError', `nav: no wbi_img (code ${code})`);
  }
  const keys = { imgKey, subKey, day: today };
  await fmp.storage.set('wbiKeys', JSON.stringify(keys));
  return keys;
}

// ---------------------------------------------------------------- search

const NAMED_ENTITIES = { quot: '"', amp: '&', lt: '<', gt: '>', apos: "'", nbsp: ' ' };

/**
 * 解 HTML 實體：命名的（上表）與數字的（`&#39;`、`&#x27;`）。單趟掃過，所以
 * `&amp;lt;` 得到 `&lt;` 而不是 `<`；認不得或超出 Unicode 範圍的原樣留著。
 * 匯出只為了單元測試（宿主只認能力名稱的匯出，其他名稱忽略）。
 */
export function decodeHtmlEntities(text) {
  return String(text).replace(/&(#x[0-9a-f]+|#[0-9]+|[a-z]+);/gi, (match, body) => {
    if (body[0] !== '#') return NAMED_ENTITIES[body.toLowerCase()] ?? match;
    const code = body[1] === 'x' || body[1] === 'X' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
    if (!(code > 0 && code <= 0x10ffff) || (code >= 0xd800 && code <= 0xdfff)) return match;
    return String.fromCodePoint(code);
  });
}

function cleanHtml(text) {
  return decodeHtmlEntities(String(text).replace(/<[^>]*>/g, ''));
}

/** `m:ss` 或 `h:mm:ss` → 毫秒；讀不懂回 null。 */
function colonDurationMs(text) {
  if (typeof text !== 'string') return null;
  const parts = text.split(':');
  if (parts.length < 2 || parts.length > 3 || !parts.every((p) => /^\d+$/.test(p))) return null;
  return parts.reduce((total, part) => total * 60 + Number(part), 0) * 1000;
}

/** hdslb 的縮圖後綴寬度（`原圖@160w`）；宿主 `pickArtwork` 依寬度挑。 */
const ARTWORK_WIDTHS = [160, 480];

/**
 * `//i0.hdslb.com/...` 補上 https；不是 hdslb.com 的 https 網址就不給。
 * 回傳縮圖（160、480 寬）加原圖（不標寬度）；網址已帶 `@` 後綴時只給它自己。
 */
export function artwork(pic) {
  if (typeof pic !== 'string' || pic === '') return [];
  let url = pic;
  if (url.startsWith('//')) url = `https:${url}`;
  else if (url.startsWith('http://')) url = `https://${url.slice('http://'.length)}`;
  if (!isAllowedHttps(url, ['hdslb.com'])) return [];
  if (url.includes('@')) return [{ url }];
  return [...ARTWORK_WIDTHS.map((width) => ({ url: `${url}@${width}w`, width })), { url }];
}

export async function search({ keyword, page }) {
  const params = {
    keyword,
    search_type: 'video',
    page,
    page_size: SEARCH_PAGE_SIZE,
    order: 'totalrank',
  };
  const json = await get(
    `${API}/x/web-interface/search/type?${query(params)}`,
    SEARCH_HEADERS,
    'search',
  );
  const data = checkCode(json, 'search');
  const results = Array.isArray(data.result) ? data.result : [];
  const numResults = typeof data.numResults === 'number' ? data.numResults : 0;
  const items = [];
  for (const item of results) {
    if (typeof item.bvid !== 'string' || item.bvid === '') continue;
    const title = cleanHtml(item.title || '').trim();
    items.push({
      sourceId: item.bvid,
      title: title === '' ? 'Unknown' : title,
      uploader: typeof item.author === 'string' ? item.author : null,
      durationMs: colonDurationMs(item.duration),
      artwork: artwork(item.pic),
    });
  }
  fmp.log.debug('search results', { count: items.length, total: numResults });
  return { items, hasMore: page * SEARCH_PAGE_SIZE < numResults };
}

// ---------------------------------------------------------------- resolveStream

function hostOf(url) {
  const match = /^https:\/\/([^/?#:]+)(?::\d+)?(?:[/?#]|$)/i.exec(url);
  return match ? match[1].toLowerCase() : null;
}

function isAllowedHttps(url, domains) {
  const host = hostOf(url);
  return host !== null && domains.some((d) => host === d || host.endsWith(`.${d}`));
}

/**
 * 網址的期限（unix 秒）→ epoch 毫秒：upos 的 `deadline`（舊專案 _expiryFromUrl），Akamai 鏡像
 * 沒有 `deadline`、期限在 `hdnts=exp=…`。都沒有就是 null。
 */
function expiresAt(url) {
  const match = /[?&]deadline=(\d+)/.exec(url) || /[?&]hdnts=exp=(\d+)/.exec(url);
  return match ? Number(match[1]) * 1000 : null;
}

function accepts(formats, container, codec) {
  return formats.some((f) => f.container === container && f.codec === codec);
}

/**
 * DASH 的 codecs 欄位 → 宿主的編碼名稱。`dash.audio` 只有 AAC（`mp4a.40.*`）；Hi-Res 與杜比
 * 在另外的 `dash.flac`、`dash.dolby`，要登入，舊專案也不取，M1 不處理。
 */
function dashCodec(codecs) {
  return String(codecs || '').toLowerCase().startsWith('mp4a') ? 'aac' : null;
}

function unique(urls) {
  return urls.filter((url, index) => typeof url === 'string' && url !== '' && urls.indexOf(url) === index);
}

/** 一個流的每個網址（主網址在前、備用在後）成為候選；不在允許網域的丟掉。 */
function candidatesFor(urls, fields, dropped) {
  const out = [];
  for (const url of unique(urls)) {
    if (!isAllowedHttps(url, MEDIA_HOSTS)) {
      dropped.push(hostOf(url) || 'not https');
      continue;
    }
    out.push({ url, headers: { ...MEDIA_HEADERS }, ...fields, expiresAt: expiresAt(url) });
  }
  return out;
}

async function cidOf(bvid) {
  const keys = await wbiKeys();
  const signed = wbiSign({ bvid }, keys, Math.round(Date.now() / 1000), fmp.crypto.md5);
  const json = await get(`${API}/x/web-interface/wbi/view?${signed}`, API_HEADERS, 'view');
  const data = checkCode(json, 'view');
  if (typeof data.cid !== 'number') throw error('ParseError', 'view: no cid');
  return data.cid;
}

async function playurl(bvid, cid, fnval, qn, extra) {
  const params = { bvid, cid, fnval, qn, ...extra };
  const json = await get(`${API}/x/player/playurl?${query(params)}`, API_HEADERS, 'playurl');
  return checkCode(json, 'playurl');
}

/**
 * 依頻寬由高到低排好的音軌裡，音質偏好選中的那一個的位置：high 最高、low 最低、medium 取中間
 * （`Math.floor(n / 2)`，兩個時是低的那個）。與舊專案 selectByQualityLevel 相同。沒給或不認得時當
 * high。
 */
function qualityIndex(count, quality) {
  if (quality === 'low') return Math.max(count - 1, 0);
  if (quality === 'medium') return Math.floor(count / 2);
  return 0;
}

/**
 * 依頻寬由高到低排好的音軌，改成備援的順序：選中的那一個、比它低的（由高到低）、比它高的（由低到
 * 高）。先往下降，沒有更低的才往上（舊專案 audioQualityFallbackLevels 也是先降）。
 */
function fallbackOrder(sortedByBandwidthDesc, quality) {
  const chosen = qualityIndex(sortedByBandwidthDesc.length, quality);
  return [
    ...sortedByBandwidthDesc.slice(chosen),
    ...sortedByBandwidthDesc.slice(0, chosen).reverse(),
  ];
}

/** DASH 音訊：平台能播的音軌依頻寬排好，照 fallbackOrder 排成候選。 */
async function dashCandidates(bvid, cid, formats, quality, dropped) {
  const data = await playurl(bvid, cid, FNVAL_DASH, QN_DEFAULT, { fourk: 1 });
  const audios = data.dash && Array.isArray(data.dash.audio) ? data.dash.audio : [];
  const playable = [];
  for (const audio of audios) {
    if (typeof audio.bandwidth !== 'number') continue;
    const container = String(audio.mimeType || audio.mime_type || '') === 'audio/mp4' ? 'mp4' : null;
    const codec = dashCodec(audio.codecs);
    if (container === null || codec === null || !accepts(formats, container, codec)) continue;
    playable.push({ audio, container, codec });
  }
  playable.sort((a, b) => b.audio.bandwidth - a.audio.bandwidth);
  const out = [];
  for (const { audio, container, codec } of fallbackOrder(playable, quality)) {
    const urls = [
      audio.baseUrl,
      audio.base_url,
      ...(Array.isArray(audio.backupUrl) ? audio.backupUrl : []),
      ...(Array.isArray(audio.backup_url) ? audio.backup_url : []),
    ];
    out.push(...candidatesFor(urls, { container, codec, bitrate: audio.bandwidth }, dropped));
  }
  return out;
}

/** durl（音訊與影像混在一起）；容器看 format，音訊是 aac。音質偏好不適用（只有一條）。 */
async function durlCandidates(bvid, cid, formats, quality, dropped) {
  const data = await playurl(bvid, cid, FNVAL_DURL, QN_HIGH, {});
  const format = String(data.format || '');
  const container = format.startsWith('flv') ? 'flv' : format.startsWith('mp4') ? 'mp4' : null;
  if (container === null || !accepts(formats, container, 'aac')) return [];
  // 分段的 durl 只取第一段（舊專案同樣只取第一個）。
  const part = Array.isArray(data.durl) ? data.durl[0] : null;
  if (!part) return [];
  const urls = [part.url, ...(Array.isArray(part.backup_url) ? part.backup_url : [])];
  return candidatesFor(urls, { container, codec: 'aac' }, dropped);
}

function fallsBack(e) {
  return e !== null && typeof e === 'object' && (e.fmpError === 'NotFound' || e.fmpError === 'Unavailable');
}

export async function resolveStream({ sourceId, cid, formats, quality }) {
  const resolvedCid = typeof cid === 'number' ? cid : await cidOf(sourceId);
  const dropped = [];
  // 先 DASH 音訊，再 durl（舊專案 streamPriority：audioOnly → muxed）。NotFound、
  // Unavailable 換下一種；其他錯誤直接拋。
  let candidates = [];
  let lastError = null;
  for (const resolve of [dashCandidates, durlCandidates]) {
    try {
      candidates = await resolve(sourceId, resolvedCid, formats, quality, dropped);
      if (candidates.length > 0) break;
    } catch (e) {
      if (!fallsBack(e)) throw e;
      lastError = e;
    }
  }
  if (dropped.length > 0) fmp.log.warn('dropped stream URLs outside allowedHosts', { hosts: dropped });
  if (candidates.length > 0) return { candidates };
  if (lastError !== null) throw lastError;
  throw error('NotFound', `playurl: no stream in a requested format for ${sourceId}:${resolvedCid}`);
}

// ---------------------------------------------------------------- login (QR)

const PASSPORT = 'https://passport.bilibili.com';

/** 憑證的 cookie（舊專案 BilibiliCredentials.toCookieString 的四個名稱）。 */
const CREDENTIAL_COOKIES = ['SESSDATA', 'bili_jct', 'DedeUserID', 'DedeUserID__ckMd5'];
const REQUIRED_COOKIES = ['SESSDATA', 'bili_jct', 'DedeUserID'];

/** 輪詢回應 `data.code`（舊專案 bilibili_account_service.dart）。 */
const QR_WAITING = 86101;
const QR_SCANNED = 86090;
const QR_EXPIRED = 86038;
const QR_DONE = 0;

/**
 * 多筆 `Set-Cookie` → 名稱對值：取第一個 `;` 之前、第一個 `=` 切開、不解碼；同名取最後一個非空
 * 的值。匯出只為了單元測試。
 */
export function parseSetCookies(headerValues) {
  const out = {};
  for (const line of Array.isArray(headerValues) ? headerValues : []) {
    if (typeof line !== 'string') continue;
    const pair = line.split(';')[0];
    const equals = pair.indexOf('=');
    if (equals <= 0) continue;
    const value = pair.slice(equals + 1).trim();
    if (value !== '') out[pair.slice(0, equals).trim()] = value;
  }
  return out;
}

/** 登入用的請求：不帶匿名 cookie、不讓宿主注入憑證（auth: never）。 */
async function loginGet(url, headers, context) {
  const response = await fmp.http.request({
    url,
    headers: { ...API_HEADERS, ...headers },
    auth: 'never',
  });
  return { json: parseJson(response, context), response };
}

export async function loginQrStart() {
  const { json } = await loginGet(
    `${PASSPORT}/x/passport-login/web/qrcode/generate`,
    {},
    'qr generate',
  );
  const data = checkCode(json, 'qr generate');
  if (typeof data.url !== 'string' || data.url === '' || typeof data.qrcode_key !== 'string' || data.qrcode_key === '') {
    throw error('ParseError', 'qr generate: no url or qrcode_key');
  }
  return { qrText: data.url, token: data.qrcode_key };
}

/** 輪詢成功（data.code 0）時的憑證：cookie 來自回應的 Set-Cookie，refresh_token 來自 body。 */
export function qrCredentials(setCookies, data) {
  const jar = parseSetCookies(setCookies);
  const missing = REQUIRED_COOKIES.filter((name) => !jar[name]);
  if (missing.length > 0) {
    throw error('ParseError', `qr poll: code 0 but Set-Cookie lacks ${missing.join(', ')}`);
  }
  const cookies = {};
  for (const name of CREDENTIAL_COOKIES) if (jar[name]) cookies[name] = jar[name];
  const credentials = { cookies };
  if (typeof data.refresh_token === 'string' && data.refresh_token !== '') {
    credentials.extra = { refresh_token: data.refresh_token };
  }
  return credentials;
}

export async function loginQrPoll(token) {
  const { json, response } = await loginGet(
    `${PASSPORT}/x/passport-login/web/qrcode/poll?${query({ qrcode_key: token })}`,
    {},
    'qr poll',
  );
  // 狀態碼在 data.code，頂層 code 是 0；不認得的 data.code 照業務碼處理，不當成還在等。
  const data = checkCode(json, 'qr poll');
  switch (data.code) {
    case QR_WAITING:
      return { status: 'waiting' };
    case QR_SCANNED:
      return { status: 'scanned' };
    case QR_EXPIRED:
      return { status: 'expired' };
    case QR_DONE:
      return { status: 'done', credentials: qrCredentials((response.headers || {})['set-cookie'], data) };
    default:
      throw businessError(data.code, data.message, 'qr poll');
  }
}

/** verify 的 Cookie header：只放憑證的四個名稱，沒有匿名 buvid（舊專案同樣）。 */
export function verifyCookie(credentials) {
  const cookies = (credentials && credentials.cookies) || {};
  if (typeof cookies.SESSDATA !== 'string' || cookies.SESSDATA === '') {
    throw error('CredentialInvalid', 'verify: credentials have no SESSDATA');
  }
  return CREDENTIAL_COOKIES.filter((name) => typeof cookies[name] === 'string' && cookies[name] !== '')
    .map((name) => `${name}=${cookies[name]}`)
    .join('; ');
}

export async function loginVerify(credentials) {
  const cookie = verifyCookie(credentials);
  const { json } = await loginGet(`${API}/x/web-interface/nav`, { Cookie: cookie }, 'verify');
  if (json !== null && typeof json === 'object' && (json.code === -101 || json.code === -111)) {
    throw error('CredentialInvalid', `verify: code ${json.code} ${json.message || ''}`.trim());
  }
  const data = checkCode(json, 'verify');
  if (data.mid === undefined || data.mid === null || data.mid === '') {
    throw error('ParseError', 'verify: no mid');
  }
  const name = typeof data.uname === 'string' ? data.uname : '';
  const account = { userId: String(data.mid), displayName: name === '' ? String(data.mid) : name };
  const avatar = artwork(data.face);
  if (avatar.length > 0) account.avatar = avatar;
  return account;
}
