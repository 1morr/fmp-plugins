// resolveStream 用的 innertube client，以及哪些 innertube 請求可以帶登入憑證。

// Since 2026-08-26 token-free ANDROID_VR googlevideo URLs are capped at ~60 s of
// media (403 after that, and 403 on open-ended Range). VISIONOS returns full-length
// plain URLs without PO token (verified 2026-09-30). IOS as fallback.
export const CLIENTS = ['VISIONOS', 'IOS'];

// 不收瀏覽器 cookie 的 client（請求 body 的 context.client.clientName；IOS 是 'iOS'）。
// 帶上 Cookie 與 SAPISIDHASH 時 player 回 HTTP 400 INVALID_ARGUMENT（2026-10-10 Windows 實測
// VISIONOS；yt-dlp 也把 iOS、Android 系、visionOS 標成不支援 cookie）。
const COOKIELESS_CLIENT_NAMES = new Set(['VISIONOS', 'iOS', 'ANDROID', 'ANDROID_VR', 'ANDROID_MUSIC', 'ANDROID_CREATOR']);

/** innertube 請求 body 的 clientName；不是 JSON 或沒有時是 null。 */
export function clientNameOf(body) {
  if (typeof body !== 'string' || body.length === 0) return null;
  let parsed;
  try {
    parsed = JSON.parse(body);
  } catch (_) {
    return null;
  }
  const client = parsed && parsed.context && parsed.context.client;
  return client && typeof client.clientName === 'string' ? client.clientName : null;
}

/** 這個 innertube 請求可不可以帶登入憑證：body 的 clientName 收不收 cookie。 */
export function acceptsCredentials(body) {
  return !COOKIELESS_CLIENT_NAMES.has(clientNameOf(body));
}
