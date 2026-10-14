// trackDetail：讀 innertube `/next`（WEB client）的原始 JSON，和 mix 同一個端點、同一種取法。
// 不用 getInfo：它是 `/player` 加 `/next` 兩個請求，而 `/player` 沒有頭像與按讚數；`/next` 一個請求就有
// 簡介、頭像、觀看與按讚數（2026-10 的 mix fixture 就是一份真實的 WEB `/next` 回應）。
// 只給回應裡真的有的欄位；沒有的省略，不補 0。
import { error } from './errors.js';
import { isAllowedHttps } from './urls.js';

const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;

/** 輸入 → `/next` 的 body。輸入不合法丟 ParseError（不發請求）。YouTube 沒有分 P，`cid` 不參與。 */
export function trackDetailRequest({ sourceId }) {
  if (typeof sourceId !== 'string' || !VIDEO_ID.test(sourceId)) {
    throw error('ParseError', `invalid sourceId: ${sourceId}`);
  }
  return { videoId: sourceId, racyCheckOk: true, contentCheckOk: true };
}

// 在 contents 底下找第一個叫 name 的 renderer（位置會隨版面實驗變動，不能依索引）。
function findRenderer(contents, name) {
  for (const item of Array.isArray(contents) ? contents : []) {
    if (item && typeof item === 'object' && item[name] && typeof item[name] === 'object') return item[name];
  }
  return null;
}

/** 只含數字（可有千分位逗號）的字串 → 非負整數；其他是 null。 */
function count(text) {
  if (typeof text !== 'string' || !/^(\d{1,3}(,\d{3})+|\d+)$/.test(text)) return null;
  const n = Number(text.replace(/,/g, ''));
  return Number.isSafeInteger(n) ? n : null;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function textOf(t) {
  if (!t || typeof t !== 'object') return null;
  if (typeof t.simpleText === 'string') return t.simpleText;
  const runs = Array.isArray(t.runs) ? t.runs : [];
  return runs.map((r) => (r && typeof r.text === 'string' ? r.text : '')).join('') || null;
}

/**
 * `dateText` 的英文日期（"Oct 25, 2009"，也接 "Premiered Oct 25, 2009"、"Streamed live on …"）→ 那天
 * UTC 正午的 epoch 毫秒。回應只有日期、沒有時刻與時區，所以只精確到日；取正午而不是零點，是因為宿主以
 * 本機時區顯示：零點在 UTC 以西（美洲）會顯示成前一天，正午在 UTC−12 到 UTC+11 都落在同一天。
 * 讀不懂（含 hl 不是 en 時的其他語言格式）是 null。
 */
function publishedAt(dateText) {
  const text = textOf(dateText);
  const m = text && /\b([A-Z][a-z]{2}) (\d{1,2}), (\d{4})\b/.exec(text);
  if (!m) return null;
  const month = MONTHS.indexOf(m[1]);
  if (month < 0) return null;
  const ms = Date.UTC(Number(m[3]), month, Number(m[2]), 12);
  // Date.UTC 會把 Feb 31 進位成 3 月：進位過的不是真的日期。
  const back = new Date(ms);
  return back.getUTCMonth() === month && back.getUTCDate() === Number(m[2]) ? ms : null;
}

function viewCount(primary) {
  const r = primary.viewCount && primary.viewCount.videoViewCountRenderer;
  // 直播中顯示的是「正在觀看」的人數（"1,234 watching now"），不是觀看次數。
  if (!r || r.isLive === true) return null;
  // 顯示文字優先：有些影片的 originalViewCount 是 "0"，顯示文字才是真的次數（2026-10 實機看到）。
  const shown = r.viewCount && r.viewCount.simpleText;
  const m = typeof shown === 'string' ? /^([\d,]+) views?$/.exec(shown) : null;
  if (m) return count(m[1]);
  return count(r.originalViewCount);
}

function likeCount(primary) {
  const buttons = primary.videoActions && primary.videoActions.menuRenderer && primary.videoActions.menuRenderer.topLevelButtons;
  for (const button of Array.isArray(buttons) ? buttons : []) {
    const entity = button && button.segmentedLikeDislikeButtonViewModel && button.segmentedLikeDislikeButtonViewModel.likeCountEntity;
    if (!entity) continue;
    // 登入且按過讚時，YouTube 顯示的是含自己那一讚的 IfLiked；其他（未按、倒讚、匿名）是 IfIndifferent
    // （IfDisliked 與它相同）。優先用純數字欄位；沒有才讀完整（非縮寫）的顯示文字。按讚數被隱藏時都沒有，回 null。
    const vm = button.segmentedLikeDislikeButtonViewModel.likeButtonViewModel;
    const status = vm && vm.likeButtonViewModel && vm.likeButtonViewModel.likeStatusEntity
      && vm.likeButtonViewModel.likeStatusEntity.likeStatus;
    const which = status === 'LIKE' ? 'Liked' : 'Indifferent';
    const exact = count(entity[`likeCountIf${which}Number`]);
    if (exact !== null) return exact;
    const shown = entity[`expandedLikeCountIf${which}`] && entity[`expandedLikeCountIf${which}`].content;
    return count(shown);
  }
  return null;
}

function descriptionOf(secondary) {
  const attributed = secondary.attributedDescription && secondary.attributedDescription.content;
  let text = typeof attributed === 'string' ? attributed : '';
  if (text.trim() === '') {
    const runs = secondary.description && secondary.description.runs;
    text = Array.isArray(runs) ? runs.map((r) => (r && typeof r.text === 'string' ? r.text : '')).join('') : '';
  }
  return text.trim() === '' ? null : text.trim();
}

/**
 * `/next` 的回應 JSON → TrackDetail。沒有 `contents` 是 ParseError（形狀變了）；有 `contents` 卻一個
 * 影片資訊 renderer 都沒有是 NotFound（影片不存在、已刪除；這個形狀沒有實測，是依 mix 的同類判斷推的）。
 */
export function parseTrackDetail(data) {
  if (!data || typeof data !== 'object' || !data.contents || typeof data.contents !== 'object') {
    throw error('ParseError', 'next response has no contents');
  }
  const twoColumn = data.contents.twoColumnWatchNextResults;
  const results = twoColumn && twoColumn.results && twoColumn.results.results;
  const contents = results && results.contents;
  const primary = findRenderer(contents, 'videoPrimaryInfoRenderer');
  const secondary = findRenderer(contents, 'videoSecondaryInfoRenderer');
  if (!primary && !secondary) throw error('NotFound', 'no video info in the next response');
  const detail = {};
  if (secondary) {
    const description = descriptionOf(secondary);
    if (description !== null) detail.description = description;
    const owner = secondary.owner && secondary.owner.videoOwnerRenderer;
    const thumbs = owner && owner.thumbnail && owner.thumbnail.thumbnails;
    const avatar = (Array.isArray(thumbs) ? thumbs : [])
      .filter((t) => t && isAllowedHttps(t.url, ['ggpht.com', 'ytimg.com']))
      .map((t) => ({ url: t.url, width: Number.isInteger(t.width) && t.width > 0 ? t.width : null }));
    if (avatar.length > 0) detail.uploaderAvatar = avatar;
  }
  if (primary) {
    const published = publishedAt(primary.dateText);
    if (published !== null) detail.publishedAt = published;
    const stats = [];
    const views = viewCount(primary);
    if (views !== null) stats.push({ kind: 'view', count: views });
    const likes = likeCount(primary);
    if (likes !== null) stats.push({ kind: 'like', count: likes });
    if (stats.length > 0) detail.stats = stats;
  }
  return detail;
}
