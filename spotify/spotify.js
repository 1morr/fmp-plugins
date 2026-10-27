/* ==FMP Plugin==
{
  "id": "spotify",
  "name": "Spotify",
  "version": "1.0.1",
  "author": "FMP",
  "description": "匯入 Spotify 公開歌單的曲目清單（不需登入）；Spotify 的曲目不能直接播放，只用來到其他音源匹配。",
  "icon": "data:image/png;base64,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",
  "apiVersion": 1,
  "capabilities": [
    "importPlaylist"
  ],
  "allowedHosts": [
    "open.spotify.com",
    "spotify.link",
    "scdn.co"
  ],
  "rateLimit": {
    "maxConcurrentRequests": 1,
    "minRequestIntervalMs": 500
  }
}
==/FMP Plugin== */
// src/plugin.js
var EMBED = "https://open.spotify.com/embed/playlist";
var USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
var SPOTIFY_HOSTS = ["open.spotify.com"];
var SHORT_HOSTS = ["spotify.link"];
var PLAYLIST_ID = /^[A-Za-z0-9]{1,64}$/;
var EMBED_TRACK_LIMIT = 100;
var ARTWORK_DOMAINS = ["scdn.co"];
var ARTIST_SEPARATOR = /,\u00A0+/;
function error(fmpError, message, extra) {
  return { fmpError, message, ...extra };
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
  if (parts === null || !SPOTIFY_HOSTS.includes(parts.host)) return null;
  const segments = parts.path.split("/").filter((s) => s !== "");
  if (segments.length > 0 && /^intl-[a-z]{2,3}(?:-[a-z0-9]+)?$/i.test(segments[0])) segments.shift();
  if (segments.length < 2 || segments[0] !== "playlist") return null;
  return PLAYLIST_ID.test(segments[1]) ? segments[1] : null;
}
function statusError(status, context) {
  const detail = `${context}: HTTP ${status}`;
  if (status === 404) return error("NotFound", detail);
  if (status >= 500) return error("NetworkError", detail);
  return error("UnexpectedError", detail);
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
    headers: { "User-Agent": USER_AGENT, Accept: "text/html,*/*" },
    auth: "never"
  });
  if (response.status !== 200) throw statusError(response.status, "short url");
  const playlistId = playlistIdOfUrl(typeof response.url === "string" ? splitUrl(response.url) : null);
  return playlistId === null ? null : { playlistId };
}
function nextDataOf(html) {
  const match = /<script\s+id="__NEXT_DATA__"\s+type="application\/json">([\s\S]*?)<\/script>/.exec(html);
  if (match === null) return null;
  try {
    const json = JSON.parse(match[1]);
    return json !== null && typeof json === "object" ? json : null;
  } catch (e) {
    return null;
  }
}
function dig(value, path) {
  let current = value;
  for (const key of path) {
    if (current === null || typeof current !== "object") return void 0;
    current = current[key];
  }
  return current;
}
function nonEmptyString(value) {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}
function artworkOf(coverArt) {
  const sources = dig(coverArt, ["sources"]);
  if (!Array.isArray(sources)) return [];
  const result = [];
  for (const source of sources) {
    const url = source !== null && typeof source === "object" ? source.url : null;
    const host = typeof url === "string" ? /^https:\/\/([^/?#:]+)(?::\d+)?(?:[/?#]|$)/i.exec(url) : null;
    if (host === null) continue;
    const h = host[1].toLowerCase();
    if (!ARTWORK_DOMAINS.some((d) => h === d || h.endsWith(`.${d}`))) continue;
    const entry = { url };
    if (Number.isInteger(source.width) && source.width > 0) entry.width = source.width;
    result.push(entry);
  }
  return result;
}
function trackOfItem(item) {
  if (item === null || typeof item !== "object") return null;
  const id = typeof item.uri === "string" ? /^spotify:track:([A-Za-z0-9]+)$/.exec(item.uri) : null;
  const title = nonEmptyString(item.title);
  if (id === null || title === null) return null;
  const artists = typeof item.subtitle === "string" ? item.subtitle.split(ARTIST_SEPARATOR).map((a) => a.trim()).filter((a) => a !== "") : [];
  const track = { sourceId: id[1], title };
  if (artists.length > 0) track.uploader = artists.join(" / ");
  if (Number.isFinite(item.duration) && item.duration >= 0) track.durationMs = Math.trunc(item.duration);
  return track;
}
async function importPlaylist(input) {
  const { playlistId, cursor } = input || {};
  if (typeof playlistId !== "string" || !PLAYLIST_ID.test(playlistId)) {
    throw error("ParseError", `playlist: invalid playlistId: ${playlistId}`);
  }
  if (cursor !== void 0 && cursor !== null) {
    throw error("ParseError", "playlist: malformed cursor");
  }
  const response = await fmp.http.request({
    url: `${EMBED}/${playlistId}`,
    method: "GET",
    headers: { "User-Agent": USER_AGENT, "Accept-Language": "en", Accept: "text/html,*/*" },
    auth: "never",
    idempotent: true
  });
  if (response.status !== 200) throw statusError(response.status, "playlist embed");
  const data = nextDataOf(typeof response.body === "string" ? response.body : "");
  if (data === null) throw error("ParseError", "playlist embed: no __NEXT_DATA__");
  if (dig(data, ["props", "pageProps", "status"]) === 404) throw error("NotFound", "playlist embed: page not found");
  const entity = dig(data, ["props", "pageProps", "state", "data", "entity"]);
  if (entity === null || typeof entity !== "object") throw error("ParseError", "playlist embed: no entity");
  const title = nonEmptyString(entity.name) ?? nonEmptyString(entity.title);
  if (title === null) throw error("ParseError", "playlist embed: no name");
  if (!Array.isArray(entity.trackList)) throw error("ParseError", "playlist embed: no trackList");
  const playlist = { title };
  const owner = nonEmptyString(entity.subtitle);
  if (owner !== null) playlist.ownerName = owner;
  const attributes = Array.isArray(entity.attributes) ? entity.attributes : [];
  const description = attributes.find((a) => a !== null && typeof a === "object" && a.key === "episode_description");
  if (description && nonEmptyString(description.value) !== null) playlist.description = description.value.trim();
  const cover = artworkOf(entity.coverArt);
  if (cover.length > 0) playlist.artwork = cover;
  const items = [];
  for (const item of entity.trackList) {
    const track = trackOfItem(item);
    if (track !== null) items.push({ track });
  }
  const truncated = entity.trackList.length >= EMBED_TRACK_LIMIT;
  fmp.log.debug("playlist embed", { raw: entity.trackList.length, items: items.length, truncated });
  return truncated ? { playlist, items, cursor: null, truncated: true } : { playlist, items, cursor: null };
}
export {
  importPlaylist,
  playlistFromUrl
};
