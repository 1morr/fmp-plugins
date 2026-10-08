/* ==FMP Plugin==
{
  "id": "netease",
  "name": "網易雲音樂",
  "version": "1.0.0",
  "author": "FMP",
  "apiVersion": 1,
  "capabilities": [
    "search",
    "resolveStream"
  ],
  "allowedHosts": [
    "music.163.com",
    "music.126.net"
  ],
  "rateLimit": {
    "maxConcurrentRequests": 2,
    "minRequestIntervalMs": 300
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
async function post(url, body, context) {
  const response = await fmp.http.request({
    url,
    method: "POST",
    headers: API_HEADERS,
    body,
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
    "player"
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
export {
  resolveStream,
  search
};
