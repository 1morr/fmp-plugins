// importPlaylist：播放清單（innertube `browse`，browseId `VL<playlistId>`）。
// playlistFromUrl 認網址（不發請求）；importPlaylist 讀一頁，續取以 continuation token。
// 規格是舊版 youtube_source.dart 的 _parsePlaylistViaInnerTube 與 youtube_mix_shorthand.dart；回應形狀已不同
// （匿名 WEB 現在回 lockupViewModel，沒有 setVideoId），見 README。
import { error } from './errors.js';
import { isAllowedHttps } from './urls.js';
import { durationMs, textOf } from './mix.js';

// 舊版 SourceUrlPolicy.youtubeHosts。
const HOSTS = new Set(['youtube.com', 'www.youtube.com', 'm.youtube.com', 'music.youtube.com', 'youtu.be']);
const ID = /^[A-Za-z0-9_-]+$/;
const MAX_SEED_LENGTH = 64; // 舊版 youtubeMixShorthandMaxSeedLength
const MAX_PLAYLIST_ID_LENGTH = 100;

/** 沒有 `scheme://` 的輸入當成 https（舊版 withDefaultHttpsScheme）。 */
function withScheme(text) {
  return /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(text) ? text : `https://${text}`;
}

function seedOf(id) {
  return id.length > 0 && id.length <= MAX_SEED_LENGTH && ID.test(id) ? { mixSeed: { sourceId: id } } : null;
}

/**
 * 網址 → {playlistId} | {mixSeed: {sourceId}} | null。不發請求。
 * - `mix:<id>` 簡寫（不分大小寫）與 `list=RD…` 回 mixSeed；種子取 `v`，沒有就取 `RD` 後面的。
 * - 其餘 `list=` 回 playlistId（`/playlist` 路徑與 `watch?v=…&list=…`、`youtu.be/…?list=…` 都是 `list=`）。
 *   網域不在 YouTube 的清單內回 null。
 */
export function playlistFromUrl(input) {
  const raw = input && typeof input.url === 'string' ? input.url.trim() : '';
  if (raw === '') return null;
  if (raw.toLowerCase().startsWith('mix:')) return seedOf(raw.slice(4).trim());
  let url;
  try {
    url = new URL(withScheme(raw));
  } catch (_) {
    return null;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  if (!HOSTS.has(url.hostname.toLowerCase().replace(/\.+$/, ''))) return null;
  const list = url.searchParams.get('list');
  if (list === null || list === '') return null;
  if (list.startsWith('RD')) {
    const v = url.searchParams.get('v');
    return seedOf(v || list.slice(2));
  }
  if (list.length > MAX_PLAYLIST_ID_LENGTH || !ID.test(list)) return null;
  return { playlistId: list };
}

// ------------------------------------------------------------------ 請求

// cursor：`v1:<URL 編碼的 JSON {p: 歌單資料, r: 是否要帶憑證}>:<continuation token>`。後續頁的回應沒有標頭，而歌單資料
// （每頁都要給）因此帶在 cursor 裡；第一頁是靠補登入（required）才讀到的歌單，後續頁也要帶憑證。宿主只把
// cursor 當不透明字串。token 是 YouTube 給的，不解讀。
const CURSOR = /^v1:([^:]*):(.+)$/;

function obj(x) {
  return x && typeof x === 'object' && !Array.isArray(x) ? x : null;
}

/** 輸入 → {body, meta, required}：meta 在第一頁是 null，續取時是 cursor 帶的歌單資料。輸入不合法丟 ParseError。 */
export function browseRequest(input) {
  const { playlistId, cursor } = input || {};
  if (typeof playlistId !== 'string' || playlistId === '' || playlistId.length > MAX_PLAYLIST_ID_LENGTH || !ID.test(playlistId)) {
    throw error('ParseError', `invalid playlistId: ${playlistId}`);
  }
  // Mix 由 playlistFromUrl 回 mixSeed、走 mix 能力；對 VLRD… 做 browse 沒有意義。
  if (playlistId.startsWith('RD')) throw error('ParseError', `Mix is not a playlist: ${playlistId}`);
  if (cursor === undefined || cursor === null) return { body: { browseId: `VL${playlistId}` }, meta: null, required: false };
  if (typeof cursor !== 'string' || cursor === '') throw error('ParseError', 'cursor must be a non-empty string');
  const m = CURSOR.exec(cursor);
  let payload = null;
  if (m) {
    try {
      payload = JSON.parse(decodeURIComponent(m[1]));
    } catch (_) { /* 下面統一回 ParseError */ }
  }
  const meta = obj(payload) && playlistOf(payload.p);
  if (!meta) throw error('ParseError', 'malformed cursor');
  return { body: { continuation: m[2] }, meta, required: payload.r === true };
}

/** cursor 帶的歌單資料 → 原樣回傳的 playlist：只收 cursorFor 寫進去的欄位與型別，title 不能是空的；不對是 null。 */
function playlistOf(p) {
  if (!obj(p) || typeof p.title !== 'string' || p.title === '') return null;
  const playlist = { title: p.title };
  if (typeof p.description === 'string' && p.description !== '') playlist.description = p.description;
  const artwork = Array.isArray(p.artwork) ? artworkOf(p.artwork) : [];
  if (artwork.length > 0) playlist.artwork = artwork;
  if (typeof p.ownerName === 'string' && p.ownerName !== '') playlist.ownerName = p.ownerName;
  return playlist;
}

// ------------------------------------------------------------------ 回應

/**
 * 第一頁的項目（含夾在裡面的 continuationItem）：tabs[0] → sectionListRenderer → itemSectionRenderer.contents。
 * 舊版面把項目包在 playlistVideoListRenderer.contents 裡，一併認。找不到 itemSectionRenderer 是 null（歌單不存在、私人）。
 * 注意：sectionListRenderer.contents 的最後也有一個 continuationItemViewModel，但那不是歌單的下一頁，不用。
 */
function firstPageContents(data) {
  const tabs = ((obj(data.contents) || {}).twoColumnBrowseResultsRenderer || {}).tabs || [];
  for (const tab of tabs) {
    const sections = ((((obj(tab) || {}).tabRenderer || {}).content || {}).sectionListRenderer || {}).contents || [];
    for (const section of sections) {
      const contents = ((obj(section) || {}).itemSectionRenderer || {}).contents;
      if (!Array.isArray(contents)) continue;
      const wrapped = obj(contents[0]) && obj(contents[0].playlistVideoListRenderer);
      return wrapped && Array.isArray(wrapped.contents) ? wrapped.contents : contents;
    }
  }
  return null;
}

/** 續取回應的項目：onResponseReceivedActions[].appendContinuationItemsAction.continuationItems。 */
function continuationItems(data) {
  for (const key of ['onResponseReceivedActions', 'onResponseReceivedEndpoints']) {
    for (const action of Array.isArray(data[key]) ? data[key] : []) {
      const items = obj(action) && obj(action.appendContinuationItemsAction) && action.appendContinuationItemsAction.continuationItems;
      if (Array.isArray(items)) return items;
    }
  }
  return null;
}

/** 一批 contents 裡的下一頁 token：continuationItemViewModel（新）或 continuationItemRenderer（舊）。 */
function nextToken(contents) {
  for (const item of contents) {
    if (!obj(item)) continue;
    const vm = obj(item.continuationItemViewModel);
    const direct = vm && obj(vm.continuationCommand) && obj(vm.continuationCommand.innertubeCommand)
      && obj(vm.continuationCommand.innertubeCommand.continuationCommand);
    if (direct && typeof direct.token === 'string' && direct.token !== '') return direct.token;
    const renderer = obj(item.continuationItemRenderer);
    const endpoint = (renderer && obj(renderer.continuationEndpoint)) || {};
    const commands = (endpoint.commandExecutorCommand && endpoint.commandExecutorCommand.commands) || [endpoint];
    for (const c of commands) {
      const token = obj(c) && obj(c.continuationCommand) && c.continuationCommand.token;
      if (typeof token === 'string' && token !== '') return token;
    }
  }
  return null;
}

function artworkOf(sources) {
  return (Array.isArray(sources) ? sources : [])
    .filter((t) => t && isAllowedHttps(t.url, ['ytimg.com']))
    .map((t) => ({ url: t.url, width: t.width || null }));
}

/**
 * lockupViewModel（匿名 WEB 現行版面，2026-10 實測）→ TrackSummary。
 * 時長只在縮圖角標（"3:33"／"1:02:03"）；角標不是時長（直播、首播、SHORTS）或沒有的略過，同 search。
 */
function trackFromLockup(lockup) {
  const sourceId = lockup.contentId;
  if (typeof sourceId !== 'string' || sourceId === '') return null;
  if (lockup.contentType !== undefined && lockup.contentType !== 'LOCKUP_CONTENT_TYPE_VIDEO') return null;
  const image = (lockup.contentImage && lockup.contentImage.thumbnailViewModel) || {};
  let ms = null;
  for (const overlay of Array.isArray(image.overlays) ? image.overlays : []) {
    const bottom = obj(overlay) && obj(overlay.thumbnailBottomOverlayViewModel);
    for (const badge of (bottom && bottom.badges) || []) {
      const text = obj(badge) && obj(badge.thumbnailBadgeViewModel) && badge.thumbnailBadgeViewModel.text;
      if (ms === null && typeof text === 'string') ms = durationMs(text);
    }
  }
  if (ms === null) return null;
  const meta = (lockup.metadata && lockup.metadata.lockupMetadataViewModel) || {};
  const title = meta.title && typeof meta.title.content === 'string' ? meta.title.content : null;
  const rows = ((meta.metadata || {}).contentMetadataViewModel || {}).metadataRows || [];
  const part = ((obj(rows[0]) || {}).metadataParts || [])[0];
  const uploader = part && part.text && typeof part.text.content === 'string' ? part.text.content : null;
  return {
    sourceId,
    title: title || sourceId,
    uploader,
    durationMs: ms,
    artwork: artworkOf(image.image && image.image.sources),
  };
}

/** playlistVideoRenderer（舊版面）→ TrackSummary；不能播（isPlayable 為 false）或沒有長度的略過。 */
function trackFromRenderer(renderer) {
  const sourceId = renderer.videoId;
  if (typeof sourceId !== 'string' || sourceId === '' || renderer.isPlayable === false) return null;
  const seconds = Number(renderer.lengthSeconds);
  const ms = Number.isFinite(seconds) && seconds > 0 ? Math.floor(seconds) * 1000 : durationMs(textOf(renderer.lengthText));
  if (ms === null) return null;
  return {
    sourceId,
    title: textOf(renderer.title) || sourceId,
    uploader: textOf(renderer.shortBylineText),
    durationMs: ms,
    artwork: artworkOf(renderer.thumbnail && renderer.thumbnail.thumbnails),
  };
}

/**
 * contents → items（只有 track：YouTube 一律不給 remoteItemId、unavailable，見 README）。
 * 同一支影片出現兩次是兩項，不去重。
 */
function itemsOf(contents) {
  const items = [];
  for (const entry of contents) {
    if (!obj(entry)) continue;
    let track = null;
    if (obj(entry.lockupViewModel)) track = trackFromLockup(entry.lockupViewModel);
    else if (obj(entry.playlistVideoRenderer)) track = trackFromRenderer(entry.playlistVideoRenderer);
    if (track) items.push({ track });
  }
  return items;
}

/** 擁有者名稱：標頭 metadataRows 裡帶頭像的那一格，文字是 "by <名稱>"，去掉 "by "；沒有這個前綴就不給。 */
function ownerOf(model) {
  const rows = ((model.metadata || {}).contentMetadataViewModel || {}).metadataRows || [];
  for (const row of rows) {
    for (const part of (obj(row) && row.metadataParts) || []) {
      const stack = obj(part) && obj(part.avatarStack) && obj(part.avatarStack.avatarStackViewModel);
      const content = stack && stack.text && stack.text.content;
      const m = typeof content === 'string' ? /^by\s+(.+)$/i.exec(content.trim()) : null;
      if (m) return m[1];
    }
  }
  return null;
}

/** 標頭與 metadata → {title, description, ownerName}。 */
function headerOf(data) {
  const header = obj(data.header) || {};
  const page = obj(header.pageHeaderRenderer) || {};
  const model = (page.content && page.content.pageHeaderViewModel) || {};
  const meta = (obj(data.metadata) || {}).playlistMetadataRenderer || {};
  const dynTitle = (((model.title || {}).dynamicTextViewModel || {}).text || {}).content;
  const old = obj(header.playlistHeaderRenderer);
  const oldOwner = old && ((old.ownerText || {}).runs || [])[0];
  const title = [page.pageTitle, dynTitle, meta.title, old && textOf(old.title)].find((t) => typeof t === 'string' && t !== '');
  const description = [meta.description, old && textOf(old.descriptionText)].find((t) => typeof t === 'string' && t !== '');
  return {
    title: title || null,
    description: description || null,
    ownerName: ownerOf(model) || (oldOwner && typeof oldOwner.text === 'string' ? oldOwner.text : null),
  };
}

/** 回應裡的錯誤提示文字（alerts[].alertRenderer／alertWithButtonRenderer）；沒有是 null。 */
export function alertText(data) {
  for (const a of Array.isArray(data && data.alerts) ? data.alerts : []) {
    const r = obj(a) && (a.alertRenderer || a.alertWithButtonRenderer);
    const text = r && textOf(r.text);
    if (text) return text;
  }
  return null;
}

/**
 * browse 的回應 JSON → {playlist, items, token}。meta 是續取時 cursor 帶的歌單資料（第一頁 null）。
 * 第一頁沒有項目區塊（歌單不存在、私人）丟 NotFound，由呼叫端依 alertText 決定要不要補登入；形狀不對 ParseError。
 * 不給 total（標頭筆數含被隱藏的影片）、writable（匿名判斷不了）。
 */
export function parsePlaylistResponse(data, { meta }) {
  if (!obj(data)) throw error('ParseError', 'playlist response is not an object');
  const contents = meta ? continuationItems(data) : firstPageContents(data);
  if (!contents) {
    if (meta) throw error('ParseError', 'continuation response has no items');
    throw error('NotFound', 'playlist not found or not readable');
  }
  const items = itemsOf(contents);
  let playlist = meta;
  if (!playlist) {
    const h = headerOf(data);
    if (!h.title) throw error('ParseError', 'playlist response has no title');
    playlist = { title: h.title };
    if (h.description) playlist.description = h.description;
    // 封面沿用第一首的縮圖（舊版 coverUrl 也是）；標頭沒有可靠的欄位。
    if (items.length > 0 && items[0].track.artwork.length > 0) playlist.artwork = items[0].track.artwork;
    if (h.ownerName) playlist.ownerName = h.ownerName;
  }
  return { playlist, items, token: nextToken(contents) };
}

/** 下一頁的 cursor；沒有下一頁是 null。required：這一頁是以 required 讀到的。 */
export function cursorFor(playlist, token, required) {
  return token === null ? null : `v1:${encodeURIComponent(JSON.stringify({ p: playlist, r: required }))}:${token}`;
}

const LOGIN_HINT = /private|sign in|log in|login/i;

/**
 * 一次 browse 的結果 → 解析後的頁，或「讀不到」的判斷。
 * - HTTP 401／403／404，或第一頁 200 卻沒有項目區塊：讀不到。loginHint：401／403，或 200 的 alert 提到私人或要登入
 *   （4xx 的 body 被 YouTube.js 包進例外，不讀；404 一律不算）。
 * - 其他 4xx／5xx：丟原本的錯誤。
 */
export function interpret(res, meta) {
  if (res.status >= 400) {
    if (res.status === 401 || res.status === 403 || res.status === 404) {
      return { denied: true, loginHint: res.status !== 404 };
    }
    throw res.error;
  }
  try {
    return { denied: false, page: parsePlaylistResponse(res.data, { meta }) };
  } catch (e) {
    if (e && e.fmpError === 'NotFound') return { denied: true, loginHint: LOGIN_HINT.test(alertText(res.data) || '') };
    throw e;
  }
}
