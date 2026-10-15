// mix：YouTube 的 Mix（播放清單 id `RD<videoId>`）。直接讀 innertube `/next` 的原始 JSON，
// 不走 getInfo／getPlaylist。舊版 youtube_source.dart 也是同一個請求。
//
// cursor 只有插件自己的 `v1:<最後一首的 videoId>:<它在 Mix 裡的索引>`：續取以最後一首當 videoId、
// 帶 playlistIndex 再打一次 /next（舊版「加載更多」的做法，2026-10 實機驗過）。匿名 WEB 的 RD 回應沒有
// continuations（2026-10 實測）；就算回應帶了也不用，YouTube token 的續取形狀沒有驗證過。
import { error } from './errors.js';
import { isAllowedHttps } from './urls.js';

const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;
const MIX_ID = /^RD[A-Za-z0-9_-]{11}$/;

// 索引上限與解析一致：產生的 cursor 一定解析得回來；超出或算出負數就不給 cursor，由宿主換種子。
const MAX_INDEX = 999999;
const CURSOR = /^v1:([A-Za-z0-9_-]{11}):(\d{1,6})$/;

/** 輸入 → /next 的 body、要回傳的 mixId、續取時的最後一首（開始時 null）。輸入不合法丟 ParseError。 */
export function mixRequest(input) {
  if (input && input.seed) {
    const id = input.seed.sourceId;
    if (typeof id !== 'string' || !VIDEO_ID.test(id)) throw error('ParseError', `invalid seed sourceId: ${id}`);
    const mixId = `RD${id}`;
    return { mixId, lastVideoId: null, body: { videoId: id, playlistId: mixId, racyCheckOk: true, contentCheckOk: true } };
  }
  const { mixId, cursor } = input || {};
  if (typeof mixId !== 'string' || !MIX_ID.test(mixId)) throw error('ParseError', `invalid mixId: ${mixId}`);
  if (typeof cursor !== 'string' || cursor === '') throw error('ParseError', 'cursor must be a non-empty string');
  const m = CURSOR.exec(cursor);
  if (!m) throw error('ParseError', `malformed cursor: ${cursor}`);
  const body = { videoId: m[1], playlistId: mixId, playlistIndex: Number(m[2]), racyCheckOk: true, contentCheckOk: true };
  return { mixId, lastVideoId: m[1], body };
}

// "3:33" / "1:02:03" → 毫秒；格式不對或 0 是 null。
export function durationMs(text) {
  if (typeof text !== 'string' || !/^\d+(:\d{1,2}){1,2}$/.test(text)) return null;
  const seconds = text.split(':').reduce((acc, part) => acc * 60 + Number(part), 0);
  return seconds > 0 ? seconds * 1000 : null;
}

export function textOf(t) {
  if (!t) return null;
  if (typeof t.simpleText === 'string') return t.simpleText;
  const runs = Array.isArray(t.runs) ? t.runs : [];
  const joined = runs.map((r) => (r && typeof r.text === 'string' ? r.text : '')).join('');
  return joined || null;
}

// 有對應官方版本的項目包在 playlistPanelVideoWrapperRenderer 裡。
function rendererOf(item) {
  if (!item || typeof item !== 'object') return null;
  const wrapper = item.playlistPanelVideoWrapperRenderer;
  return item.playlistPanelVideoRenderer
    || (wrapper && wrapper.primaryRenderer && wrapper.primaryRenderer.playlistPanelVideoRenderer)
    || null;
}

/** 一個 playlistPanelVideoRenderer → TrackSummary（欄位同 search）；沒有長度的（直播、首播）是 null。 */
function toTrack(renderer) {
  const sourceId = renderer && renderer.videoId;
  if (typeof sourceId !== 'string' || !sourceId) return null;
  const ms = durationMs(textOf(renderer.lengthText));
  if (ms === null) return null;
  const thumbs = (renderer.thumbnail && renderer.thumbnail.thumbnails) || [];
  return {
    sourceId,
    title: textOf(renderer.title) || sourceId,
    uploader: textOf(renderer.shortBylineText),
    durationMs: ms,
    artwork: thumbs
      .filter((t) => t && isAllowedHttps(t.url, ['ytimg.com']))
      .map((t) => ({ url: t.url, width: t.width || null })),
  };
}

// base：contents[0] 在 Mix 裡的索引。回傳的曲目帶 index（只在這個模組內用，出口會拿掉）。
function tracksOf(contents, base) {
  const seen = new Set();
  const tracks = [];
  contents.forEach((item, i) => {
    const track = toTrack(rendererOf(item));
    if (!track || seen.has(track.sourceId)) return;
    seen.add(track.sourceId);
    tracks.push({ ...track, index: base + i });
  });
  return tracks;
}

/**
 * /next 的回應 JSON → {title, tracks, cursor}。播放清單在 contents.twoColumnWatchNextResults.playlist.playlist。
 * 有曲目就給自己的 cursor（索引不在 0–MAX_INDEX 內時不給）；回應的 continuations 不用。
 * lastVideoId 非 null（續取）時，丟掉視窗裡到它為止的曲目，一首新的都沒有就 tracks: []、cursor: null；
 * 續取的回應沒有播放清單也是空的一批（不丟 NotFound：cursor 停在原地的話宿主不會換種子，Mix 就停了）。
 */
export function parseMixResponse(data, { lastVideoId = null }) {
  if (!data || typeof data !== 'object') throw error('ParseError', 'mix response is not an object');
  const resume = lastVideoId !== null;
  const twoColumn = data.contents && data.contents.twoColumnWatchNextResults;
  if (!twoColumn) throw error('ParseError', 'mix response has no twoColumnWatchNextResults');
  const panel = twoColumn.playlist && twoColumn.playlist.playlist;
  if (!panel) {
    if (resume) return { title: null, tracks: [], cursor: null };
    // 影片存在但 YouTube 不給它 Mix（私人、已刪除、直播等）。
    throw error('NotFound', 'no Mix playlist for this video');
  }
  if (!Array.isArray(panel.contents)) throw error('ParseError', 'mix playlist has no contents');
  const title = typeof panel.title === 'string' ? panel.title : null;
  // 視窗第一項的索引：目前這首（selected）在 currentIndex，它前面的依序往回推。
  const selected = Math.max(panel.contents.findIndex((c) => { const r = rendererOf(c); return !!(r && r.selected); }), 0);
  const current = Number.isInteger(panel.currentIndex) ? panel.currentIndex : 0;
  let tracks = tracksOf(panel.contents, current - selected);
  if (resume) {
    const at = tracks.findIndex((t) => t.sourceId === lastVideoId);
    if (at >= 0) tracks = tracks.slice(at + 1);
  } else if (tracks.length === 0) {
    throw error('NotFound', 'Mix has no playable tracks');
  }
  const last = tracks[tracks.length - 1];
  const cursor = last && last.index >= 0 && last.index <= MAX_INDEX ? `v1:${last.sourceId}:${last.index}` : null;
  return { title, tracks: tracks.map(strip), cursor };
}

function strip({ index, ...track }) { // eslint-disable-line no-unused-vars -- index 只用來算 cursor
  return track;
}
