// QQ 音樂 musics.fcg 的 `sign` 參數。規格是舊專案 qq_music_sign.dart：
// zzb + 摘要十六進位字串的 8 個字元 + 摘要逐位元組 XOR 金鑰後的 base64（濾掉 + / =）+ 另外 8 個字元，全小寫。
// MD5 由宿主給（fmp.crypto.md5，小寫 hex），這裡不自己算。

const XOR_KEY = [212, 45, 80, 68, 195, 163, 163, 203, 157, 220, 254, 91, 204, 79, 104, 6];
const HEAD_INDICES = [21, 4, 9, 26, 16, 20, 27, 30];
const TAIL_INDICES = [18, 11, 3, 2, 1, 7, 6, 25];
const BASE64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/** 標準 base64（含補位符）。QuickJS 沒有 btoa。 */
export function base64(bytes) {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const n = (bytes[i] << 16) | ((bytes[i + 1] || 0) << 8) | (bytes[i + 2] || 0);
    out += BASE64[(n >> 18) & 63] + BASE64[(n >> 12) & 63];
    out += i + 1 < bytes.length ? BASE64[(n >> 6) & 63] : '=';
    out += i + 2 < bytes.length ? BASE64[n & 63] : '=';
  }
  return out;
}

/** [text] 的簽名；[md5] 回 UTF-8 位元組的小寫 hex（32 字元）。 */
export function signOf(text, md5) {
  const hex = md5(text);
  const pick = (indices) => indices.map((i) => hex[i]).join('');
  const scrambled = XOR_KEY.map((key, i) => parseInt(hex.slice(i * 2, i * 2 + 2), 16) ^ key);
  const middle = base64(scrambled).replace(/[+/=]/g, '');
  return `zzb${pick(HEAD_INDICES)}${middle}${pick(TAIL_INDICES)}`.toLowerCase();
}
