// YouTube 音源（匿名）：YouTube.js (youtubei.js) 跑在 FMP 的插件執行環境裡。
// build.mjs 打包成 ../youtube.js，並加上 manifest 標頭。
import { HeadersShim, RequestShim, ResponseShim, fetchShim } from './shims.js';
import { Innertube, Platform, Log } from 'youtubei.js/web';
import { error, playabilityError } from './errors.js';
import { CLIENTS } from './clients.js';
import { mixRequest, parseMixResponse } from './mix.js';
import { trackDetailRequest, parseTrackDetail } from './track_detail.js';
import { isAllowedHttps } from './urls.js';
import { callResults } from './host_request.js';
import { chartList as chartListOf, chartRequest, parseChartResponse } from './chart.js';
import { browseRequest, cursorFor, importable, interpret, playlistFromUrl as parsePlaylistUrl } from './playlist.js';
import { libraryRequest, parseLibraryResponse } from './library.js';
import {
  ABORT_KINDS, MAX_SCAN_PAGES, addBody, checkPlaylistId, createBody, failedResult, removeBody, scanPage, videoIdOf, writeFailure,
} from './library_write.js';

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

// ---------------------------------------------------------------- mix
export async function mix(input) {
  const { mixId, lastVideoId, body } = mixRequest(input);
  const yt = await innertube();
  const t0 = now();
  // parse: false 取原始 JSON（見 mix.js）。innertube 的 POST 經 shim 標 idempotent，認證由 hostRequest 依 client 掛。
  const res = await yt.actions.execute('/next', { ...body, parse: false });
  const { title, tracks, cursor } = parseMixResponse(res.data, { lastVideoId });
  fmp.log.debug('mix batch', { count: tracks.length, hasCursor: cursor !== null, ms: now() - t0 });
  return { mixId, title: title || 'Mix', tracks, cursor };
}

// ---------------------------------------------------------------- trackDetail
export async function trackDetail(input) {
  const body = trackDetailRequest(input || {});
  const yt = await innertube();
  const t0 = now();
  // 和 mix 一樣讀原始 JSON；WEB client，與 search 同樣標 userPreference。
  const res = await yt.actions.execute('/next', { ...body, parse: false });
  const detail = parseTrackDetail(res.data);
  fmp.log.debug('track detail', { fields: Object.keys(detail).length, ms: now() - t0 });
  return detail;
}

// ---------------------------------------------------------------- importPlaylist
export function playlistFromUrl(input) {
  return parsePlaylistUrl(input);
}

let callSeq = 0;

/** 一次 browse。2xx 回 {status, data, credentialsAttached}；4xx／5xx 回 {status, error, credentialsAttached}（不丟）。 */
function browse(yt, body, auth) {
  return innertubeCall(yt, '/browse', body, auth);
}

/** 同 browse，路徑可換（`/browse/edit_playlist`、`/playlist/create` 也走這裡）。 */
async function innertubeCall(yt, path, body, auth) {
  const id = `call-${++callSeq}`;
  try {
    const response = await yt.session.http.fetch(path, {
      method: 'POST',
      body: JSON.stringify(body),
      headers: { 'Content-Type': 'application/json', 'x-fmp-call': `${id}|${auth}` },
    });
    const data = await response.json();
    const meta = callResults.get(id);
    return { status: response.status, data, credentialsAttached: !!(meta && meta.credentialsAttached) };
  } catch (e) {
    const meta = callResults.get(id);
    // 宿主或 hostRequest 丟的結構化錯誤（網路、限流、憑證無效）原樣往外；YouTube.js 因 4xx 丟的才轉成回應。
    if (!meta || meta.status < 400 || (e && typeof e.fmpError === 'string')) throw e;
    return { status: meta.status, error: e, credentialsAttached: meta.credentialsAttached };
  } finally {
    callResults.delete(id);
  }
}

export async function importPlaylist(input) {
  const { body, meta, required } = browseRequest(input);
  const yt = await innertube();
  const t0 = now();
  let usedRequired = required;
  let res = await browse(yt, body, required ? 'required' : 'userPreference');
  let outcome = interpret(res, meta);
  // 私人歌單：被拒、這次沒帶憑證、使用者有登入 → 以 required 重送一次（ADR 0032 §決定 2）。已帶憑證被拒不重送。
  if (outcome.denied && !res.credentialsAttached && (await fmp.credentials.get()) !== null) {
    usedRequired = true;
    res = await browse(yt, body, 'required');
    outcome = interpret(res, meta);
  }
  if (outcome.denied) {
    if (!res.credentialsAttached && outcome.loginHint) throw error('AuthRequired', 'playlist needs a signed-in account');
    throw error('NotFound', 'playlist not found or not readable');
  }
  const { playlist, items, token } = outcome.page;
  fmp.log.debug('playlist page', { count: items.length, hasCursor: token !== null, retried: usedRequired !== required, ms: now() - t0 });
  return { playlist, items, cursor: cursorFor(playlist, token, usedRequired) };
}

// ---------------------------------------------------------------- libraryRead
export async function libraryPlaylists(input) {
  const body = libraryRequest(input);
  const yt = await innertube();
  const t0 = now();
  // 帳號資料：一律 required（宿主沒登入就先拋 AuthRequired）。
  const res = await browse(yt, body, 'required');
  if (res.status >= 400) {
    if (!res.credentialsAttached && (res.status === 401 || res.status === 403)) throw error('AuthRequired', `library: HTTP ${res.status}`);
    throw res.error;
  }
  const { playlists, cursor } = parseLibraryResponse(res.data, { continuation: body.continuation !== undefined });
  fmp.log.debug('library playlists', { count: playlists.length, hasCursor: cursor !== null, ms: now() - t0 });
  return { playlists, cursor };
}

// ---------------------------------------------------------------- libraryWrite
// 寫入請求一律 required。YouTube 的 edit_playlist 一次可以帶多個 action，但回應只有一個 status、分不出哪一項失敗，
// 所以像舊版一樣一項一個請求，換得逐項的結果。

/**
 * 逐頁掃描 `VL<playlistId>`，收 videoId → {setVideoId}（同一支影片出現多次取第一個，同舊版 getSetVideoId）。
 * 所有 targets 都找到就提早停。讀不到（結構化錯誤）往外丟，由呼叫端把每一項標成失敗。
 */
async function scanPlaylist(yt, playlistId, targets) {
  const found = new Map();
  let body = { browseId: `VL${playlistId}` };
  for (let page = 0; page < MAX_SCAN_PAGES; page++) {
    const res = await browse(yt, body, 'required');
    if (res.status >= 400) throw writeFailure(res);
    const { entries, token } = scanPage(res.data, { continuation: page > 0 });
    for (const { videoId, setVideoId } of entries) {
      if (targets.has(videoId) && !found.has(videoId)) found.set(videoId, { setVideoId });
    }
    if (found.size === targets.size || token === null) return found;
    body = { continuation: token };
  }
  throw error('UnexpectedError', `playlist scan: more than ${MAX_SCAN_PAGES} pages`);
}

/** 讀不到歌單 → 每一項都標同一個失敗。整個請求層級的錯誤（ABORT_KINDS、NetworkError）與非結構化的例外原樣往外丟。 */
function allFailed(e, count) {
  if (e && ABORT_KINDS.includes(e.fmpError) && e.fmpError !== 'AuthRequired') throw e;
  const result = failedResult(e);
  return { results: Array.from({ length: count }, () => result) };
}

/** 一個項目一次寫入。成功回 null，失敗回結構化錯誤；網路類與非結構化例外往外丟。 */
async function edit(yt, body) {
  return writeFailure(await innertubeCall(yt, '/browse/edit_playlist', body, 'required'));
}

export async function createPlaylist(input) {
  const body = createBody((input || {}).title);
  const yt = await innertube();
  const res = await innertubeCall(yt, '/playlist/create', body, 'required');
  const failure = writeFailure(res);
  if (failure) throw failure;
  const playlistId = res.data && res.data.playlistId;
  if (!importable(playlistId)) throw error('ParseError', 'playlist create: no playlistId in the response');
  fmp.log.debug('playlist created');
  return { playlistId };
}

/** 一個項目的寫入結果：失敗是 failed，需要停下來的錯誤另外記在 state.abort。 */
async function writeOne(yt, body, okStatus, state) {
  try {
    const failure = await edit(yt, body);
    if (!failure) return { status: okStatus };
    if (ABORT_KINDS.includes(failure.fmpError)) state.abort = failure;
    return failedResult(failure);
  } catch (e) {
    const result = failedResult(e);
    if (ABORT_KINDS.includes(e.fmpError)) state.abort = e;
    return result;
  }
}

export async function addToPlaylist(input) {
  const { playlistId, tracks } = input || {};
  checkPlaylistId(playlistId, 'add');
  if (!Array.isArray(tracks)) throw error('ParseError', 'playlist add: tracks is not an array');
  const ids = tracks.map(videoIdOf);
  const targets = new Set(ids.filter((id) => id !== null));
  const yt = await innertube();
  const t0 = now();
  // 舊版的 getVideoIdsInPlaylist：先掃一遍，已經在清單裡的不再加（edit_playlist 不去重，會多一份）。
  let present = new Map();
  if (targets.size > 0) {
    try {
      present = await scanPlaylist(yt, playlistId, targets);
    } catch (e) {
      return allFailed(e, tracks.length);
    }
  }
  const results = [];
  const done = new Map(); // videoId → 第一次的結果
  const state = { abort: null };
  for (const id of ids) {
    let result;
    if (id === null) {
      result = { status: 'failed', error: error('ParseError', 'playlist add: invalid video id') };
    } else if (done.has(id)) {
      const first = done.get(id);
      result = first.status === 'failed' ? first : { status: 'alreadyPresent' };
    } else if (present.has(id)) {
      result = { status: 'alreadyPresent' };
    } else if (state.abort !== null) {
      result = failedResult(state.abort);
    } else {
      result = await writeOne(yt, addBody(playlistId, id), 'added', state);
    }
    if (id !== null && !done.has(id)) done.set(id, result);
    results.push(result);
  }
  if (state.abort !== null && results.every((r) => r.status === 'failed')) throw state.abort;
  fmp.log.debug('playlist add', { requested: tracks.length, added: results.filter((r) => r.status === 'added').length, ms: now() - t0 });
  return { results };
}

export async function removeFromPlaylist(input) {
  const { playlistId, items } = input || {};
  checkPlaylistId(playlistId, 'remove');
  if (!Array.isArray(items)) throw error('ParseError', 'playlist remove: items is not an array');
  const ids = items.map(videoIdOf);
  const remoteIds = items.map((item) => (item && typeof item.remoteItemId === 'string' && item.remoteItemId !== '' ? item.remoteItemId : null));
  // 移除要 setVideoId：宿主給了 remoteItemId 就直接用，沒有的才掃清單找（舊版 getSetVideoId）。
  const lookup = new Set(ids.filter((id, i) => id !== null && remoteIds[i] === null));
  const yt = await innertube();
  const t0 = now();
  let found = new Map();
  if (lookup.size > 0) {
    try {
      found = await scanPlaylist(yt, playlistId, lookup);
    } catch (e) {
      return allFailed(e, items.length);
    }
  }
  const results = [];
  // 以 setVideoId（清單裡的那一格）去重，不以 videoId：同一支影片在清單裡出現兩次、宿主給了兩個不同的
  // remoteItemId 時兩格都要移除；同一格（含掃到的與宿主給的相同）只送一次，之後是 notPresent。
  const done = new Map(); // setVideoId（找不到時 `video:<videoId>`）→ 第一次的結果
  const state = { abort: null };
  for (let i = 0; i < items.length; i++) {
    const id = ids[i];
    if (id === null) {
      results.push({ status: 'failed', error: error('ParseError', 'playlist remove: invalid video id') });
      continue;
    }
    if (remoteIds[i] === null && !found.has(id)) {
      results.push({ status: 'notPresent' });
      continue;
    }
    const setVideoId = remoteIds[i] !== null ? remoteIds[i] : found.get(id).setVideoId;
    const key = setVideoId === null ? `video:${id}` : setVideoId;
    let result;
    if (done.has(key)) {
      const first = done.get(key);
      result = first.status === 'failed' ? first : { status: 'notPresent' };
    } else if (setVideoId === null) {
      // 清單裡有這支影片、回應卻沒有 setVideoId（版面變了）：不猜，這一項失敗。
      result = { status: 'failed', error: error('UnexpectedError', 'playlist remove: the video is in the playlist but the response has no setVideoId') };
    } else if (state.abort !== null) {
      result = failedResult(state.abort);
    } else {
      result = await writeOne(yt, removeBody(playlistId, id, setVideoId), 'removed', state);
    }
    if (!done.has(key)) done.set(key, result);
    results.push(result);
  }
  if (state.abort !== null && results.every((r) => r.status === 'failed')) throw state.abort;
  fmp.log.debug('playlist remove', { requested: items.length, removed: results.filter((r) => r.status === 'removed').length, ms: now() - t0 });
  return { results };
}

// ---------------------------------------------------------------- charts
export function chartList() {
  return chartListOf();
}

export async function chart(input) {
  const body = chartRequest(input);
  const yt = await innertube();
  const t0 = now();
  // 匿名可讀的公開歌單：userPreference，被拒不補登入（沒有私人榜單）。4xx／5xx 原樣往外。
  const res = await browse(yt, body, 'userPreference');
  if (res.status >= 400) throw res.error;
  const tracks = parseChartResponse(res.data);
  fmp.log.debug('chart', { count: tracks.length, ms: now() - t0 });
  return { tracks };
}

// ---------------------------------------------------------------- login
export { loginVerify } from './login.js';
