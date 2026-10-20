// libraryRead：登入帳號的播放清單（innertube `browse`，browseId `FEplaylist_aggregation`，續取以 continuation token）。
// 規格是舊版 lib/services/account/youtube_playlist_service.dart 的 getPlaylists／_parsePlaylistsFromBrowse：
// gridPlaylistRenderer／playlistRenderer（經典版面）與 lockupViewModel（contentType 為播放清單）。舊版沒有分頁、
// 沒有分自己的與收藏的；這裡加了續取，並用 writable 區分（見 isOwnPlaylist）。
import { error } from './errors.js';
import { artworkOf, continuationItems, importable, nextToken } from './playlist.js';
import { textOf } from './mix.js';

const MAX_DEPTH = 15; // 舊版 _findPlaylistsRecursive
const LOCKUP_PLAYLIST_TYPES = ['LOCKUP_CONTENT_TYPE_PLAYLIST', 'PLAYLIST'];
// 筆數文字："12 videos"、"1,234 videos"、"1 video"；沒有單位的數字不收（可能是別的欄位）。
const COUNT_TEXT = /^(\d[\d,]*)\s*(?:videos?|songs?|影片|部)(?![A-Za-z])/i;
// 只有自己的清單有「刪除播放清單」的選單項目；收藏別人的、Liked／Watch Later 沒有。
const OWN_MARKER = 'deletePlaylistEndpoint';
// 2026-10 實測，lockupViewModel 底下的路徑是 metadata → lockupMetadataViewModel → menuButton → … → listItems[] →
// listItemViewModel → rendererContext → commandContext → onTap → innertubeCommand → deletePlaylistEndpoint，約 20 層；
// 不能沿用 MAX_DEPTH（15）。
const OWN_MARKER_DEPTH = 40;

function obj(x) {
  return x && typeof x === 'object' && !Array.isArray(x) ? x : null;
}

/** 這個節點底下（含自己）有沒有名為 key 的鍵。 */
function hasKey(node, key, depth = 0) {
  if (depth > OWN_MARKER_DEPTH || node === null || typeof node !== 'object') return false;
  if (Array.isArray(node)) return node.some((child) => hasKey(child, key, depth + 1));
  return Object.prototype.hasOwnProperty.call(node, key) || Object.values(node).some((child) => hasKey(child, key, depth + 1));
}

/**
 * 登入帳號自己建立的嗎？回應沒有直接的欄位，看選單有沒有刪除播放清單的端點。
 * 沒看到就當不是（寧可少給 writable，宿主不會對別人的清單送寫入）。
 */
function isOwnPlaylist(node) {
  return hasKey(node, OWN_MARKER);
}

function countOf(text) {
  const m = typeof text === 'string' ? COUNT_TEXT.exec(text.trim()) : null;
  return m ? Number(m[1].replace(/,/g, '')) : null;
}

function entry(playlistId, title, thumbnails, countTexts, node) {
  if (!importable(playlistId) || typeof title !== 'string' || title.trim() === '') return null;
  const result = { playlistId, title: title.trim(), writable: isOwnPlaylist(node) };
  const artwork = artworkOf(thumbnails);
  if (artwork.length > 0) result.artwork = artwork;
  for (const text of countTexts) {
    const count = countOf(text);
    if (count !== null && Number.isSafeInteger(count)) {
      result.trackCount = count;
      break;
    }
  }
  return result;
}

/** gridPlaylistRenderer／playlistRenderer（經典版面）。 */
function fromRenderer(renderer) {
  const thumbs = renderer.thumbnail && Array.isArray(renderer.thumbnail.thumbnails)
    ? renderer.thumbnail.thumbnails
    : (Array.isArray(renderer.thumbnails) && renderer.thumbnails[0] && renderer.thumbnails[0].thumbnails) || [];
  return entry(
    renderer.playlistId,
    textOf(renderer.title),
    thumbs,
    [textOf(renderer.videoCountShortText), textOf(renderer.videoCountText), textOf(renderer.thumbnailText)],
    renderer,
  );
}

/** lockupViewModel（2024 起的版面），contentType 不是播放清單的略過。 */
function fromLockup(lockup) {
  if (!LOCKUP_PLAYLIST_TYPES.includes(lockup.contentType)) return null;
  const meta = (lockup.metadata && lockup.metadata.lockupMetadataViewModel) || {};
  const image = lockup.contentImage || {};
  const primary = (image.collectionThumbnailViewModel || {}).primaryThumbnail;
  const thumbnail = (primary && primary.thumbnailViewModel) || image.thumbnailViewModel || {};
  const counts = [];
  for (const row of ((meta.metadata || {}).contentMetadataViewModel || {}).metadataRows || []) {
    for (const part of (obj(row) && Array.isArray(row.metadataParts) ? row.metadataParts : [])) {
      if (part && part.text) counts.push(part.text.content);
    }
  }
  for (const overlay of Array.isArray(thumbnail.overlays) ? thumbnail.overlays : []) {
    const badges = (obj(overlay) && obj(overlay.thumbnailOverlayBadgeViewModel) && overlay.thumbnailOverlayBadgeViewModel.thumbnailBadges) || [];
    for (const badge of Array.isArray(badges) ? badges : []) {
      const vm = obj(badge) && badge.thumbnailBadgeViewModel;
      if (vm) counts.push(vm.text);
    }
  }
  return entry(
    lockup.contentId,
    meta.title && meta.title.content,
    (thumbnail.image && thumbnail.image.sources) || [],
    counts,
    lockup,
  );
}

/** 遞迴找播放清單項目（舊版 _findPlaylistsRecursive）；找到一個就不再往它底下找。 */
function collect(node, out, depth = 0) {
  if (depth > MAX_DEPTH || node === null || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    for (const child of node) collect(child, out, depth + 1);
    return;
  }
  for (const key of ['gridPlaylistRenderer', 'playlistRenderer', 'lockupViewModel']) {
    const found = obj(node[key]);
    if (!found) continue;
    const item = key === 'lockupViewModel' ? fromLockup(found) : fromRenderer(found);
    if (item !== null) out.push(item);
    return;
  }
  for (const child of Object.values(node)) collect(child, out, depth + 1);
}

/** 找出頁面裡最後一個 continuation token（歌單格線的續取項目在格線尾端）；沒有是 null。 */
function lastToken(node, depth = 0) {
  if (depth > MAX_DEPTH || node === null || typeof node !== 'object') return null;
  let token = null;
  if (Array.isArray(node)) {
    token = nextToken(node.filter((x) => obj(x) && (x.continuationItemRenderer || x.continuationItemViewModel)));
  }
  for (const child of Array.isArray(node) ? node : Object.values(node)) token = lastToken(child, depth + 1) || token;
  return token;
}

// cursor：`v1:<YouTube 給的 continuation token>`，不解讀。
const CURSOR = /^v1:(.+)$/;

/** 輸入 → browse 的 body。cursor 不合法丟 ParseError。 */
export function libraryRequest(input) {
  const { cursor } = input || {};
  if (cursor === undefined || cursor === null) return { browseId: 'FEplaylist_aggregation' };
  const m = typeof cursor === 'string' ? CURSOR.exec(cursor) : null;
  if (m === null) throw error('ParseError', 'malformed cursor');
  return { continuation: m[1] };
}

/**
 * browse 回應 → {playlists, cursor}。第一頁看 `contents`，續取看 `onResponseReceivedActions`。
 * 回應標明沒登入（responseContext 的 loggedOut）丟 AuthRequired；項目依 playlistId 去重（保留第一個）。
 */
export function parseLibraryResponse(data, { continuation }) {
  if (!obj(data)) throw error('ParseError', 'library response is not an object');
  const web = (obj(data.responseContext) || {}).mainAppWebResponseContext;
  if (obj(web) && web.loggedOut === true) throw error('AuthRequired', 'library: response says signed out');
  let root;
  if (continuation) {
    root = continuationItems(data);
    if (!root) throw error('ParseError', 'library continuation response has no items');
  } else {
    root = data.contents;
  }
  const found = [];
  collect(root, found);
  const seen = new Set();
  const playlists = found.filter((p) => !seen.has(p.playlistId) && seen.add(p.playlistId));
  const token = lastToken(root);
  return { playlists, cursor: token === null ? null : `v1:${token}` };
}
