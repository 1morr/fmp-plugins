// weapi：music.163.com 網頁端的請求加密。雙層 AES-128-CBC（第一層固定金鑰、第二層隨機
// 金鑰）加 RSA 封裝隨機金鑰。金鑰、IV 與 RSA 公鑰是 music.163.com 自己出貨的 core.js 裡的
// 公開常量；實作是自己寫的（FMP 舊專案 lib/core/utils/netease_crypto.dart 為規格，
// test/weapi.test.js 以 node:crypto 獨立驗證）。

import { aes128CbcEncrypt, base64Encode, utf8Bytes } from './aes.js';

const PRESET_KEY = '0CoJUm6Qyw8W8jud';
const IV = '0102030405060708';
const BASE62 = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
const RSA_MODULUS_HEX =
  '00e0b509f6259df8642dbc35662901477df22677ec152b5ff68ace615bb7b725' +
  '152b3ab17a876aea8a5aa76d2e417629ec4ee341f56135fccf695280104e0312' +
  'ecbda92557c93870114af6c9d05c4f7f0c3685b7a46bee255932575cce10b424' +
  'd813cfe4875d3e82047b97ddef52741d546b8e289dc6935b3ece0462db0a22b8e7';
const RSA_EXPONENT = 65537;

export const RSA_MODULUS = BigInt(`0x${RSA_MODULUS_HEX}`);

/**
 * 隨機 16 字元 base62 金鑰。這把金鑰只保護一個公開 QR 流程的請求內容，不是憑證，
 * 所以用 Math.random（QuickJS 沒有 crypto.getRandomValues）。[random] 給測試換掉。
 */
export function randomSecret(random = Math.random) {
  let out = '';
  for (let i = 0; i < 16; i++) out += BASE62[Math.floor(random() * BASE62.length)];
  return out;
}

/** a^e mod n，平方相乘。 */
export function modPow(base, exponent, modulus) {
  let result = BigInt(1);
  let b = base % modulus;
  let e = BigInt(exponent);
  const zero = BigInt(0);
  const one = BigInt(1);
  while (e > zero) {
    if ((e & one) === one) result = (result * b) % modulus;
    b = (b * b) % modulus;
    e >>= one;
  }
  return result;
}

/** 無 padding 的 RSA：反轉後的金鑰字串（UTF-8 位元組）當大整數，輸出 hex 左補零到 256 字元。 */
export function rsaEncryptSecret(secret) {
  const reversed = [...secret].reverse().join('');
  let hex = '';
  for (const b of utf8Bytes(reversed)) hex += (b < 16 ? '0' : '') + b.toString(16);
  const output = modPow(BigInt(`0x${hex}`), RSA_EXPONENT, RSA_MODULUS);
  return output.toString(16).padStart(256, '0');
}

function aesBase64(text, key) {
  return base64Encode(aes128CbcEncrypt(utf8Bytes(key), utf8Bytes(IV), utf8Bytes(text)));
}

/** `{params, encSecKey}`，用作 POST form body。每次呼叫都用新的隨機金鑰。 */
export function weapiEncrypt(data, secret = randomSecret()) {
  const layer1 = aesBase64(JSON.stringify(data), PRESET_KEY);
  return { params: aesBase64(layer1, secret), encSecKey: rsaEncryptSecret(secret) };
}
