/* ==FMP Plugin==
{
  "id": "qqmusic",
  "name": "QQ 音樂",
  "version": "1.0.1",
  "author": "FMP",
  "description": "匯入 QQ 音樂的公開歌單（只讀曲目資料，用來在其他音源配對播放），不需要登入。",
  "icon": "data:image/png;base64,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",
  "apiVersion": 1,
  "capabilities": [
    "importPlaylist"
  ],
  "allowedHosts": [
    "y.qq.com",
    "url.cn"
  ],
  "rateLimit": {
    "maxConcurrentRequests": 1,
    "minRequestIntervalMs": 300
  }
}
==/FMP Plugin== */
// src/sign.js
var XOR_KEY = [212, 45, 80, 68, 195, 163, 163, 203, 157, 220, 254, 91, 204, 79, 104, 6];
var HEAD_INDICES = [21, 4, 9, 26, 16, 20, 27, 30];
var TAIL_INDICES = [18, 11, 3, 2, 1, 7, 6, 25];
var BASE64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
function base64(bytes) {
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const n = bytes[i] << 16 | (bytes[i + 1] || 0) << 8 | (bytes[i + 2] || 0);
    out += BASE64[n >> 18 & 63] + BASE64[n >> 12 & 63];
    out += i + 1 < bytes.length ? BASE64[n >> 6 & 63] : "=";
    out += i + 2 < bytes.length ? BASE64[n & 63] : "=";
  }
  return out;
}
function signOf(text, md5) {
  const hex = md5(text);
  const pick = (indices) => indices.map((i) => hex[i]).join("");
  const scrambled = XOR_KEY.map((key, i) => parseInt(hex.slice(i * 2, i * 2 + 2), 16) ^ key);
  const middle = base64(scrambled).replace(/[+/=]/g, "");
  return `zzb${pick(HEAD_INDICES)}${middle}${pick(TAIL_INDICES)}`.toLowerCase();
}

// src/plugin.js
var ENDPOINT = "https://u6.y.qq.com/cgi-bin/musics.fcg";
var HEADERS = {
  "User-Agent": "Mozilla/5.0 (Linux; Android 10) AppleWebKit/537.36",
  Referer: "https://y.qq.com/",
  "Content-Type": "application/json"
};
var PAGE_SIZE = 1e3;
var PLAYLIST_ID = /^[1-9]\d{0,15}$/;
var CURSOR = /^v1:([1-9]\d{0,6})$/;
var QQ_HOSTS = ["y.qq.com", "i.y.qq.com", "i2.y.qq.com"];
var ARTWORK_DOMAIN = "y.qq.com";
var SHORT_HOSTS = ["c.y.qq.com", "c6.y.qq.com", "url.cn"];
function error(fmpError, message) {
  return { fmpError, message };
}
function statusError(status, context) {
  const detail = `${context}: HTTP ${status}`;
  return error(status >= 500 ? "NetworkError" : "UnexpectedError", detail);
}
function splitUrl(raw) {
  const text = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`;
  const m = /^https?:\/\/([^/?#]+)([^?#]*)(?:\?([^#]*))?(?:#[\s\S]*)?$/i.exec(text);
  if (m === null || m[1].includes("@")) return null;
  return {
    host: m[1].replace(/:\d+$/, "").toLowerCase().replace(/\.+$/, ""),
    path: m[2],
    query: m[3] || ""
  };
}
function playlistIdOfUrl(parts) {
  if (parts === null || !QQ_HOSTS.includes(parts.host)) return null;
  const segments = parts.path.split("/").filter((s) => s !== "");
  const at = segments.indexOf("playlist");
  if (at >= 0) {
    const id = (segments[at + 1] || "").replace(/\.html$/i, "");
    return PLAYLIST_ID.test(id) ? id : null;
  }
  const page = segments[segments.length - 1];
  if (page === "taoge.html" || page === "playlist.html" && segments[segments.length - 2] === "details") {
    const m = /(?:^|&)id=(\d+)(?:&|$)/.exec(parts.query);
    return m !== null && PLAYLIST_ID.test(m[1]) ? m[1] : null;
  }
  return null;
}
async function playlistFromUrl(input) {
  const raw = input && typeof input.url === "string" ? input.url.trim() : "";
  if (raw === "") return null;
  const parts = splitUrl(raw);
  if (parts === null) return null;
  if (!SHORT_HOSTS.includes(parts.host)) {
    const playlistId2 = playlistIdOfUrl(parts);
    return playlistId2 === null ? null : { playlistId: playlistId2 };
  }
  const response = await fmp.http.request({
    url: `https://${parts.host}${parts.path}${parts.query === "" ? "" : `?${parts.query}`}`,
    method: "GET",
    headers: { "User-Agent": HEADERS["User-Agent"], Accept: "text/html,*/*" },
    auth: "never"
  });
  if (response.status === 404) throw error("NotFound", "short url: HTTP 404");
  if (response.status !== 200) throw statusError(response.status, "short url");
  const playlistId = playlistIdOfUrl(typeof response.url === "string" ? splitUrl(response.url) : null);
  return playlistId === null ? null : { playlistId };
}
function buildBody(playlistId, songBegin) {
  return JSON.stringify({
    req_0: {
      module: "music.srfDissInfo.aiDissInfo",
      method: "uniform_get_Dissinfo",
      param: {
        disstid: Number(playlistId),
        enc_host_uin: "",
        tag: 1,
        userinfo: 1,
        song_begin: songBegin,
        song_num: PAGE_SIZE
      }
    },
    // ct/cv 是舊專案沒有的：缺了它們匿名請求每頁只回 30 首（2026-10-21 實測，songlist 30、total 581、hasmore 1），
    // 舊專案的「起點加 1000」就此只收到第一頁。加了 ct 24、cv 0（手機網頁版的值）後一次回完。
    comm: { g_tk: 5381, uin: 0, format: "json", platform: "android", ct: 24, cv: 0 }
  });
}
function artworkOf(picurl) {
  const url = typeof picurl === "string" && picurl.startsWith("http://") ? `https://${picurl.slice(7)}` : picurl;
  const parts = typeof url === "string" && url.startsWith("https://") ? splitUrl(url) : null;
  if (parts === null || !(parts.host === ARTWORK_DOMAIN || parts.host.endsWith(`.${ARTWORK_DOMAIN}`))) return [];
  return [{ url }];
}
function trackOfSong(song) {
  if (song === null || typeof song !== "object") return null;
  const mid = typeof song.mid === "string" ? song.mid.trim() : "";
  if (mid === "" || mid.includes(":")) return null;
  const title = typeof song.name === "string" ? song.name.trim() : "";
  if (title === "") return null;
  const singers = (Array.isArray(song.singer) ? song.singer : []).map((s) => s !== null && typeof s === "object" && typeof s.name === "string" ? s.name.trim() : "").filter((n) => n !== "");
  const track = { sourceId: mid, title };
  if (singers.length > 0) track.uploader = singers.join(" / ");
  if (Number.isSafeInteger(song.interval) && song.interval >= 0) track.durationMs = song.interval * 1e3;
  return track;
}
async function importPlaylist(input) {
  const { playlistId, cursor } = input || {};
  if (typeof playlistId !== "string" || !PLAYLIST_ID.test(playlistId) || !Number.isSafeInteger(Number(playlistId))) {
    throw error("ParseError", `playlist: invalid playlistId: ${playlistId}`);
  }
  let begin = 0;
  if (cursor !== void 0 && cursor !== null) {
    const m = typeof cursor === "string" ? CURSOR.exec(cursor) : null;
    if (m === null) throw error("ParseError", "playlist: malformed cursor");
    begin = Number(m[1]);
  }
  const body = buildBody(playlistId, begin);
  const response = await fmp.http.request({
    // 簽名只算 body，所以同一個請求的網址是固定的（舊專案另帶的 `_=<時間>` 是快取破壞參數，這裡不送）。
    url: `${ENDPOINT}?sign=${signOf(body, fmp.crypto.md5)}`,
    method: "POST",
    headers: HEADERS,
    body,
    auth: "never",
    idempotent: true
    // 查詢，語意冪等
  });
  if (response.status !== 200) throw statusError(response.status, "playlist");
  let json;
  try {
    json = JSON.parse(response.body);
  } catch (e) {
    throw error("ParseError", "playlist: not JSON");
  }
  if (json === null || typeof json !== "object" || Array.isArray(json)) throw error("ParseError", "playlist: not an object");
  const req = json.req_0;
  if (json.code !== 0 || req === null || typeof req !== "object" || req.code !== 0) {
    throw error("UnexpectedError", `playlist: code ${json.code}, req_0 code ${req && req.code}`);
  }
  const data = req.data;
  if (data === null || typeof data !== "object") throw error("ParseError", "playlist: no data");
  const info = data.dirinfo;
  if (data.code === -100006 || info !== null && typeof info === "object" && info.title === "" && info.songnum === 0) {
    throw error("NotFound", `playlist: data code ${data.code} ${data.msg || ""}`.trim());
  }
  if (data.code !== 0) throw error("UnexpectedError", `playlist: data code ${data.code} ${data.msg || ""}`.trim());
  if (info === null || typeof info !== "object") throw error("ParseError", "playlist: no dirinfo");
  if (typeof info.title !== "string" || info.title.trim() === "") throw error("ParseError", "playlist: no title");
  if (!Number.isSafeInteger(info.songnum) || info.songnum < 0) throw error("ParseError", "playlist: bad songnum");
  if (!Array.isArray(data.songlist)) throw error("ParseError", "playlist: no songlist");
  const playlist = { title: info.title.trim() };
  if (typeof info.desc === "string" && info.desc.trim() !== "") playlist.description = info.desc.trim();
  const cover = artworkOf(info.picurl);
  if (cover.length > 0) playlist.artwork = cover;
  const creator = info.creator !== null && typeof info.creator === "object" ? info.creator.nick : info.host_nick;
  if (typeof creator === "string" && creator.trim() !== "") playlist.ownerName = creator.trim();
  const received = data.songlist.length;
  const items = [];
  for (const song of data.songlist) {
    const track = trackOfSong(song);
    if (track !== null) items.push({ track });
  }
  const next = begin + received;
  const more = received > 0 && next < info.songnum;
  if (!more && next < info.songnum) {
    fmp.log.warn("playlist page empty before the end", { begin, songnum: info.songnum });
  }
  fmp.log.debug("playlist page", { begin, received, items: items.length, songnum: info.songnum });
  return {
    playlist,
    items,
    cursor: more ? `v1:${next}` : null,
    // 歌單標頭的筆數；跳過的歌（缺 mid）或伺服器沒給齊會讓回傳筆數少於它，宿主就不套用移除。
    total: info.songnum
  };
}
export {
  importPlaylist,
  playlistFromUrl
};
