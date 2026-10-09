// YouTube 網頁端的 SAPISIDHASH 認證 header（舊版 lib/services/account/youtube_credentials.dart:94-102
// 的算法：SHA1("{秒} {SAPISID} https://www.youtube.com")）。
// 宿主的 fmp.crypto 只有 md5／sha256，所以 SHA-1 自己實作；純 JS，不依賴 TextEncoder。
// 算出來的值是憑證的衍生物：不寫 log、不存 storage。

export const ORIGIN = 'https://www.youtube.com';

function utf8Bytes(text) {
  const out = [];
  for (let i = 0; i < text.length; i++) {
    let c = text.charCodeAt(i);
    if (c >= 0xd800 && c < 0xdc00 && i + 1 < text.length) {
      const d = text.charCodeAt(i + 1);
      if (d >= 0xdc00 && d < 0xe000) {
        c = 0x10000 + ((c - 0xd800) << 10) + (d - 0xdc00);
        i++;
      }
    }
    if (c < 0x80) out.push(c);
    else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 63));
    else if (c < 0x10000) out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
    else out.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 63), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
  }
  return out;
}

const rotl = (x, n) => (x << n) | (x >>> (32 - n));

/** 字串的 UTF-8 位元組的 SHA-1，小寫 hex。 */
export function sha1Hex(text) {
  const bytes = utf8Bytes(text);
  const bitLength = bytes.length * 8;
  bytes.push(0x80);
  while (bytes.length % 64 !== 56) bytes.push(0);
  // 長度（bit）以 64 位元大端存；上 32 位元在這裡的輸入大小下永遠是 0，仍照式子寫。
  const high = Math.floor(bitLength / 0x100000000);
  const low = bitLength >>> 0;
  for (const word of [high, low]) bytes.push((word >>> 24) & 255, (word >>> 16) & 255, (word >>> 8) & 255, word & 255);

  let h0 = 0x67452301, h1 = 0xefcdab89 | 0, h2 = 0x98badcfe | 0, h3 = 0x10325476, h4 = 0xc3d2e1f0 | 0;
  const w = new Array(80);
  for (let off = 0; off < bytes.length; off += 64) {
    for (let i = 0; i < 16; i++) {
      const j = off + i * 4;
      w[i] = (bytes[j] << 24) | (bytes[j + 1] << 16) | (bytes[j + 2] << 8) | bytes[j + 3];
    }
    for (let i = 16; i < 80; i++) w[i] = rotl(w[i - 3] ^ w[i - 8] ^ w[i - 14] ^ w[i - 16], 1);
    let a = h0, b = h1, c = h2, d = h3, e = h4;
    for (let i = 0; i < 80; i++) {
      let f, k;
      if (i < 20) { f = (b & c) | (~b & d); k = 0x5a827999; }
      else if (i < 40) { f = b ^ c ^ d; k = 0x6ed9eba1; }
      else if (i < 60) { f = (b & c) | (b & d) | (c & d); k = 0x8f1bbcdc | 0; }
      else { f = b ^ c ^ d; k = 0xca62c1d6 | 0; }
      const t = (rotl(a, 5) + f + e + k + w[i]) | 0;
      e = d; d = c; c = rotl(b, 30); b = a; a = t;
    }
    h0 = (h0 + a) | 0; h1 = (h1 + b) | 0; h2 = (h2 + c) | 0; h3 = (h3 + d) | 0; h4 = (h4 + e) | 0;
  }
  return [h0, h1, h2, h3, h4].map((h) => (h >>> 0).toString(16).padStart(8, '0')).join('');
}

/** `SAPISIDHASH {秒}_{sha1}`；nowMs 是 epoch 毫秒。 */
export function sapisidHash(sapisid, nowMs) {
  const seconds = Math.floor(nowMs / 1000);
  return `SAPISIDHASH ${seconds}_${sha1Hex(`${seconds} ${sapisid} ${ORIGIN}`)}`;
}

/** 請求的 authHeaders（宿主只在判定要帶憑證時才送）；沒有 SAPISID 時是 null。 */
export function authHeadersFor(credentials, nowMs) {
  const sapisid = credentials && credentials.cookies && credentials.cookies.SAPISID;
  if (!sapisid) return null;
  return { Authorization: sapisidHash(sapisid, nowMs), 'X-Origin': ORIGIN };
}
