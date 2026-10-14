// B 站音源。行為以 FMP 舊專案 lib/data/sources/bilibili_source.dart 為規格，用宿主 API v1
// 重寫：search 與 resolveStream（依「以登入身分瀏覽與播放」帶憑證，沒有就匿名），加上 QR 登入
//（login，舊專案 bilibili_account_service.dart），以及啟動時刷新憑證（loginRefresh）。

import { CREDENTIAL_INVALID_CODES, businessError, credentialsRejected, error } from './errors.js';
import { correspondPath } from './oaep.js';

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

/** HTTP 狀態碼 → 結構化錯誤；429 宿主已經轉成 RateLimited。 */
function statusError(status, context) {
  const detail = `${context}: HTTP ${status}`;
  if (status === 412) return error('RateLimited', detail);
  if (status >= 500) return error('NetworkError', detail);
  return error('UnexpectedError', detail);
}

function parseJson(response, context) {
  if (response.status !== 200) throw statusError(response.status, context);
  let json;
  try {
    json = JSON.parse(response.body);
  } catch (e) {
    throw error('ParseError', `${context}: not JSON`);
  }
  // 憑證無效只在「這次請求真的帶了憑證」的回應上成立（design §6.5）。
  if (credentialsRejected(json, response.credentialsAttached)) {
    throw error('CredentialInvalid', `${context}: code ${json.code} ${json.message || ''}`.trim());
  }
  return json;
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
      // 搜尋結果的 page 是分 P 數；沒有或不是正整數就不給（舊專案預設 1，這裡省略）。
      ...(Number.isInteger(item.page) && item.page > 0 ? { partCount: item.page } : {}),
    });
  }
  fmp.log.debug('search results', { count: items.length, total: numResults });
  return { items, hasMore: page * SEARCH_PAGE_SIZE < numResults };
}

// ---------------------------------------------------------------- multiPart

const BVID_PATTERN = /^BV[0-9A-Za-z]{10}$/;

/**
 * 影片的分 P 列表（`/x/player/pagelist`）。舊專案的 getVideoPages 取 view 的 `pages`；這裡改走
 * pagelist：舊專案實測它匿名也是 200，且不必簽 WBI，一個請求就夠（wbi/view 要先打 nav 取 key）。
 * 沒有分 P 回 NotFound；每個 cid 必須是正整數，否則 ParseError（形狀變了不悄悄少一個）。
 */
export async function multiPart({ sourceId }) {
  if (typeof sourceId !== 'string' || !BVID_PATTERN.test(sourceId)) {
    throw error('ParseError', 'pagelist: invalid bvid');
  }
  const json = await get(
    `${API}/x/player/pagelist?${query({ bvid: sourceId })}`,
    API_HEADERS,
    'pagelist',
  );
  const data = checkCode(json, 'pagelist');
  if (!Array.isArray(data)) throw error('ParseError', 'pagelist: data is not a list');
  if (data.length === 0) throw error('NotFound', 'pagelist: no parts');
  const parts = data.map((raw, i) => {
    if (raw === null || typeof raw !== 'object' || !Number.isInteger(raw.cid) || raw.cid <= 0) {
      throw error('ParseError', 'pagelist: part without cid');
    }
    const index = Number.isInteger(raw.page) && raw.page > 0 ? raw.page : i + 1;
    const title = typeof raw.part === 'string' ? raw.part.trim() : '';
    const part = { cid: raw.cid, title: title === '' ? `P${index}` : title, index };
    if (Number.isInteger(raw.duration) && raw.duration >= 0) part.durationMs = raw.duration * 1000;
    return part;
  });
  return { parts };
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

/** WBI 簽名的 `view`：resolveStream 取預設分 P 的 cid，trackDetail 取詳細，共用一份。 */
async function viewData(bvid) {
  const keys = await wbiKeys();
  const signed = wbiSign({ bvid }, keys, Math.round(Date.now() / 1000), fmp.crypto.md5);
  const json = await get(`${API}/x/web-interface/wbi/view?${signed}`, API_HEADERS, 'view');
  return checkCode(json, 'view');
}

async function cidOf(bvid) {
  const data = await viewData(bvid);
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

// ---------------------------------------------------------------- trackDetail

// view 的 `stat` 欄位 → 契約的 stats kind；順序即輸出順序。
const STAT_KINDS = [
  ['view', 'view'],
  ['like', 'like'],
  ['favorite', 'favorite'],
  ['reply', 'comment'],
  ['share', 'share'],
  ['danmaku', 'danmaku'],
  ['coin', 'coin'],
];

/**
 * 影片詳細（`wbi/view`，同 resolveStream 取 cid 的那個請求；舊專案 getVideoDetail 的欄位，不含熱門評論）。
 * 只給端點真的有的欄位：`stat` 的值不是非負整數（例如隱藏時的 `"--"`）就略過那一項，不補 0。
 * `cid` 不參與（簡介、統計都是整支影片的）；給了就要是正整數。
 */
export async function trackDetail({ sourceId, cid }) {
  if (typeof sourceId !== 'string' || !BVID_PATTERN.test(sourceId)) {
    throw error('ParseError', 'view: invalid bvid');
  }
  if (cid !== undefined && cid !== null && !(Number.isInteger(cid) && cid > 0)) {
    throw error('ParseError', 'view: invalid cid');
  }
  const data = await viewData(sourceId);
  const detail = {};
  // B 站以 "-" 當沒有簡介的佔位。
  if (typeof data.desc === 'string' && !['', '-'].includes(data.desc.trim())) detail.description = data.desc.trim();
  if (Number.isInteger(data.pubdate) && data.pubdate > 0) detail.publishedAt = data.pubdate * 1000;
  const avatar = artwork(data.owner && data.owner.face);
  if (avatar.length > 0) detail.uploaderAvatar = avatar;
  const stat = data.stat;
  if (stat !== null && typeof stat === 'object') {
    const stats = [];
    for (const [field, kind] of STAT_KINDS) {
      const count = stat[field];
      if (Number.isInteger(count) && count >= 0) stats.push({ kind, count });
    }
    if (stats.length > 0) detail.stats = stats;
  }
  return detail;
}

// ---------------------------------------------------------------- live

// 行為以舊專案 bilibili_live_client.dart 為規格。直播 API 在 api.live.bilibili.com，Referer 是
// live.bilibili.com（舊專案 SourceHttpPolicy.bilibiliLiveHeaders）；請求一律 userPreference（get）。
const LIVE_API = 'https://api.live.bilibili.com';
const LIVE_REFERER = 'https://live.bilibili.com/';
const LIVE_API_HEADERS = { ...API_HEADERS, Referer: LIVE_REFERER, Origin: 'https://live.bilibili.com' };
const LIVE_MEDIA_HEADERS = { ...MEDIA_HEADERS, Referer: LIVE_REFERER };
const LIVE_QN = 80;

/**
 * 舊專案 parseLiveUrl 的規則：`live.bilibili.com/<數字>` 或 `/h5/<數字>`，後面是結尾、`/`、`?`、`#` 或空白。
 * 前面不准是 `/`（舊專案准）：`https://evil.example/live.bilibili.com/1` 的網域不是 B 站。
 */
const LIVE_URL = /(^|[^\w./-])(?:https?:\/\/)?live\.bilibili\.com\/(?:h5\/)?(\d+)(?=$|[/?#\s])/i;

/** 不連網：短號到長號的對應留給 liveStatus、resolveLive（它們各自問 room_init）。 */
export function liveRoomFromUrl({ url }) {
  const match = LIVE_URL.exec(typeof url === 'string' ? url : '');
  return match ? { roomId: match[2] } : null;
}

function checkRoomId(roomId) {
  if (typeof roomId !== 'string' || !/^\d+$/.test(roomId)) {
    throw error('NotFound', `live: invalid room id ${JSON.stringify(roomId)}`);
  }
  return roomId;
}

/** room_init：短號 → 真實房號。 */
async function realRoomId(roomId) {
  const json = await get(
    `${LIVE_API}/room/v1/Room/room_init?${query({ id: checkRoomId(roomId) })}`,
    LIVE_API_HEADERS,
    'room_init',
  );
  const data = checkCode(json, 'room_init');
  const real = data.room_id;
  if (!(Number.isSafeInteger(real) && real > 0) && !(typeof real === 'string' && /^[1-9]\d*$/.test(real))) {
    throw error('ParseError', 'room_init: no room_id');
  }
  return String(real);
}

function nonNegativeInt(value) {
  const n = typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value;
  return Number.isSafeInteger(n) && n >= 0 ? n : null;
}

/** live_status：1 開播中；0 未開播、2 輪播（d.ts 只有兩種）→ offline。其他值（含缺）是格式錯誤。 */
function liveStatusOf(code, context) {
  if (code === 1) return 'live';
  if (code === 0 || code === 2) return 'offline';
  throw error('ParseError', `${context}: unknown live_status ${JSON.stringify(code)}`);
}

/** 宿主拒收空白標題（整頁一起拒），所以空的標題同 search 換成 `Unknown`；不是字串是格式錯誤。 */
function roomTitle(raw, context) {
  if (typeof raw !== 'string') throw error('ParseError', `${context}: no title`);
  const title = cleanHtml(raw).trim();
  return title === '' ? 'Unknown' : title;
}

/** 去掉 `<em>` 與實體後不空就是名字，否則 null。 */
function personName(raw) {
  if (typeof raw !== 'string') return null;
  const name = cleanHtml(raw).trim();
  return name === '' ? null : name;
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

async function anchorName(real) {
  try {
    const data = checkCode(
      await get(
        `${LIVE_API}/live_user/v1/UserInfo/get_anchor_in_room?${query({ roomid: real })}`,
        LIVE_API_HEADERS,
        'get_anchor_in_room',
      ),
      'get_anchor_in_room',
    );
    const info = data.info;
    if (info !== null && typeof info === 'object' && typeof info.uname === 'string' && info.uname !== '') {
      return info.uname;
    }
    fmp.log.warn('get_anchor_in_room: no uname', { room: real });
  } catch (e) {
    fmp.log.warn('get_anchor_in_room failed', { room: real, error: (e && e.fmpError) || 'unreadable response' });
  }
  return null;
}

/** D10：任何查詢失敗都拋錯，絕不回 offline。 */
export async function liveStatus({ roomId }) {
  const real = await realRoomId(roomId);
  const info = checkCode(
    await get(`${LIVE_API}/room/v1/Room/get_info?${query({ room_id: real })}`, LIVE_API_HEADERS, 'get_info'),
    'get_info',
  );
  const title = roomTitle(info.title, 'get_info');
  const status = liveStatusOf(info.live_status, 'get_info');
  // hostName 在契約裡是選填：主播名查不到不影響狀態，只記 warn（title、status 仍是 D10）。
  const hostName = await anchorName(real);
  return {
    // room_init 給的真實房號（舊專案取 get_info 的 room_id，查的就是它，兩者相同）。
    roomId: real,
    title,
    hostName,
    artwork: artwork(info.user_cover || info.keyframe),
    status,
    online: nonNegativeInt(info.online),
  };
}

/**
 * 舊專案 searchRooms 的語意：「開播中」搜直播間（live_room），「全部／未開播」搜主播名
 * （bili_user，再補房間狀態）。舊專案補狀態是每位主播一個 get_info；這裡改成整頁一次
 * get_status_info_by_uids（GET、重複的 `uids[]`），避免 N+1。
 */
export async function liveSearch({ keyword, page, status }) {
  return status === 'live' ? liveRoomSearch(keyword, page) : liveAnchorSearch(keyword, page, status);
}

function searchParams(keyword, page, searchType) {
  return query({ keyword, search_type: searchType, page, page_size: SEARCH_PAGE_SIZE });
}

async function liveRoomSearch(keyword, page) {
  const json = await get(
    `${API}/x/web-interface/search/type?${searchParams(keyword, page, 'live_room')}`,
    SEARCH_HEADERS,
    'live search',
  );
  const data = checkCode(json, 'live search');
  const results = Array.isArray(data.result) ? data.result : [];
  const numResults = typeof data.numResults === 'number' ? data.numResults : 0;
  const items = [];
  for (const item of results) {
    if (!isRecord(item)) continue;
    const id = nonNegativeInt(item.roomid);
    if (id === null || id === 0) continue;
    items.push({
      roomId: String(id),
      title: roomTitle(item.title || '', 'live search'),
      hostName: personName(item.uname),
      artwork: artwork(item.user_cover),
      status: 'live',
      online: nonNegativeInt(item.online),
    });
  }
  fmp.log.debug('live search results', { count: items.length, total: numResults });
  return { items, hasMore: page * SEARCH_PAGE_SIZE < numResults };
}

async function liveAnchorSearch(keyword, page, status) {
  const json = await get(
    `${API}/x/web-interface/search/type?${searchParams(keyword, page, 'bili_user')}`,
    SEARCH_HEADERS,
    'live user search',
  );
  const data = checkCode(json, 'live user search');
  const results = Array.isArray(data.result) ? data.result : [];
  const numResults = typeof data.numResults === 'number' ? data.numResults : 0;
  const hasMore = page * SEARCH_PAGE_SIZE < numResults;
  const anchors = [];
  for (const item of results) {
    if (!isRecord(item)) continue;
    const mid = nonNegativeInt(item.mid);
    const room = nonNegativeInt(item.room_id);
    if (mid === null || mid === 0 || room === null || room === 0) continue;
    anchors.push({ mid, name: personName(item.uname) });
  }
  if (anchors.length === 0) return { items: [], hasMore };

  // 整頁一次：GET …/get_status_info_by_uids?uids%5B%5D=1&uids%5B%5D=2（`uids[]` 編碼過；宿主的
  // Uri.parse 本來就會這樣送）。失敗就整個拋，不回部分結果。
  const context = 'get_status_info_by_uids';
  const uids = anchors.map((a) => `${encodeURIComponent('uids[]')}=${a.mid}`).join('&');
  const batch = checkCode(
    await get(`${LIVE_API}/room/v1/Room/get_status_info_by_uids?${uids}`, LIVE_API_HEADERS, context),
    context,
  );
  // data 以 uid 字串為鍵（真實回應確認過）。問了 uid 卻回陣列（PHP 的空 map 是 `[]`）或一個都對不上，
  // 是形狀變了，不能當成「沒有結果」。
  if (!isRecord(batch) || !anchors.some((a) => isRecord(batch[String(a.mid)]))) {
    throw error('ParseError', `${context}: data is not keyed by the requested uids`);
  }
  const items = [];
  for (const anchor of anchors) {
    const entry = batch[String(anchor.mid)];
    if (!isRecord(entry)) {
      fmp.log.debug('live search: uid missing from status batch', { uid: anchor.mid });
      continue;
    }
    const roomId = nonNegativeInt(entry.room_id);
    const uid = entry.uid === undefined ? anchor.mid : nonNegativeInt(entry.uid);
    if (roomId === null || roomId === 0 || uid !== anchor.mid) {
      throw error('ParseError', `${context}: bad entry for uid ${anchor.mid}`);
    }
    const title = roomTitle(entry.title, context);
    const roomStatus = liveStatusOf(entry.live_status, context);
    if (status === 'offline' && roomStatus !== 'offline') continue;
    items.push({
      roomId: String(roomId),
      title,
      hostName: anchor.name || personName(entry.uname),
      artwork: artwork(entry.cover_from_user || entry.keyframe),
      status: roomStatus,
      online: nonNegativeInt(entry.online),
    });
  }
  fmp.log.debug('live anchor search results', { count: items.length, total: numResults });
  return { items, hasMore };
}

export async function resolveLive({ roomId }) {
  const real = await realRoomId(roomId);
  const params = { cid: real, platform: 'web', quality: 2, qn: LIVE_QN };
  const data = checkCode(
    await get(`${LIVE_API}/room/v1/Room/playUrl?${query(params)}`, LIVE_API_HEADERS, 'live playUrl'),
    'live playUrl',
  );
  // 只取第一段（舊專案 _firstDurlUrl）；它的備用網址排在後面。
  const first = Array.isArray(data.durl) ? data.durl[0] : null;
  if (first === null || typeof first !== 'object' || typeof first.url !== 'string' || first.url === '') {
    throw error('NotFound', `live playUrl: no durl for room ${real}`);
  }
  const dropped = [];
  const urls = [first.url, ...(Array.isArray(first.backup_url) ? first.backup_url : [])];
  const candidates = candidatesFor(urls, {}, dropped).map((c) => ({ ...c, headers: { ...LIVE_MEDIA_HEADERS } }));
  if (dropped.length > 0) fmp.log.warn('dropped live stream URLs outside allowedHosts', { hosts: dropped });
  if (candidates.length === 0) {
    throw error('Unavailable', `live playUrl: no stream URL inside allowedHosts for room ${real}`);
  }
  return { candidates };
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
  if (json !== null && typeof json === 'object' && CREDENTIAL_INVALID_CODES.includes(json.code)) {
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

// ---------------------------------------------------------------- login (refresh)

// cookie/refresh 的 86095（記載是 refresh_csrf 錯或 refresh_token 與 cookie 對不上）刻意不算憑證無效：
// 意義沒對真實端點驗證過，而且走到第 4 步代表第 1 步的 cookie 還被接受，標失效會讓還能用的登入
// 被要求重新登入。它落到 businessError 的 UnexpectedError（宿主記 failed、帳號照用）；cookie 真的
// 壞了時，帶憑證的請求會拿到 -101，宿主再刷新一次就在第 1 步判定。

/** correspond 頁 HTML 裡的 refresh_csrf（舊專案 _extractRefreshCsrf）；沒有回 null。匯出只為了單元測試。 */
export function refreshCsrfOf(html) {
  const match = /<div\s+id="1-name"\s*>(.*?)<\/div>/.exec(typeof html === 'string' ? html : '');
  const value = match ? match[1].trim() : '';
  return value === '' ? null : value;
}

/** 刷新流程的請求：自己組 Cookie、auth: never（design §4.3）。POST 不重試（refresh 只能成功一次）。 */
function refreshRequest(method, url, cookie, form) {
  const headers = { ...API_HEADERS, Cookie: cookie };
  if (form !== undefined) headers['Content-Type'] = 'application/x-www-form-urlencoded';
  return fmp.http.request({ url, method, headers, body: form, auth: 'never' });
}

/** 刷新用的 JSON 回應：-101、-111 → CredentialInvalid，其他非 0 的碼照業務碼對應。 */
function refreshData(response, context) {
  const json = parseJson(response, context);
  if (json === null || typeof json !== 'object') throw error('ParseError', `${context}: not an object`);
  if (CREDENTIAL_INVALID_CODES.includes(json.code)) {
    throw error('CredentialInvalid', `${context}: code ${json.code} ${json.message || ''}`.trim());
  }
  return checkCode(json, context);
}

/**
 * 刷新憑證（舊專案 refreshCredentials 的 5 步）。不需要刷新回 null；成功回新憑證；憑證本身壞了
 * （未登入、csrf 對不上、需要刷新卻沒有 refresh_token）拋 CredentialInvalid；第 4 步之前的網路、
 * HTTP、風控、格式問題照既有對應拋，不當成憑證無效，宿主保留舊憑證下次再試。
 *
 * 第 4 步成功後新憑證已經發出、舊 refresh_token 已經用掉，所以第 5 步 confirm 不論成敗都回傳
 * 新憑證（舊專案先存新憑證再 confirm、confirm 失敗不影響）。宿主要等這個函式回傳才寫入：寫入
 * 失敗就丟了登入（README 的已知窗口）。
 */
export async function loginRefresh(credentials) {
  const cookies = (credentials && credentials.cookies) || {};
  const oldToken = credentials && credentials.extra ? credentials.extra.refresh_token : undefined;
  const cookie = verifyCookie(credentials);

  // 1. 要不要刷新。
  const info = refreshData(
    await refreshRequest('GET', `${PASSPORT}/x/passport-login/web/cookie/info`, cookie),
    'refresh info',
  );
  if (info.refresh !== true) return null;
  if (typeof oldToken !== 'string' || oldToken === '' || typeof cookies.bili_jct !== 'string' || cookies.bili_jct === '') {
    throw error('CredentialInvalid', 'refresh: credentials need a refresh but lack refresh_token or bili_jct');
  }
  if (!Number.isSafeInteger(info.timestamp)) throw error('ParseError', 'refresh info: no timestamp');

  // 2、3. correspondPath → correspond 頁（HTML）→ refresh_csrf。
  const page = await refreshRequest(
    'GET',
    `https://www.bilibili.com/correspond/1/${correspondPath(info.timestamp)}`,
    cookie,
  );
  if (page.status !== 200) throw statusError(page.status, 'refresh correspond');
  const refreshCsrf = refreshCsrfOf(page.body);
  if (refreshCsrf === null) throw error('ParseError', 'refresh correspond: no refresh_csrf in page');

  // 4. 換新 cookie 與新 refresh_token。
  const refreshed = await refreshRequest(
    'POST',
    `${PASSPORT}/x/passport-login/web/cookie/refresh`,
    cookie,
    query({ csrf: cookies.bili_jct, refresh_csrf: refreshCsrf, source: 'main_web', refresh_token: oldToken }),
  );
  const refreshedData = refreshData(refreshed, 'refresh cookie');
  const jar = parseSetCookies((refreshed.headers || {})['set-cookie']);
  if (
    typeof refreshedData.refresh_token !== 'string' ||
    refreshedData.refresh_token === '' ||
    !jar.SESSDATA ||
    !jar.bili_jct
  ) {
    throw error('ParseError', 'refresh cookie: response lacks refresh_token, SESSDATA or bili_jct');
  }
  // 回應沒給的 cookie 沿用舊值（舊專案同樣）。
  const merged = {};
  for (const name of CREDENTIAL_COOKIES) {
    const value = jar[name] || cookies[name];
    if (typeof value === 'string' && value !== '') merged[name] = value;
  }

  // 5. 確認：新 cookie 加舊 refresh_token。失敗（傳輸錯誤、HTTP、非 0 的 code）只記一筆
  // warning，照樣回傳新憑證（見函式說明）。
  try {
    const confirm = await refreshRequest(
      'POST',
      `${PASSPORT}/x/passport-login/web/confirm/refresh`,
      verifyCookie({ cookies: merged }),
      query({ csrf: merged.bili_jct, refresh_token: oldToken }),
    );
    if (confirm.status !== 200) {
      fmp.log.warn('refresh confirm failed', { status: confirm.status });
    } else {
      const code = JSON.parse(confirm.body).code;
      if (code !== 0) fmp.log.warn('refresh confirm returned a non-zero code', { code });
    }
  } catch (e) {
    fmp.log.warn('refresh confirm failed', { error: (e && e.fmpError) || 'unreadable response' });
  }
  return { cookies: merged, extra: { refresh_token: refreshedData.refresh_token } };
}
