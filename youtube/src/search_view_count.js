// 搜尋結果每筆的觀看次數（YouTube.js 的 Video 節點的 `view_count`，來自 viewCountText）。
import { count } from './track_detail.js';

/**
 * 只認完整數字的顯示文字（"1,824,429,303 views"、"1 view"、"No views"）：不解 "1.8B" 這種縮寫
 * （四捨五入過、也隨語系變），其他形式（"1,234 watching"、非英文、缺）一律省略，不猜。
 * 回 `{viewCount}` 或 `{}`，供展開進曲目。
 */
export function searchViewCount(viewCount) {
  const text = viewCount && typeof viewCount.text === 'string' ? viewCount.text.trim() : '';
  if (/^no views$/i.test(text)) return { viewCount: 0 };
  const m = /^([\d,]+) views?$/.exec(text);
  const n = m ? count(m[1]) : null;
  return n === null ? {} : { viewCount: n };
}
