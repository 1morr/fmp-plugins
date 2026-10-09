// 登入：loginVerify 以傳進來的憑證打一次 innertube account/account_menu（R1 實測：帶 Cookie 與
// SAPISIDHASH 回 200 與帳號區塊）。舊版的帳號資訊走 browse SPaccount_overview
// （lib/services/account/youtube_account_service.dart:176-233、334-364），一樣是 Cookie＋SAPISIDHASH 的
// innertube POST；這裡只換成 R1 驗過的 account_menu，結果只取名稱、頭像與識別。
import { ORIGIN, sapisidHash } from './sapisid.js';
import { error } from './errors.js';

// WEB client 的設定同舊版 lib/core/utils/innertube_utils.dart:12-24（公開值）。
const CLIENT_VERSION = '2.20260128.05.00';
const ACCOUNT_MENU_URL = `${ORIGIN}/youtubei/v1/account/account_menu?prettyPrint=false`;
// 登入完成的必要 cookie（舊版 youtube_account_service.dart:32-36 的 requiredCookieNames）。
export const REQUIRED_COOKIES = ['SAPISID', '__Secure-1PSID', '__Secure-3PSID'];
// 頭像網域要在 manifest 的 allowedHosts 內（ggpht.com 為此加入），其餘的略過（頭像是選填）。
const AVATAR_URL = /^https:\/\/([^/?#:]+\.)?(ggpht|ytimg)\.com(?:[:/?#]|$)/i;

function cookieHeader(cookies) {
  return Object.entries(cookies)
    .filter(([, value]) => typeof value === 'string' && value !== '')
    .map(([name, value]) => `${name}=${value}`)
    .join('; ');
}

function text(node) {
  if (node == null) return null;
  if (typeof node === 'string') return node;
  if (typeof node.simpleText === 'string') return node.simpleText;
  if (Array.isArray(node.runs)) return node.runs.map((r) => (r && r.text) || '').join('');
  return null;
}

/** 回應裡所有 accountItem（帳號切換清單的每一項），深度有上限。 */
function accountItems(node, found = [], depth = 0) {
  if (depth > 30 || node == null || typeof node !== 'object') return found;
  if (Array.isArray(node)) {
    for (const item of node) accountItems(item, found, depth + 1);
    return found;
  }
  if (node.accountItem && typeof node.accountItem === 'object') found.push(node.accountItem);
  for (const key of Object.keys(node)) {
    if (key !== 'accountItem') accountItems(node[key], found, depth + 1);
  }
  return found;
}

/** 目前選中的帳號的 userId：datasync id（純數字）優先，其次頻道 handle，最後帳號名稱。 */
function userIdOf(item, name) {
  const tokens = (((item.serviceEndpoint || {}).selectActiveIdentityEndpoint || {}).supportedTokens) || [];
  for (const t of tokens) {
    const raw = t && t.datasyncIdToken && t.datasyncIdToken.datasyncIdToken;
    const id = typeof raw === 'string' ? raw.split('||').find((part) => /^\d{5,}$/.test(part)) : null;
    if (id) return id;
  }
  return text(item.channelHandle) || name;
}

/** account_menu 的 JSON → {userId, displayName, avatar}；沒有帳號項就是 null（回的是登出狀態）。 */
export function parseAccountMenu(json) {
  const items = accountItems(json);
  const item = items.find((i) => i.isSelected) || items[0];
  if (!item) return null;
  const name = text(item.accountName);
  if (!name) return null;
  const thumbnails = (item.accountPhoto && item.accountPhoto.thumbnails) || [];
  const avatar = thumbnails
    .filter((t) => typeof t.url === 'string' && AVATAR_URL.test(t.url))
    .map((t) => ({ url: t.url, width: t.width || null }));
  return { userId: userIdOf(item, name), displayName: name, avatar };
}

export async function loginVerify(credentials) {
  const cookies = (credentials && credentials.cookies) || {};
  const missing = REQUIRED_COOKIES.filter((name) => !cookies[name]);
  if (missing.length > 0) throw error('CredentialInvalid', `missing required cookies: ${missing.join(', ')}`);
  // 新憑證還沒寫入宿主，沒得注入：自己組 Cookie 與 Authorization，auth 標 never。
  const res = await fmp.http.request({
    url: ACCOUNT_MENU_URL,
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Cookie: cookieHeader(cookies),
      Authorization: sapisidHash(cookies.SAPISID, Date.now()),
      Origin: ORIGIN,
      Referer: `${ORIGIN}/`,
      'X-Origin': ORIGIN,
    },
    body: JSON.stringify({
      context: { client: { clientName: 'WEB', clientVersion: CLIENT_VERSION, hl: 'en', gl: 'US' } },
    }),
    auth: 'never',
    idempotent: true,
  });
  // auth: 'never' 的回應 credentialsAttached 是 false，401 要在這裡自己判定：憑證是我們剛組的。
  if (res.status === 401) throw error('CredentialInvalid', 'HTTP 401 from account_menu');
  if (res.status !== 200) throw error('UnexpectedError', `account_menu HTTP ${res.status}`);
  let json;
  try {
    json = JSON.parse(res.body);
  } catch (_) {
    throw error('UnexpectedError', 'account_menu: response is not JSON');
  }
  // 登出狀態的回應沒有帳號項（舊版 checkAccountStatus 同樣把「沒有使用者資料」視為無效）。
  const account = parseAccountMenu(json);
  if (!account) throw error('CredentialInvalid', 'account_menu has no signed-in account');
  return account;
}
