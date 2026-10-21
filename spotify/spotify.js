/* ==FMP Plugin==
{
  "id": "spotify",
  "name": "Spotify",
  "version": "1.0.0",
  "author": "FMP",
  "description": "匯入 Spotify 公開歌單的曲目清單（不需登入）；Spotify 的曲目不能直接播放，只用來到其他音源匹配。",
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
