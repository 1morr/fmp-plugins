// QR 登入的純函式：狀態碼對應、Set-Cookie 解析、verify 回應對應。不碰宿主 API。

import { error } from './errors.js';

/** 輪詢回應的 `code`。不認得的碼由呼叫端照 responseCodeError 處理。 */
export function qrStatusOf(code) {
  switch (code) {
    case 801:
      return 'waiting';
    case 802:
      return 'scanned';
    case 800:
      return 'expired';
    case 803:
      return 'done';
    default:
      return null;
  }
}

/** Set-Cookie 的屬性名稱（body 的 `cookie` 字串把屬性和 cookie 串在一起）。 */
const COOKIE_ATTRIBUTES = new Set([
  'path',
  'domain',
  'expires',
  'max-age',
  'httponly',
  'secure',
  'samesite',
]);

function pairOf(text) {
  const equals = text.indexOf('=');
  if (equals <= 0) return null;
  return [text.slice(0, equals).trim(), text.slice(equals + 1).trim()];
}

/**
 * 多筆 `Set-Cookie`（`name=value; Path=/; …`）→ 名稱對值。取第一個 `;` 之前、第一個 `=` 切開、
 * 不解碼；同名取最後一個非空的值（空值是清除用的）。
 */
export function parseSetCookies(headerValues) {
  const out = {};
  for (const line of Array.isArray(headerValues) ? headerValues : []) {
    if (typeof line !== 'string') continue;
    const pair = pairOf(line.split(';')[0]);
    if (pair !== null && pair[1] !== '') out[pair[0]] = pair[1];
  }
  return out;
}

/** body 的 `cookie` 字串（`;` 相接的 cookie 與屬性）→ 名稱對值，略過屬性。 */
export function parseCookieString(text) {
  const out = {};
  if (typeof text !== 'string') return out;
  for (const part of text.split(';')) {
    const pair = pairOf(part);
    if (pair === null || COOKIE_ATTRIBUTES.has(pair[0].toLowerCase()) || pair[1] === '') continue;
    out[pair[0]] = pair[1];
  }
  return out;
}

/**
 * 803 的憑證：優先取 `Set-Cookie`，沒有 `MUSIC_U` 時退到 body 的 `cookie` 字串。
 * 缺 `MUSIC_U` 拋 ParseError（訊息只有名稱，沒有值）。`__csrf` 沒有就不放。
 */
export function qrCredentials(setCookies, bodyCookie) {
  let jar = parseSetCookies(setCookies);
  if (!jar.MUSIC_U) jar = parseCookieString(bodyCookie);
  if (!jar.MUSIC_U) {
    throw error('ParseError', 'qr poll: code 803 but no MUSIC_U in Set-Cookie or body cookie');
  }
  const cookies = { MUSIC_U: jar.MUSIC_U };
  if (jar.__csrf) cookies.__csrf = jar.__csrf;
  return { cookies };
}

/** verify 用的 Cookie header（舊專案 toCookieString：os=pc 讓 CDN 回桌面端可用的網址）。 */
export function verifyCookie(credentials) {
  const cookies = credentials && credentials.cookies;
  const musicU = cookies && cookies.MUSIC_U;
  if (typeof musicU !== 'string' || musicU === '') {
    throw error('CredentialInvalid', 'verify: credentials have no MUSIC_U');
  }
  const parts = [`MUSIC_U=${musicU}`];
  if (typeof cookies.__csrf === 'string' && cookies.__csrf !== '') parts.push(`__csrf=${cookies.__csrf}`);
  parts.push('os=pc', 'deviceId=fmp');
  return parts.join('; ');
}

/**
 * account/get 的回應 → LoginAccount。`code` 301（未登入）或沒有 `profile` 是憑證無效；
 * 其他 `code` 照 [onCode] 的對應。[artwork] 把頭像網址轉成 Artwork 清單。
 */
export function accountOf(json, onCode, artwork) {
  if (json === null || typeof json !== 'object') throw error('ParseError', 'verify: not an object');
  if (json.code === 301) throw error('CredentialInvalid', 'verify: code 301');
  if (json.code !== 200) throw onCode(json.code, json.message || json.msg, 'verify');
  const profile = json.profile;
  if (profile === null || typeof profile !== 'object') {
    throw error('CredentialInvalid', 'verify: code 200 without profile');
  }
  const id = profile.userId ?? (json.account && json.account.id);
  if (id === undefined || id === null || id === '') throw error('ParseError', 'verify: no user id');
  const nickname = typeof profile.nickname === 'string' ? profile.nickname : '';
  const account = { userId: String(id), displayName: nickname === '' ? String(id) : nickname };
  const avatar = artwork(profile.avatarUrl);
  if (avatar.length > 0) account.avatar = avatar;
  return account;
}
