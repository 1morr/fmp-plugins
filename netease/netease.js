/* ==FMP Plugin==
{
  "id": "netease",
  "name": "網易雲音樂",
  "version": "1.1.0",
  "author": "FMP",
  "description": "搜尋網易雲音樂的歌曲並播放，可用 QR 碼登入。",
  "apiVersion": 1,
  "capabilities": [
    "search",
    "resolveStream",
    "login"
  ],
  "allowedHosts": [
    "music.163.com",
    "music.126.net"
  ],
  "login": {
    "methods": [
      "qr"
    ]
  },
  "rateLimit": {
    "maxConcurrentRequests": 2,
    "minRequestIntervalMs": 300
  },
  "redaction": {
    "keyNames": [
      "unikey",
      "encSecKey"
    ]
  }
}
==/FMP Plugin== */
// src/aes.js
var SBOX = new Uint8Array(256);
{
  let p = 1;
  let q = 1;
  do {
    p = p ^ p << 1 & 255 ^ (p & 128 ? 27 : 0);
    q ^= q << 1;
    q ^= q << 2;
    q ^= q << 4;
    q &= 255;
    if (q & 128) q ^= 9;
    const rot = (x, n) => (x << n | x >> 8 - n) & 255;
    SBOX[p] = q ^ rot(q, 1) ^ rot(q, 2) ^ rot(q, 3) ^ rot(q, 4) ^ 99;
  } while (p !== 1);
  SBOX[0] = 99;
}
function xtime(x) {
  return (x << 1 ^ (x & 128 ? 27 : 0)) & 255;
}
function expandKey(key) {
  const w = new Uint8Array(176);
  w.set(key);
  let rcon = 1;
  for (let i = 16; i < 176; i += 4) {
    let t0 = w[i - 4];
    let t1 = w[i - 3];
    let t2 = w[i - 2];
    let t3 = w[i - 1];
    if (i % 16 === 0) {
      [t0, t1, t2, t3] = [SBOX[t1] ^ rcon, SBOX[t2], SBOX[t3], SBOX[t0]];
      rcon = xtime(rcon);
    }
    w[i] = w[i - 16] ^ t0;
    w[i + 1] = w[i - 15] ^ t1;
    w[i + 2] = w[i - 14] ^ t2;
    w[i + 3] = w[i - 13] ^ t3;
  }
  return w;
}
function encryptBlock(rk, block) {
  const s = new Uint8Array(block);
  const addRoundKey = (round) => {
    for (let i = 0; i < 16; i++) s[i] ^= rk[round * 16 + i];
  };
  addRoundKey(0);
  for (let round = 1; round <= 10; round++) {
    const t = new Uint8Array(16);
    for (let c = 0; c < 4; c++) {
      for (let r = 0; r < 4; r++) t[c * 4 + r] = SBOX[s[(c + r) % 4 * 4 + r]];
    }
    s.set(t);
    if (round < 10) {
      for (let c = 0; c < 4; c++) {
        const a0 = s[c * 4];
        const a1 = s[c * 4 + 1];
        const a2 = s[c * 4 + 2];
        const a3 = s[c * 4 + 3];
        const all = a0 ^ a1 ^ a2 ^ a3;
        s[c * 4] = a0 ^ all ^ xtime(a0 ^ a1);
        s[c * 4 + 1] = a1 ^ all ^ xtime(a1 ^ a2);
        s[c * 4 + 2] = a2 ^ all ^ xtime(a2 ^ a3);
        s[c * 4 + 3] = a3 ^ all ^ xtime(a3 ^ a0);
      }
    }
    addRoundKey(round);
  }
  return s;
}
function utf8Bytes(text) {
  const bytes = [];
  for (const ch of text) {
    let cp = ch.codePointAt(0);
    if (cp < 128) bytes.push(cp);
    else if (cp < 2048) bytes.push(192 | cp >> 6, 128 | cp & 63);
    else if (cp < 65536) {
      bytes.push(224 | cp >> 12, 128 | cp >> 6 & 63, 128 | cp & 63);
    } else {
      bytes.push(
        240 | cp >> 18,
        128 | cp >> 12 & 63,
        128 | cp >> 6 & 63,
        128 | cp & 63
      );
    }
  }
  return Uint8Array.from(bytes);
}
function aes128EcbEncrypt(key, data) {
  if (key.length !== 16) throw new Error("AES-128 key must be 16 bytes");
  const rk = expandKey(key);
  const pad = 16 - data.length % 16;
  const padded = new Uint8Array(data.length + pad);
  padded.set(data);
  padded.fill(pad, data.length);
  const out = new Uint8Array(padded.length);
  for (let i = 0; i < padded.length; i += 16) {
    out.set(encryptBlock(rk, padded.subarray(i, i + 16)), i);
  }
  return out;
}
function hexUpper(bytes) {
  let out = "";
  for (const b of bytes) out += (b < 16 ? "0" : "") + b.toString(16);
  return out.toUpperCase();
}
function aes128CbcEncrypt(key, iv, data) {
  if (key.length !== 16) throw new Error("AES-128 key must be 16 bytes");
  if (iv.length !== 16) throw new Error("CBC iv must be 16 bytes");
  const rk = expandKey(key);
  const pad = 16 - data.length % 16;
  const padded = new Uint8Array(data.length + pad);
  padded.set(data);
  padded.fill(pad, data.length);
  const out = new Uint8Array(padded.length);
  let previous = iv;
  const block = new Uint8Array(16);
  for (let i = 0; i < padded.length; i += 16) {
    for (let j = 0; j < 16; j++) block[j] = padded[i + j] ^ previous[j];
    previous = encryptBlock(rk, block);
    out.set(previous, i);
  }
  return out;
}
var BASE64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
function base64Encode(bytes) {
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i];
    const b1 = i + 1 < bytes.length ? bytes[i + 1] : 0;
    const b2 = i + 2 < bytes.length ? bytes[i + 2] : 0;
    out += BASE64[b0 >> 2] + BASE64[(b0 & 3) << 4 | b1 >> 4];
    out += i + 1 < bytes.length ? BASE64[(b1 & 15) << 2 | b2 >> 6] : "=";
    out += i + 2 < bytes.length ? BASE64[b2 & 63] : "=";
  }
  return out;
}

// src/errors.js
function error(fmpError, message, extra) {
  return { fmpError, message, ...extra };
}
function asInt(value) {
  if (typeof value === "number" && Number.isFinite(value)) return Math.trunc(value);
  if (typeof value === "string" && /^-?\d+$/.test(value.trim())) return Number(value);
  return null;
}
function statusError(status, context) {
  const detail = `${context}: HTTP ${status}`;
  if (status === 460 || status === 462) return error("VerificationRequired", detail);
  if (status >= 500) return error("NetworkError", detail);
  return error("UnexpectedError", detail);
}
function responseCodeError(code, message, context) {
  const detail = `${context}: code ${code} ${message || ""}`.trim();
  if (code === -460) return error("VerificationRequired", detail);
  if (code === 301) return error("AuthRequired", detail);
  return error("UnexpectedError", detail);
}
function streamUnavailableError(item, context) {
  const fee = asInt(item.fee);
  const code = asInt(item.code);
  const flag = asInt(item.flag);
  const detail = `${context}: no url (code ${code}, fee ${fee}, flag ${flag})`;
  if (code === 301) return error("AuthRequired", detail);
  if (fee === 1 || fee === 4) return error("Unavailable", detail, { reason: "membership" });
  if (code === -110 || flag !== null && (flag & 256) !== 0) {
    return error("Unavailable", detail, { reason: "copyright" });
  }
  if (code === 404 && fee === 0) return error("AuthRequired", detail);
  return error("NotFound", detail);
}

// src/login.js
function qrStatusOf(code) {
  switch (code) {
    case 801:
      return "waiting";
    case 802:
      return "scanned";
    case 800:
      return "expired";
    case 803:
      return "done";
    default:
      return null;
  }
}
var COOKIE_ATTRIBUTES = /* @__PURE__ */ new Set([
  "path",
  "domain",
  "expires",
  "max-age",
  "httponly",
  "secure",
  "samesite"
]);
function pairOf(text) {
  const equals = text.indexOf("=");
  if (equals <= 0) return null;
  return [text.slice(0, equals).trim(), text.slice(equals + 1).trim()];
}
function parseSetCookies(headerValues) {
  const out = {};
  for (const line of Array.isArray(headerValues) ? headerValues : []) {
    if (typeof line !== "string") continue;
    const pair = pairOf(line.split(";")[0]);
    if (pair !== null && pair[1] !== "") out[pair[0]] = pair[1];
  }
  return out;
}
function parseCookieString(text) {
  const out = {};
  if (typeof text !== "string") return out;
  for (const part of text.split(";")) {
    const pair = pairOf(part);
    if (pair === null || COOKIE_ATTRIBUTES.has(pair[0].toLowerCase()) || pair[1] === "") continue;
    out[pair[0]] = pair[1];
  }
  return out;
}
function qrCredentials(setCookies, bodyCookie) {
  let jar = parseSetCookies(setCookies);
  if (!jar.MUSIC_U) jar = parseCookieString(bodyCookie);
  if (!jar.MUSIC_U) {
    throw error("ParseError", "qr poll: code 803 but no MUSIC_U in Set-Cookie or body cookie");
  }
  const cookies = { MUSIC_U: jar.MUSIC_U };
  if (jar.__csrf) cookies.__csrf = jar.__csrf;
  return { cookies };
}
function verifyCookie(credentials) {
  const cookies = credentials && credentials.cookies;
  const musicU = cookies && cookies.MUSIC_U;
  if (typeof musicU !== "string" || musicU === "") {
    throw error("CredentialInvalid", "verify: credentials have no MUSIC_U");
  }
  const parts = [`MUSIC_U=${musicU}`];
  if (typeof cookies.__csrf === "string" && cookies.__csrf !== "") parts.push(`__csrf=${cookies.__csrf}`);
  parts.push("os=pc", "deviceId=fmp");
  return parts.join("; ");
}
function accountOf(json, onCode, artwork2) {
  if (json === null || typeof json !== "object") throw error("ParseError", "verify: not an object");
  if (json.code === 301) throw error("CredentialInvalid", "verify: code 301");
  if (json.code !== 200) throw onCode(json.code, json.message || json.msg, "verify");
  const profile = json.profile;
  if (profile === null || typeof profile !== "object") {
    throw error("CredentialInvalid", "verify: code 200 without profile");
  }
  const id = profile.userId ?? (json.account && json.account.id);
  if (id === void 0 || id === null || id === "") throw error("ParseError", "verify: no user id");
  const nickname = typeof profile.nickname === "string" ? profile.nickname : "";
  const account = { userId: String(id), displayName: nickname === "" ? String(id) : nickname };
  const avatar = artwork2(profile.avatarUrl);
  if (avatar.length > 0) account.avatar = avatar;
  return account;
}

// src/weapi.js
var PRESET_KEY = "0CoJUm6Qyw8W8jud";
var IV = "0102030405060708";
var BASE62 = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
var RSA_MODULUS_HEX = "00e0b509f6259df8642dbc35662901477df22677ec152b5ff68ace615bb7b725152b3ab17a876aea8a5aa76d2e417629ec4ee341f56135fccf695280104e0312ecbda92557c93870114af6c9d05c4f7f0c3685b7a46bee255932575cce10b424d813cfe4875d3e82047b97ddef52741d546b8e289dc6935b3ece0462db0a22b8e7";
var RSA_EXPONENT = 65537;
var RSA_MODULUS = BigInt(`0x${RSA_MODULUS_HEX}`);
function randomSecret(random = Math.random) {
  let out = "";
  for (let i = 0; i < 16; i++) out += BASE62[Math.floor(random() * BASE62.length)];
  return out;
}
function modPow(base, exponent, modulus) {
  let result = BigInt(1);
  let b = base % modulus;
  let e = BigInt(exponent);
  const zero = BigInt(0);
  const one = BigInt(1);
  while (e > zero) {
    if ((e & one) === one) result = result * b % modulus;
    b = b * b % modulus;
    e >>= one;
  }
  return result;
}
function rsaEncryptSecret(secret) {
  const reversed = [...secret].reverse().join("");
  let hex = "";
  for (const b of utf8Bytes(reversed)) hex += (b < 16 ? "0" : "") + b.toString(16);
  const output = modPow(BigInt(`0x${hex}`), RSA_EXPONENT, RSA_MODULUS);
  return output.toString(16).padStart(256, "0");
}
function aesBase64(text, key) {
  return base64Encode(aes128CbcEncrypt(utf8Bytes(key), utf8Bytes(IV), utf8Bytes(text)));
}
function weapiEncrypt(data, secret = randomSecret()) {
  const layer1 = aesBase64(JSON.stringify(data), PRESET_KEY);
  return { params: aesBase64(layer1, secret), encSecKey: rsaEncryptSecret(secret) };
}

// src/plugin.js
var MUSIC = "https://music.163.com";
var INTERFACE = "https://interface3.music.163.com";
var DESKTOP_USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; WOW64) AppleWebKit/537.36 (KHTML, like Gecko) Safari/537.36 Chrome/91.0.4472.164 NeteaseMusicDesktop/3.0.18.203152";
var API_HEADERS = {
  Referer: "https://music.163.com/",
  Origin: "https://music.163.com",
  Accept: "application/json, text/plain, */*",
  "User-Agent": DESKTOP_USER_AGENT,
  "Content-Type": "application/x-www-form-urlencoded"
};
var MEDIA_HEADERS = {
  Origin: "https://music.163.com",
  Referer: "https://music.163.com/",
  "User-Agent": DESKTOP_USER_AGENT
};
var ALLOWED_DOMAINS = ["music.163.com", "music.126.net"];
var SEARCH_PAGE_SIZE = 20;
var EAPI_KEY = "e82ckenh8dichen8";
var EAPI_SEPARATOR = "-36cd479b6b5-";
var EAPI_PATH = "/api/song/enhance/player/url/v1";
function hostOf(url) {
  const match = /^https:\/\/([^/?#:]+)(?::\d+)?(?:[/?#]|$)/i.exec(url);
  return match ? match[1].toLowerCase() : null;
}
function isAllowedHttps(url) {
  const host = hostOf(url);
  return host !== null && ALLOWED_DOMAINS.some((d) => host === d || host.endsWith(`.${d}`));
}
function toHttps(url) {
  return typeof url === "string" && url.startsWith("http://") ? `https://${url.slice(7)}` : url;
}
function form(fields) {
  return Object.entries(fields).map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`).join("&");
}
var MAINLAND_IP_HEADERS = { "X-Real-IP": "118.88.88.88" };
async function post(url, body, context, extraHeaders) {
  const response = await fmp.http.request({
    url,
    method: "POST",
    headers: { ...API_HEADERS, ...extraHeaders },
    body,
    auth: "userPreference",
    // ADR 0012：搜尋與取流依「以登入身分瀏覽與播放」帶憑證
    idempotent: true
  });
  if (response.status !== 200) throw statusError(response.status, context);
  let json;
  try {
    json = JSON.parse(response.body);
  } catch (e) {
    throw error("ParseError", `${context}: not JSON`);
  }
  if (json === null || typeof json !== "object") throw error("ParseError", `${context}: not an object`);
  if (typeof json.code === "number" && json.code !== 200 && json.code !== 0) {
    throw responseCodeError(json.code, json.message || json.msg, context);
  }
  return json;
}
function eapiParams(path, data) {
  const text = JSON.stringify(data);
  const digest = fmp.crypto.md5(`nobody${path}use${text}md5forencrypt`);
  const payload = `${path}${EAPI_SEPARATOR}${text}${EAPI_SEPARATOR}${digest}`;
  return hexUpper(aes128EcbEncrypt(utf8Bytes(EAPI_KEY), utf8Bytes(payload)));
}
var ARTWORK_SIZES = [120, 200, 400];
function artwork(picUrl) {
  const base = toHttps(picUrl);
  if (typeof base !== "string" || base === "" || !isAllowedHttps(base)) return [];
  const clean = base.split("?")[0];
  return ARTWORK_SIZES.map((size) => ({ url: `${clean}?param=${size}y${size}`, width: size }));
}
async function search({ keyword, page }) {
  const offset = (page - 1) * SEARCH_PAGE_SIZE;
  const json = await post(
    `${MUSIC}/api/cloudsearch/pc`,
    form({ s: keyword, type: 1, limit: SEARCH_PAGE_SIZE, offset, total: true }),
    "search"
  );
  const result = json.result && typeof json.result === "object" ? json.result : {};
  const songs = Array.isArray(result.songs) ? result.songs : [];
  const songCount = typeof result.songCount === "number" ? result.songCount : 0;
  const items = [];
  for (const song of songs) {
    if (song === null || typeof song !== "object" || song.id === void 0 || song.id === null) continue;
    const artists = (song.ar || song.artists || []).map((a) => a && typeof a.name === "string" ? a.name : "").filter((n) => n !== "");
    const album = song.al || song.album;
    const dt = typeof song.dt === "number" ? song.dt : song.duration;
    items.push({
      sourceId: String(song.id),
      title: typeof song.name === "string" && song.name !== "" ? song.name : "Unknown",
      uploader: artists.length > 0 ? artists.join(", ") : null,
      durationMs: typeof dt === "number" && dt >= 0 ? Math.trunc(dt) : null,
      artwork: artwork(album && album.picUrl)
    });
  }
  fmp.log.debug("search results", { count: items.length, total: songCount });
  return { items, hasMore: page * SEARCH_PAGE_SIZE < songCount };
}
function levelFor(quality) {
  return quality === "medium" || quality === "low" ? "standard" : "exhigh";
}
function describe(type) {
  switch (String(type || "").toLowerCase()) {
    case "mp3":
      return { container: "mp3", codec: "mp3" };
    case "flac":
      return { container: "flac", codec: "flac" };
    case "m4a":
    case "aac":
      return { container: "mp4", codec: "aac" };
    default:
      return null;
  }
}
async function resolveStream({ sourceId, formats, quality }) {
  if (!/^\d+$/.test(sourceId)) throw error("NotFound", `resolveStream: bad song id ${sourceId}`);
  const payload = { ids: [Number(sourceId)], level: levelFor(quality), encodeType: "flac" };
  const json = await post(
    `${INTERFACE}/eapi/song/enhance/player/url/v1`,
    form({ params: eapiParams(EAPI_PATH, payload) }),
    "player",
    MAINLAND_IP_HEADERS
  );
  const item = Array.isArray(json.data) ? json.data[0] : null;
  if (item === null || typeof item !== "object") throw error("NotFound", "player: no stream data");
  const url = toHttps(item.url);
  if (typeof url !== "string" || url === "") throw streamUnavailableError(item, "player");
  if (!isAllowedHttps(url)) throw error("ParseError", `player: unexpected host ${hostOf(url) || "not https"}`);
  const format = describe(item.type);
  const wanted = format && (formats || []).some((f) => f.container === format.container && f.codec === format.codec);
  if (!wanted) throw error("NotFound", `player: no playable format (type ${item.type})`);
  const candidate = { url, headers: { ...MEDIA_HEADERS }, ...format };
  if (typeof item.br === "number" && item.br > 0) candidate.bitrate = item.br;
  if (typeof item.expi === "number" && item.expi > 0) candidate.expiresAt = Date.now() + item.expi * 1e3;
  const result = { candidates: [candidate] };
  if (item.freeTrialInfo !== null && item.freeTrialInfo !== void 0) result.previewOnly = true;
  return result;
}
var QR_COOKIE = "os=pc; osver=Microsoft-Windows-10-Professional-build-10586-64bit; appver=2.7.1.198277; channel=netease; __csrf=; MUSIC_U=";
var QR_LOGIN_URL = `${MUSIC}/login?codekey=`;
async function weapiPost(path, data, context, idempotent) {
  const { params, encSecKey } = weapiEncrypt(data);
  const response = await fmp.http.request({
    url: `${MUSIC}/weapi/${path}?csrf_token=`,
    method: "POST",
    headers: { ...API_HEADERS, Cookie: QR_COOKIE },
    body: form({ params, encSecKey }),
    auth: "never",
    idempotent
  });
  if (response.status !== 200) throw statusError(response.status, context);
  let json;
  try {
    json = JSON.parse(response.body);
  } catch (e) {
    throw error("ParseError", `${context}: not JSON`);
  }
  if (json === null || typeof json !== "object") throw error("ParseError", `${context}: not an object`);
  return { json, headers: response.headers || {} };
}
async function loginQrStart() {
  const { json } = await weapiPost("login/qrcode/unikey", { type: 1 }, "qr start", true);
  if (json.code !== 200) throw responseCodeError(json.code, json.message || json.msg, "qr start");
  if (typeof json.unikey !== "string" || json.unikey === "") {
    throw error("ParseError", "qr start: no unikey");
  }
  return { qrText: `${QR_LOGIN_URL}${json.unikey}`, token: json.unikey };
}
async function loginQrPoll(token) {
  const { json, headers } = await weapiPost(
    "login/qrcode/client/login",
    { type: 1, key: token },
    "qr poll",
    false
  );
  const status = qrStatusOf(json.code);
  if (status === null) throw responseCodeError(json.code, json.message || json.msg, "qr poll");
  if (status !== "done") return { status };
  return { status, credentials: qrCredentials(headers["set-cookie"], json.cookie) };
}
async function accountRequest(method, path, cookie) {
  return fmp.http.request({
    url: `${MUSIC}${path}`,
    method,
    headers: {
      Referer: API_HEADERS.Referer,
      Origin: API_HEADERS.Origin,
      Accept: API_HEADERS.Accept,
      "User-Agent": API_HEADERS["User-Agent"],
      Cookie: cookie
    },
    auth: "never"
  });
}
async function loginVerify(credentials) {
  const cookie = verifyCookie(credentials);
  let response = await accountRequest("GET", "/api/nuser/account/get", cookie);
  if (response.status !== 200) {
    response = await accountRequest("POST", "/api/w/nuser/account/get", cookie);
  }
  if (response.status !== 200) throw statusError(response.status, "verify");
  let json;
  try {
    json = JSON.parse(response.body);
  } catch (e) {
    throw error("ParseError", "verify: not JSON");
  }
  return accountOf(json, responseCodeError, artwork);
}
export {
  loginQrPoll,
  loginQrStart,
  loginVerify,
  resolveStream,
  search
};
