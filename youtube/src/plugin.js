// YouTube 音源（匿名）：YouTube.js (youtubei.js) 跑在 FMP 的插件執行環境裡。
// build.mjs 打包成 ../youtube.js，並加上 manifest 標頭。
import { HeadersShim, RequestShim, ResponseShim, fetchShim } from './shims.js';
import { Innertube, Platform, Log } from 'youtubei.js/web';
import { error, playabilityError } from './errors.js';
import { CLIENTS } from './clients.js';

// ---------------------------------------------------------------- platform
// Cache over fmp.storage (values are ArrayBuffers; storage takes strings).
class StorageCache {
  constructor() { this.cache_dir = ''; }
  async get(key) {
    const v = await fmp.storage.get(`ytjs:${key}`);
    if (v == null) return undefined;
    const bin = atob(v);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out.buffer;
  }
  async set(key, value) {
    const u8 = new Uint8Array(value);
    let bin = '';
    for (let i = 0; i < u8.length; i += 8192) bin += String.fromCharCode.apply(null, u8.subarray(i, i + 8192));
    await fmp.storage.set(`ytjs:${key}`, btoa(bin));
  }
  async remove(key) { await fmp.storage.delete(`ytjs:${key}`); }
}

Platform.load({
  runtime: 'fmp-quickjs',
  server: true,
  Cache: StorageCache,
  sha1Hash: async () => { throw new Error('sha1Hash is only used for logged-in requests'); },
  uuidv4: () => globalThis.crypto.randomUUID(),
  // Player JS deciphering (signature / n). QuickJS has eval/new Function; the
  // VISIONOS/IOS paths never need it (their URLs are not ciphered), kept for completeness.
  eval: (data, env) => {
    const props = [];
    if (env.n) props.push(`n: exportedVars.nFunction(${JSON.stringify(env.n)})`);
    if (env.sig) props.push(`sig: exportedVars.sigFunction(${JSON.stringify(env.sig)})`);
    return new Function(`${data.output}\nreturn { ${props.join(', ')} }`)();
  },
  fetch: fetchShim,
  Request: RequestShim,
  Response: ResponseShim,
  Headers: HeadersShim,
  FormData: class FormData {},
  File: class File {},
  ReadableStream: class ReadableStream {},
  CustomEvent: class CustomEvent {},
});
Log.setLevel(Log.Level.ERROR);

// ---------------------------------------------------------------- session
let innertubePromise = null;
const now = () => Date.now();

function innertube() {
  if (!innertubePromise) {
    const t0 = now();
    innertubePromise = Innertube.create({
      retrieve_player: false, // VISIONOS/IOS URLs are plain; no player JS download/parse
      timezone: 'UTC', // Session's default reads Intl, which QuickJS lacks
      cache: new StorageCache(),
      enable_session_cache: true,
    }).then((yt) => {
      fmp.log.debug('Innertube session ready', { ms: now() - t0 });
      return yt;
    }, (e) => {
      innertubePromise = null;
      throw e;
    });
  }
  return innertubePromise;
}

// 下一頁的 continuation：鍵是「關鍵字#頁」。每筆留著整頁解析後的結果，只留最近幾筆，
// 換了很多關鍵字也不會一直長大（Map 依插入順序，先刪最舊的）。
const continuations = new Map();
const MAX_CONTINUATIONS = 8;

// ---------------------------------------------------------------- search
export async function search({ keyword, page }) {
  const yt = await innertube();
  const t0 = now();
  let result;
  if (page > 1) {
    // 續頁只能接在同一個關鍵字的上一頁後面（continuation 是 YouTube 給的不透明 token）。
    const key = `${keyword}#${page}`;
    const previous = continuations.get(key);
    if (!previous) return { items: [], hasMore: false };
    continuations.delete(key);
    result = await previous.getContinuation();
  } else {
    result = await yt.search(keyword, { type: 'video' });
  }
  const items = [];
  // 只收影片：頻道、播放清單、Shorts 欄位等不是 type 'Video'。
  for (const v of result.videos) {
    if (v.type !== 'Video' || !v.video_id) continue;
    const seconds = v.duration && v.duration.seconds;
    // 直播與首播沒有長度，也沒有可解的音訊串流，略過。
    if (!(typeof seconds === 'number' && seconds > 0)) continue;
    items.push({
      sourceId: v.video_id,
      title: v.title ? v.title.toString() : v.video_id,
      uploader: v.author ? v.author.name : null,
      durationMs: seconds * 1000,
      artwork: (v.thumbnails || [])
        .filter((t) => isAllowedHttps(t.url, ['ytimg.com']))
        .map((t) => ({ url: t.url, width: t.width || null })),
    });
  }
  const hasMore = !!result.has_continuation;
  if (hasMore) {
    continuations.set(`${keyword}#${page + 1}`, result);
    if (continuations.size > MAX_CONTINUATIONS) continuations.delete(continuations.keys().next().value);
  }
  fmp.log.debug('search results', { count: items.length, ms: now() - t0 });
  return { items, hasMore };
}

// ---------------------------------------------------------------- resolveStream
function hostOf(url) {
  const match = /^https:\/\/([^/?#:]+)(?::\d+)?(?:[/?#]|$)/i.exec(String(url));
  return match ? match[1].toLowerCase() : null;
}

function isAllowedHttps(url, domains) {
  const host = hostOf(url);
  return host !== null && domains.some((d) => host === d || host.endsWith(`.${d}`));
}

// 宿主只收 allowedHosts 內的串流網址，不在內的整個回傳值會被拒收。
const MEDIA_HOSTS = ['googlevideo.com'];

/** 網址的 expire（unix 秒）→ epoch 毫秒；沒有就是 null。 */
function expiresAt(url) {
  const match = /[?&]expire=(\d+)/.exec(url);
  return match ? Number(match[1]) * 1000 : null;
}

function describe(mime) {
  const m = /^audio\/(\w+);\s*codecs="([^"]+)"/.exec(mime || '');
  if (!m) return null;
  const codec = m[2].startsWith('mp4a') ? 'aac' : m[2];
  return { container: m[1], codec };
}

/** high 取最高、low 取最低、medium 取中間（⌊n / 2⌋），與 bilibili 插件和舊專案 selectByQualityLevel 相同。 */
function qualityIndex(count, quality) {
  if (quality === 'low') return Math.max(count - 1, 0);
  if (quality === 'medium') return Math.floor(count / 2);
  return 0;
}

/** 碼率由高到低的陣列 → 選中的、比它低的（由高到低）、比它高的（由低到高）。 */
function fallbackOrder(sortedDesc, quality) {
  const chosen = qualityIndex(sortedDesc.length, quality);
  return [...sortedDesc.slice(chosen), ...sortedDesc.slice(0, chosen).reverse()];
}

/**
 * 一個 client 的 player 回應（已解析）。與 getBasicInfo 送的 body 相同，但 getBasicInfo 在
 * playabilityStatus 為 ERROR（影片不存在、已刪除）時直接拋例外，錯誤對應表就走不到 NotFound。
 */
function playerResponse(yt, videoId, client) {
  return yt.actions.execute('/player', {
    videoId,
    racyCheckOk: true,
    contentCheckOk: true,
    playbackContext: { contentPlaybackContext: { vis: 0, splay: false, lactMilliseconds: '-1' } },
    client,
    parse: true,
  });
}

/** 依序試每個 client，回傳第一個有音訊的；都沒有就丟第一個非 OK 的 playability 對應的錯誤。 */
async function audioFormats(yt, sourceId) {
  let firstFailure = null;
  for (const client of CLIENTS) {
    const info = await playerResponse(yt, sourceId, client);
    const ps = info.playability_status || {};
    if (ps.status !== 'OK') {
      fmp.log.debug('client not playable', { client, status: ps.status, reason: ps.reason || null });
      if (!firstFailure) firstFailure = playabilityError(ps.status, ps.reason);
      continue;
    }
    let audio = ((info.streaming_data && info.streaming_data.adaptive_formats) || []).filter(
      (f) => f.has_audio && !f.has_video && f.url,
    );
    // 多語言配音的影片：只留預設音軌。
    const defaults = audio.filter((f) => f.audio_track && f.audio_track.audio_is_default);
    if (defaults.length > 0) audio = defaults;
    if (audio.length > 0) return { client, audio };
  }
  throw firstFailure || error('NotFound', 'no audio-only formats');
}

export async function resolveStream({ sourceId, formats, quality }) {
  const yt = await innertube();
  const t0 = now();
  const { client, audio } = await audioFormats(yt, sourceId);
  const tracks = [];
  for (const f of audio) {
    const format = describe(f.mime_type);
    if (!format) continue;
    // VISIONOS／IOS 的網址是明文，不需要解密。
    const url = await f.decipher(undefined);
    if (!url || !isAllowedHttps(url, MEDIA_HOSTS)) continue;
    tracks.push({ url, ...format, bitrate: f.bitrate || null });
  }
  // 使用者的格式偏好（formats 的先後）決定分組的順序，同一種格式內依音質偏好排。
  const candidates = [];
  for (const wanted of formats || []) {
    const group = tracks
      .filter((t) => t.container === wanted.container && t.codec === wanted.codec)
      .sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0));
    for (const t of fallbackOrder(group, quality)) {
      // 串流不帶任何 header：不帶 Cookie（ADR 0012），googlevideo 也不需要 Referer。
      candidates.push({
        url: t.url,
        container: t.container,
        codec: t.codec,
        bitrate: t.bitrate,
        expiresAt: expiresAt(t.url),
      });
    }
  }
  if (candidates.length === 0) throw error('NotFound', 'no playable audio format for this platform');
  fmp.log.debug('resolved', { client, candidates: candidates.length, ms: now() - t0 });
  return { candidates };
}

// ---------------------------------------------------------------- login
export { loginVerify } from './login.js';
