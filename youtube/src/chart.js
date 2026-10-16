// charts：YouTube Music 的 "New This Week" 官方策劃歌單（browse `VL<id>`），依觀看次數由高到低排。
// 規格是舊版 youtube_source.dart 的 getTrendingVideos／_fetchNewThisWeekPlaylist／getRankingTracks：
// 歌單的順序不是觀看次數的順序，排序屬於這個榜單的語意，所以在這裡做。舊版只讀第一頁（歌單約 25 首，沒有 continuation）。
import { error } from './errors.js';
import { firstPageContents, trackFromLockup, trackFromRenderer } from './playlist.js';

export const NEW_THIS_WEEK = { chartId: 'new-this-week', title: '本週新歌', playlistId: 'OLPPnm121Qlcoo7kKykmswKG0IepmDUVpag' };

export function chartList() {
  return { charts: [{ chartId: NEW_THIS_WEEK.chartId, title: NEW_THIS_WEEK.title }] };
}

/** 輸入 → browse 的 body；chartId 不認得丟 NotFound，不是字串丟 ParseError。 */
export function chartRequest(input) {
  const chartId = input && input.chartId;
  if (typeof chartId !== 'string' || chartId === '') throw error('ParseError', 'chartId must be a non-empty string');
  if (chartId !== NEW_THIS_WEEK.chartId) throw error('NotFound', `no such chart: ${chartId}`);
  return { browseId: `VL${NEW_THIS_WEEK.playlistId}` };
}

/** "14M views"、"2.2M"、"1,234 views"、"No views" → 數字；認不得是 0（排在最後）。同舊版 _parseViewCountText。 */
export function viewCountOf(text) {
  if (typeof text !== 'string') return 0;
  const cleaned = text.replace(/\s*views?\s*/i, '').replace(/,/g, '').trim();
  const m = /^(\d+(?:\.\d+)?)([BMK])?$/i.exec(cleaned);
  if (!m) return 0;
  const unit = { B: 1e9, M: 1e6, K: 1e3 }[(m[2] || '').toUpperCase()] || 1;
  return Math.round(Number(m[1]) * unit);
}

// 觀看次數那一格的文字。插件實際送的 WEB context 回 "235K"／"14M"／"No views"（不帶 "views"，日期是 "7d ago"）；
// 最小的 context 回 "235K views"／"7 days ago"（2026-10-16 兩種都實測過），所以兩種都認；"…ago" 的日期不收。
const VIEWS_TEXT = /^(?:\d[\d.,]*\s*[KMB]?(?:\s*views?)?|no views)$/i;

/**
 * lockupViewModel 的觀看次數。第一列是頻道名（可能是純數字，不看）；其後的列裡第一個符合 VIEWS_TEXT 的 part。
 * 找不到是 0（排在最後）。
 */
function lockupViews(lockup) {
  const rows = ((((lockup.metadata || {}).lockupMetadataViewModel || {}).metadata || {}).contentMetadataViewModel || {}).metadataRows || [];
  for (const row of rows.slice(1)) {
    for (const part of (row && row.metadataParts) || []) {
      const text = part && part.text && part.text.content;
      if (typeof text === 'string' && VIEWS_TEXT.test(text.trim())) return viewCountOf(text);
    }
  }
  return 0;
}

/**
 * browse 的回應 JSON → tracks（觀看次數由高到低；同數的維持歌單順序）。
 * 沒有項目區塊或解析出 0 首丟 ParseError（舊版同：榜單暫時是空的不如當成讀取失敗）。
 */
export function parseChartResponse(data) {
  const contents = data && typeof data === 'object' ? firstPageContents(data) : null;
  if (!contents) throw error('ParseError', 'chart response has no items');
  const ranked = [];
  for (const entry of contents) {
    if (!entry || typeof entry !== 'object') continue;
    let track = null;
    let views = 0;
    if (entry.lockupViewModel) {
      track = trackFromLockup(entry.lockupViewModel);
      views = lockupViews(entry.lockupViewModel);
    } else if (entry.playlistVideoRenderer) {
      track = trackFromRenderer(entry.playlistVideoRenderer);
      const first = ((entry.playlistVideoRenderer.videoInfo || {}).runs || [])[0];
      views = viewCountOf(first && first.text);
    }
    if (track) ranked.push({ track, views, index: ranked.length });
  }
  if (ranked.length === 0) throw error('ParseError', 'chart response has no playable videos');
  ranked.sort((a, b) => b.views - a.views || a.index - b.index);
  return ranked.map((r) => r.track);
}
