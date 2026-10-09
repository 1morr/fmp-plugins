// RSA-OAEP（SHA-256，label 為空）加密，給 B 站 cookie 刷新的 correspondPath 用。規格是 FMP 舊專案
// lib/services/account/bilibili_crypto.dart（pointycastle 的 OAEPEncoding.withSHA256）；
// test/oaep.test.js 以 node:crypto 的 privateDecrypt 獨立驗證。
//
// FMP 的 QuickJS 沒有 BigInt、TextEncoder、WebCrypto，宿主的 sha256 又只吃字串（UTF-8），
// 不能對任意位元組雜湊，所以 SHA-256、MGF1、OAEP 都是純 JS；大整數運算用 bn.js（MIT）。
import BN from 'bn.js';

// 舊專案寫死的 1024-bit 公鑰（SubjectPublicKeyInfo 的模數與指數；test 核對它與舊專案的
// base64 DER 相同）。這是 B 站網頁端自己出貨的公開常量，不是機密。
export const RSA_MODULUS_HEX =
  'cb81dd8e02470656da04dd38544446e2a3412051cfe9adc6a330a5ef90228509' +
  '684960970b91c3360ca29c49e1690ff8fa068cb9dfc6179d1e9585cb9424e847' +
  'db1ef59f33e37dd4dca8ccfb7631ee9b4a92640d00c8204300152a0ab7cd8028' +
  '89d3445aec69918fe6022b534912e7b095be3424dad1ba81145e969b533181f1';
export const RSA_EXPONENT = 65537;

const H_LEN = 32;

// ---------------------------------------------------------------- SHA-256

const K = Uint32Array.from([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

function rotr(x, n) {
  return (x >>> n) | (x << (32 - n));
}

/** 位元組的 SHA-256，回傳 32 位元組。 */
export function sha256(data) {
  const h = Uint32Array.from([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ]);
  // 補 0x80、補零到 56 mod 64、再接 64-bit 的位元長度（高 32 位用除法取，不用 BigInt）。
  const paddedLength = (((data.length + 8) >> 6) + 1) << 6;
  const padded = new Uint8Array(paddedLength);
  padded.set(data);
  padded[data.length] = 0x80;
  const bitsHigh = Math.floor(data.length / 0x20000000);
  const bitsLow = (data.length << 3) >>> 0;
  const view = new DataView(padded.buffer);
  view.setUint32(paddedLength - 8, bitsHigh);
  view.setUint32(paddedLength - 4, bitsLow);

  const w = new Uint32Array(64);
  for (let offset = 0; offset < paddedLength; offset += 64) {
    for (let i = 0; i < 16; i++) w[i] = view.getUint32(offset + i * 4);
    for (let i = 16; i < 64; i++) {
      const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
      const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) | 0;
    }
    let [a, b, c, d, e, f, g, hh] = h;
    for (let i = 0; i < 64; i++) {
      const s1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const t1 = (hh + s1 + ch + K[i] + w[i]) | 0;
      const s0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (s0 + maj) | 0;
      hh = g;
      g = f;
      f = e;
      e = (d + t1) | 0;
      d = c;
      c = b;
      b = a;
      a = (t1 + t2) | 0;
    }
    h[0] += a;
    h[1] += b;
    h[2] += c;
    h[3] += d;
    h[4] += e;
    h[5] += f;
    h[6] += g;
    h[7] += hh;
  }
  const out = new Uint8Array(32);
  const outView = new DataView(out.buffer);
  for (let i = 0; i < 8; i++) outView.setUint32(i * 4, h[i]);
  return out;
}

// ---------------------------------------------------------------- MGF1 與 OAEP

/** MGF1（RFC 8017 附錄 B.2.1，SHA-256）：seed 展開成 length 位元組。 */
export function mgf1(seed, length) {
  const out = new Uint8Array(Math.ceil(length / H_LEN) * H_LEN);
  const input = new Uint8Array(seed.length + 4);
  input.set(seed);
  for (let counter = 0; counter * H_LEN < length; counter++) {
    input[seed.length] = (counter >>> 24) & 0xff;
    input[seed.length + 1] = (counter >>> 16) & 0xff;
    input[seed.length + 2] = (counter >>> 8) & 0xff;
    input[seed.length + 3] = counter & 0xff;
    out.set(sha256(input), counter * H_LEN);
  }
  return out.subarray(0, length);
}

/**
 * OAEP 的種子。OAEP 要隨機種子只為了讓同一個明文每次的密文不同；這裡的明文是
 * `refresh_<時間戳>`，不是機密，而 QuickJS 沒有 crypto.getRandomValues，所以用 Math.random。
 * [random] 給測試換掉。
 */
export function randomSeed(random = Math.random) {
  const seed = new Uint8Array(H_LEN);
  for (let i = 0; i < H_LEN; i++) seed[i] = Math.floor(random() * 256);
  return seed;
}

function hex(bytes) {
  let out = '';
  for (const b of bytes) out += (b < 16 ? '0' : '') + b.toString(16);
  return out;
}

/**
 * RSA-OAEP（SHA-256、空 label）加密 [message]（位元組），回傳小寫 hex（長度 = 模數位元組數 × 2）。
 * [modulusHex]、[exponent] 預設是舊專案的公鑰；[seed] 預設隨機，測試可固定。
 */
export function rsaOaepEncrypt(message, modulusHex = RSA_MODULUS_HEX, exponent = RSA_EXPONENT, seed = randomSeed()) {
  const n = new BN(modulusHex, 16);
  const k = Math.ceil(n.bitLength() / 8);
  if (message.length > k - 2 * H_LEN - 2) throw new Error('message too long for RSA-OAEP');
  if (seed.length !== H_LEN) throw new Error('OAEP seed must be 32 bytes');

  // DB = lHash || PS(零) || 0x01 || M
  const db = new Uint8Array(k - H_LEN - 1);
  db.set(sha256(new Uint8Array(0)));
  db[db.length - message.length - 1] = 0x01;
  db.set(message, db.length - message.length);

  const dbMask = mgf1(seed, db.length);
  const maskedDb = db.map((b, i) => b ^ dbMask[i]);
  const seedMask = mgf1(maskedDb, H_LEN);
  const maskedSeed = seed.map((b, i) => b ^ seedMask[i]);

  // EM = 0x00 || maskedSeed || maskedDB，c = EM^e mod n。
  const em = new Uint8Array(k);
  em.set(maskedSeed, 1);
  em.set(maskedDb, 1 + H_LEN);
  const red = BN.red(n);
  const c = new BN(hex(em), 16).toRed(red).redPow(new BN(exponent)).fromRed();
  return c.toString(16).padStart(k * 2, '0');
}

/** ASCII 字串 → 位元組；非 ASCII 就拋（這裡只加密 `refresh_<數字>`）。 */
export function asciiBytes(text) {
  const out = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code > 0x7f) throw new Error('not ASCII');
    out[i] = code;
  }
  return out;
}

/** `refresh_<timestamp>` 的 RSA-OAEP 密文（小寫 hex），接在 `/correspond/1/` 後面（舊專案 generateCorrespondPath）。 */
export function correspondPath(timestamp, seed) {
  return rsaOaepEncrypt(
    asciiBytes(`refresh_${timestamp}`),
    RSA_MODULUS_HEX,
    RSA_EXPONENT,
    seed,
  );
}
