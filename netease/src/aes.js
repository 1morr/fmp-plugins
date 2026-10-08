// AES-128-ECB（PKCS7）加密。宿主 API 只有 md5／sha256，沒有 AES，所以自己寫。
// 只做加密：eapi 的 params 要的就是這個。S-box 與 Rcon 依 FIPS 197 的定義算出來，不貼表。
// 測試（test/aes.test.js）與 node:crypto 的 aes-128-ecb 逐位元組比對。

const SBOX = new Uint8Array(256);
{
  // GF(2^8) 的乘法反元素 + 仿射變換。p、q 走遍 3 與其反元素（FIPS 197 §5.1.1 的標準產生法）。
  let p = 1;
  let q = 1;
  do {
    p = p ^ ((p << 1) & 0xff) ^ (p & 0x80 ? 0x1b : 0);
    q ^= q << 1;
    q ^= q << 2;
    q ^= q << 4;
    q &= 0xff;
    if (q & 0x80) q ^= 0x09;
    const rot = (x, n) => ((x << n) | (x >> (8 - n))) & 0xff;
    SBOX[p] = q ^ rot(q, 1) ^ rot(q, 2) ^ rot(q, 3) ^ rot(q, 4) ^ 0x63;
  } while (p !== 1);
  SBOX[0] = 0x63;
}

function xtime(x) {
  return ((x << 1) ^ (x & 0x80 ? 0x1b : 0)) & 0xff;
}

/** 16 位元組金鑰 → 11 組 round key（176 位元組）。 */
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
    // SubBytes + ShiftRows（狀態是 column-major）
    const t = new Uint8Array(16);
    for (let c = 0; c < 4; c++) {
      for (let r = 0; r < 4; r++) t[c * 4 + r] = SBOX[s[((c + r) % 4) * 4 + r]];
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

/** UTF-8 字串 → 位元組（QuickJS 沒有 TextEncoder）。 */
export function utf8Bytes(text) {
  const bytes = [];
  for (const ch of text) {
    let cp = ch.codePointAt(0);
    if (cp < 0x80) bytes.push(cp);
    else if (cp < 0x800) bytes.push(0xc0 | (cp >> 6), 0x80 | (cp & 0x3f));
    else if (cp < 0x10000) {
      bytes.push(0xe0 | (cp >> 12), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f));
    } else {
      bytes.push(
        0xf0 | (cp >> 18),
        0x80 | ((cp >> 12) & 0x3f),
        0x80 | ((cp >> 6) & 0x3f),
        0x80 | (cp & 0x3f),
      );
    }
  }
  return Uint8Array.from(bytes);
}

/** AES-128-ECB + PKCS7，回傳密文位元組。key 是 16 位元組。 */
export function aes128EcbEncrypt(key, data) {
  if (key.length !== 16) throw new Error('AES-128 key must be 16 bytes');
  const rk = expandKey(key);
  const pad = 16 - (data.length % 16);
  const padded = new Uint8Array(data.length + pad);
  padded.set(data);
  padded.fill(pad, data.length);
  const out = new Uint8Array(padded.length);
  for (let i = 0; i < padded.length; i += 16) {
    out.set(encryptBlock(rk, padded.subarray(i, i + 16)), i);
  }
  return out;
}

/** 位元組 → 大寫 hex。 */
export function hexUpper(bytes) {
  let out = '';
  for (const b of bytes) out += (b < 16 ? '0' : '') + b.toString(16);
  return out.toUpperCase();
}
