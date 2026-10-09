// RSA-OAEP（SHA-256）以 node:crypto 獨立驗證：測試自己生一組金鑰，用我們的純 JS 加密，
// 再由 node 的 privateDecrypt（oaepHash: sha256）解回來。SHA-256 對照 createHash。
// 另守打包檔 bilibili.js 不使用 FMP 的 QuickJS 沒有的 API。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { constants, createHash, createPublicKey, generateKeyPairSync, privateDecrypt, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';

import { RSA_EXPONENT, RSA_MODULUS_HEX, correspondPath, mgf1, rsaOaepEncrypt, sha256 } from '../src/oaep.js';

const hex = (bytes) => Buffer.from(bytes).toString('hex');

test('sha256 matches node:crypto around the padding boundaries', () => {
  for (const length of [0, 1, 3, 55, 56, 57, 63, 64, 65, 119, 120, 127, 128, 129, 1000]) {
    const data = randomBytes(length);
    assert.equal(hex(sha256(data)), createHash('sha256').update(data).digest('hex'), `length ${length}`);
  }
  // 位元組 >= 0x80（宿主的 sha256 吃不了的輸入）。
  const high = Uint8Array.from({ length: 64 }, (_, i) => 0x80 + (i % 128));
  assert.equal(hex(sha256(high)), createHash('sha256').update(high).digest('hex'));
});

test('mgf1 matches the RFC 8017 definition computed with node:crypto', () => {
  const seed = randomBytes(32);
  for (const length of [1, 31, 32, 33, 95, 100]) {
    let expected = Buffer.alloc(0);
    for (let counter = 0; expected.length < length; counter++) {
      const c = Buffer.alloc(4);
      c.writeUInt32BE(counter);
      expected = Buffer.concat([expected, createHash('sha256').update(Buffer.concat([seed, c])).digest()]);
    }
    assert.equal(hex(mgf1(seed, length)), expected.subarray(0, length).toString('hex'), `length ${length}`);
  }
});

function testKey(bits = 1024) {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: bits });
  const jwk = publicKey.export({ format: 'jwk' });
  return { privateKey, modulusHex: Buffer.from(jwk.n, 'base64url').toString('hex'), exponent: 65537 };
}

function decrypt(privateKey, cipherHex) {
  return privateDecrypt(
    { key: privateKey, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' },
    Buffer.from(cipherHex, 'hex'),
  );
}

test('rsaOaepEncrypt is decryptable by node:crypto for message lengths 0 to the maximum', () => {
  const { privateKey, modulusHex, exponent } = testKey(1024);
  const max = 128 - 2 * 32 - 2; // k - 2hLen - 2
  for (const length of [0, 1, 20, 21, max - 1, max]) {
    const message = randomBytes(length);
    const cipher = rsaOaepEncrypt(message, modulusHex, exponent);
    assert.equal(cipher.length, 256);
    assert.match(cipher, /^[0-9a-f]+$/);
    assert.deepEqual(decrypt(privateKey, cipher), message, `length ${length}`);
  }
  assert.throws(() => rsaOaepEncrypt(randomBytes(max + 1), modulusHex, exponent));
});

test('rsaOaepEncrypt works with a larger key and byte-high messages', () => {
  const { privateKey, modulusHex, exponent } = testKey(2048);
  const message = Uint8Array.from({ length: 40 }, (_, i) => 0xff - i);
  const cipher = rsaOaepEncrypt(message, modulusHex, exponent);
  assert.equal(cipher.length, 512);
  assert.deepEqual(decrypt(privateKey, cipher), Buffer.from(message));
});

test('every encryption uses a fresh seed, and a fixed seed is deterministic', () => {
  const { modulusHex, exponent } = testKey(1024);
  const message = Buffer.from('refresh_1');
  assert.notEqual(rsaOaepEncrypt(message, modulusHex, exponent), rsaOaepEncrypt(message, modulusHex, exponent));
  const seed = randomBytes(32);
  assert.equal(
    rsaOaepEncrypt(message, modulusHex, exponent, seed),
    rsaOaepEncrypt(message, modulusHex, exponent, seed),
  );
  assert.throws(() => rsaOaepEncrypt(message, modulusHex, exponent, randomBytes(31)));
});

// 舊專案 lib/services/account/bilibili_crypto.dart 的 SubjectPublicKeyInfo（公開常量）。
const LEGACY_SPKI =
  'MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQDLgd2OAkcGVtoE3ThUREbio0Eg' +
  'Uc/prcajMKXvkCKFCWhJYJcLkcM2DKKcSeFpD/j6Boy538YXnR6VhcuUJOhH2x71' +
  'nzPjfdTcqMz7djHum0qSZA0AyCBDABUqCrfNgCiJ00Ra7GmRj+YCK1NJEuewlb40' +
  'JNrRuoEUXpabUzGB8QIDAQAB';

test('the hard-coded modulus and exponent are the legacy public key', () => {
  const jwk = createPublicKey({ key: Buffer.from(LEGACY_SPKI, 'base64'), format: 'der', type: 'spki' }).export({
    format: 'jwk',
  });
  assert.equal(Buffer.from(jwk.n, 'base64url').toString('hex'), RSA_MODULUS_HEX);
  assert.equal(Buffer.from(jwk.e, 'base64url').readUIntBE(0, 3), RSA_EXPONENT);
});

test('correspondPath is 256 lowercase hex characters and differs per call', () => {
  assert.match(correspondPath(1700000000000), /^[0-9a-f]{256}$/);
  assert.notEqual(correspondPath(1700000000000), correspondPath(1700000000000));
});

// FMP 的 QuickJS（flutter_js 0.8.7）沒有 BigInt、TextEncoder、WebCrypto、getRandomValues。
test('the bundled bilibili.js uses no API the QuickJS runtime lacks', () => {
  const bundle = readFileSync(new URL('../bilibili.js', import.meta.url), 'utf8');
  for (const token of ['BigInt', 'TextEncoder', 'TextDecoder', 'crypto.subtle', 'getRandomValues', 'atob', 'btoa']) {
    assert.ok(!bundle.includes(token), `${token} appears in bilibili.js`);
  }
  assert.ok(!/\b\d+n\b/.test(bundle), 'a BigInt literal appears in bilibili.js');
});

test('the bundled bilibili.js loads and builds a correspondPath without BigInt', async () => {
  const realBigInt = globalThis.BigInt;
  const requests = [];
  globalThis.fmp = {
    log: { debug() {}, info() {}, warn() {} },
    http: {
      async request(req) {
        requests.push(req);
        const body = req.url.includes('/correspond/')
          ? '<div id="1-name">fake-refresh-csrf-0000</div>'
          : req.url.includes('cookie/info')
            ? JSON.stringify({ code: 0, data: { refresh: true, timestamp: 1700000000000 } })
            : JSON.stringify({ code: -111, message: 'fake' });
        return { status: 200, headers: {}, body };
      },
    },
  };
  globalThis.BigInt = undefined; // 模擬沒有 BigInt 的執行環境
  try {
    const plugin = await import(`../bilibili.js?nobigint=${Date.now()}`);
    await assert.rejects(
      plugin.loginRefresh({
        cookies: { SESSDATA: 'fake-sessdata-0000', bili_jct: 'fake-jct-0000', DedeUserID: '1000001' },
        extra: { refresh_token: 'fake-refresh-0000' },
      }),
      (e) => e.fmpError === 'CredentialInvalid',
    );
    const page = requests.find((r) => r.url.includes('/correspond/1/'));
    assert.match(page.url, /^https:\/\/www\.bilibili\.com\/correspond\/1\/[0-9a-f]{256}$/);
  } finally {
    globalThis.BigInt = realBigInt;
  }
});
