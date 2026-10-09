// 插件對宿主的每一次 HTTP 請求都經過這裡（fetch shim 呼叫）：幫 innertube 請求掛上認證，
// 並套用「憑證無效」判定表。
import { ORIGIN, authHeadersFor } from './sapisid.js';
import { credentialInvalidError } from './errors.js';
import { acceptsCredentials, clientNameOf } from './clients.js';

export async function hostRequest({ url, method, headers, body, idempotent }) {
  // innertube 請求屬於 userPreference（ADR 0012：搜尋、串流解析）：已登入且「以登入身分瀏覽與播放」開著時，
  // 宿主才注入 Cookie 與 authHeaders，其餘情況整個丟掉，所以有憑證就算好，不必自己判斷開關。
  // 只限 /youtubei/：sw.js_data 的 visitor data 會被快取，不要讓它綁到某個帳號。
  // 不收 cookie 的 client（VISIONOS、iOS 等，見 clients.js）一律不帶，帶了 player 回 400。
  const innertube = url.startsWith(`${ORIGIN}/youtubei/`);
  const withAuth = innertube && acceptsCredentials(body);
  const authHeaders = withAuth ? authHeadersFor(await fmp.credentials.get(), Date.now()) : null;
  const res = await fmp.http.request({
    url,
    method,
    headers,
    body,
    idempotent,
    auth: withAuth ? 'userPreference' : null,
    authHeaders,
  });
  if (innertube && res.status >= 400) logInnertubeError(url, body, res);
  const invalid = credentialInvalidError(res.status, res.credentialsAttached);
  if (invalid) throw invalid;
  return res;
}

// 宿主的網路紀錄沒有 body，而 innertube 的 4xx 原因只在 body 的 Google API 錯誤物件裡。
// 只記不含值的欄位：路徑、client、錯誤的 status 與 message。
function logInnertubeError(url, body, res) {
  let e = null;
  try { e = JSON.parse(res.body).error || null; } catch (_) { /* not JSON */ }
  fmp.log.warn('innertube error', {
    path: url.slice(ORIGIN.length).replace(/\?.*$/, ''),
    status: res.status,
    clientName: clientNameOf(body),
    credentialsAttached: res.credentialsAttached === true,
    error: e && typeof e.status === 'string' ? e.status : null,
    message: e && typeof e.message === 'string' ? e.message : null,
  });
}
