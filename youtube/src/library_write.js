// libraryWrite 的純函式：請求 body、回應判讀、歌單項目掃描。發請求與流程在 plugin.js。
// 規格是舊版 lib/services/account/youtube_playlist_service.dart：addToPlaylist／removeFromPlaylist（`browse/edit_playlist`，
// ACTION_ADD_VIDEO／ACTION_REMOVE_VIDEO）、getSetVideoId／getVideoIdsInPlaylist（browse `VL<id>` 逐頁掃描）、createPlaylist
// （`playlist/create`）、_checkResponse。
import { error } from './errors.js';
import { continuationItems, firstPageContents, importable, nextToken } from './playlist.js';

const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;
// 舊版 _checkResponse：成功是 {"status": "STATUS_SUCCEEDED"}。
const SUCCEEDED = 'STATUS_SUCCEEDED';
// 這些錯誤對之後的項目也成立：停止送請求，剩下的項目標同一個失敗（已完成的結果保留）；
// 一項都沒完成時（整個請求失敗）改成拋出，由宿主轉換。
export const ABORT_KINDS = ['CredentialInvalid', 'AuthRequired', 'RateLimited'];
// 逐頁掃描的上限；YouTube 播放清單最多 5000 支、一頁約 100 支，到上限還沒掃完是異常。
export const MAX_SCAN_PAGES = 100;

function obj(x) {
  return x && typeof x === 'object' && !Array.isArray(x) ? x : null;
}

export function videoIdOf(entry) {
  const id = obj(entry) ? entry.sourceId : undefined;
  return typeof id === 'string' && VIDEO_ID.test(id) ? id : null;
}

/** playlistId 必須是 importPlaylist 收得進來的（同一個判斷）；不是丟 ParseError。 */
export function checkPlaylistId(playlistId, name) {
  if (!importable(playlistId)) throw error('ParseError', `playlist ${name}: invalid playlistId: ${playlistId}`);
}

export function createBody(title) {
  if (typeof title !== 'string' || title.trim() === '') throw error('ParseError', 'playlist create: empty title');
  // 預設私人。舊版的預設是 UNLISTED，見 README。
  return { title: title.trim(), privacyStatus: 'PRIVATE' };
}

export function addBody(playlistId, videoId) {
  return { playlistId, actions: [{ addedVideoId: videoId, action: 'ACTION_ADD_VIDEO' }] };
}

export function removeBody(playlistId, videoId, setVideoId) {
  return { playlistId, actions: [{ setVideoId, removedVideoId: videoId, action: 'ACTION_REMOVE_VIDEO' }] };
}

/**
 * 單項失敗的結果；網路類錯誤與非結構化的例外整個請求往外丟（宿主轉換）。
 * `error` 只留 FmpError 的欄位（fmpError、message、reason、retryAfterSeconds）：宿主丟的錯誤另帶 `hostErrorId`，
 * 拋出時宿主靠它認回原本的錯誤，放進 results 則是不認得的欄位，整個回傳值會被拒（ParseError）。
 */
export function failedResult(e) {
  if (!obj(e) || typeof e.fmpError !== 'string' || e.fmpError === 'NetworkError') throw e;
  const shape = { fmpError: e.fmpError };
  if (typeof e.message === 'string' && e.message !== '') shape.message = e.message;
  if (typeof e.reason === 'string') shape.reason = e.reason;
  if (typeof e.retryAfterSeconds === 'number') shape.retryAfterSeconds = e.retryAfterSeconds;
  return { status: 'failed', error: shape };
}

/**
 * 一次寫入請求（browse/edit_playlist、playlist/create）的回應 → 錯誤，成功是 null。
 * 4xx 的 body 被 YouTube.js 包進例外沒有讀，只看狀態碼：401 沒帶憑證 → AuthRequired（帶了憑證的 401 在
 * hostRequest 已經是 CredentialInvalid）、403 帶了憑證是沒有權限（沒有對應的錯誤種類，UnexpectedError）、
 * 404 → NotFound、5xx → NetworkError。2xx：回應有 error 物件，或 status 不是 STATUS_SUCCEEDED（舊版 _checkResponse）。
 */
export function writeFailure(res) {
  if (res.status >= 400) {
    const detail = `HTTP ${res.status}`;
    if (res.status === 401) return error(res.credentialsAttached ? 'CredentialInvalid' : 'AuthRequired', detail);
    if (res.status === 403) {
      return res.credentialsAttached ? error('UnexpectedError', `${detail} (no permission on this playlist?)`) : error('AuthRequired', detail);
    }
    if (res.status === 404) return error('NotFound', detail);
    return error(res.status >= 500 ? 'NetworkError' : 'UnexpectedError', detail);
  }
  const data = obj(res.data) || {};
  if (obj(data.error)) {
    const code = data.error.code === undefined ? 'UNKNOWN' : String(data.error.code);
    return error(code === '404' ? 'NotFound' : 'UnexpectedError', `error ${code}: ${String(data.error.message || '')}`.trim());
  }
  if (typeof data.status === 'string' && data.status !== SUCCEEDED) return error('UnexpectedError', `status ${data.status}`);
  return null;
}

/** 任一層底下第一個名為 key 的字串值（新版 lockupViewModel 把 setVideoId 放在選單的 playlistEditEndpoint 裡）。 */
function deepString(node, key, depth = 0) {
  if (depth > 40 || node === null || typeof node !== 'object') return null;
  if (!Array.isArray(node) && typeof node[key] === 'string' && node[key] !== '') return node[key];
  for (const child of Array.isArray(node) ? node : Object.values(node)) {
    const found = deepString(child, key, depth + 1);
    if (found !== null) return found;
  }
  return null;
}

/**
 * 一頁 browse 回應 → {entries: [{videoId, setVideoId | null}], token}。第一頁看 `contents`，續取看
 * `onResponseReceivedActions`。playlistVideoRenderer（舊版面，舊版也只認這個）與 lockupViewModel（新版面）都認；
 * 不管影片能不能播、有沒有長度，只要在清單裡就算。第一頁沒有項目區塊是 NotFound（歌單不存在或讀不到）。
 */
export function scanPage(data, { continuation }) {
  if (!obj(data)) throw error('ParseError', 'playlist response is not an object');
  const contents = continuation ? continuationItems(data) : firstPageContents(data);
  if (!contents) {
    if (continuation) throw error('ParseError', 'playlist continuation response has no items');
    throw error('NotFound', 'playlist not found or not readable');
  }
  const entries = [];
  for (const item of contents) {
    if (!obj(item)) continue;
    const renderer = obj(item.playlistVideoRenderer);
    if (renderer && typeof renderer.videoId === 'string') {
      entries.push({ videoId: renderer.videoId, setVideoId: typeof renderer.setVideoId === 'string' && renderer.setVideoId !== '' ? renderer.setVideoId : null });
      continue;
    }
    const lockup = obj(item.lockupViewModel);
    if (lockup && typeof lockup.contentId === 'string' && (lockup.contentType === undefined || lockup.contentType === 'LOCKUP_CONTENT_TYPE_VIDEO')) {
      entries.push({ videoId: lockup.contentId, setVideoId: deepString(lockup, 'setVideoId') });
    }
  }
  return { entries, token: nextToken(contents) };
}
