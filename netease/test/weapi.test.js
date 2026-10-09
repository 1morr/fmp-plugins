// weapi 加密以 node:crypto 獨立驗證：AES-CBC 用 createCipheriv，RSA 用 publicEncrypt
// （RSA_NO_PADDING，公鑰由寫死的模數與指數組成），base64 用 Buffer。向量是這裡現算的，
// 不是從網路上抄來的。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { constants, createCipheriv, createDecipheriv, createPublicKey, publicEncrypt } from 'node:crypto';

import { aes128CbcEncrypt, base64Encode } from '../src/aes.js';
import { RSA_MODULUS, modPow, randomSecret, rsaEncryptSecret, weapiEncrypt } from '../src/weapi.js';

const PRESET_KEY = '0CoJUm6Qyw8W8jud';
const IV = '0102030405060708';

function nodeCbc(key, text) {
  const cipher = createCipheriv('aes-128-cbc', Buffer.from(key), Buffer.from(IV));
  return Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]).toString('base64');
}

function nodeRsa(secret) {
  const reversed = [...secret].reverse().join('');
  const n = RSA_MODULUS.toString(16).padStart(256, '0');
  const publicKey = createPublicKey({
    key: { kty: 'RSA', n: Buffer.from(n, 'hex').toString('base64url'), e: 'AQAB' },
    format: 'jwk',
  });
  const padded = Buffer.concat([Buffer.alloc(128 - reversed.length), Buffer.from(reversed)]);
  return publicEncrypt({ key: publicKey, padding: constants.RSA_NO_PADDING }, padded).toString('hex');
}

test('aes128CbcEncrypt matches node:crypto for many lengths', () => {
  for (let len = 0; len <= 70; len++) {
    const text = 'x'.repeat(len);
    const ours = base64Encode(
      aes128CbcEncrypt(Buffer.from(PRESET_KEY), Buffer.from(IV), Buffer.from(text)),
    );
    assert.equal(ours, nodeCbc(PRESET_KEY, text), `len ${len}`);
  }
});

test('NIST SP 800-38A F.2.1 CBC-AES128 first block', () => {
  const key = Buffer.from('2b7e151628aed2a6abf7158809cf4f3c', 'hex');
  const iv = Buffer.from('000102030405060708090a0b0c0d0e0f', 'hex');
  const plain = Buffer.from('6bc1bee22e409f96e93d7e117393172a', 'hex');
  const out = aes128CbcEncrypt(key, iv, plain);
  assert.equal(Buffer.from(out.subarray(0, 16)).toString('hex'), '7649abac8119b246cee98e9b12e9197d');
});

test('base64Encode matches Buffer for every remainder length', () => {
  for (let len = 0; len <= 40; len++) {
    const bytes = Uint8Array.from({ length: len }, (_, i) => (i * 37 + 11) & 0xff);
    assert.equal(base64Encode(bytes), Buffer.from(bytes).toString('base64'), `len ${len}`);
  }
});

test('modPow matches a small known value and Fermat', () => {
  assert.equal(modPow(BigInt(4), 13, BigInt(497)), BigInt(445)); // 教科書例：4^13 mod 497
  assert.equal(modPow(BigInt(3), 100, BigInt(101)), BigInt(1));
});

test('rsaEncryptSecret matches node:crypto RSA_NO_PADDING', () => {
  for (const secret of ['abcdefghijklmnop', 'ABCDEFGHIJKLMNOP', '0123456789abcdef', 'aZ09aZ09aZ09aZ09']) {
    const out = rsaEncryptSecret(secret);
    assert.equal(out.length, 256);
    assert.equal(out, nodeRsa(secret), secret);
  }
});

test('weapiEncrypt with a fixed secret equals the node:crypto composition', () => {
  const data = { type: 1, key: 'fake-unikey-0000' };
  const secret = 'aZ09aZ09aZ09aZ09';
  const { params, encSecKey } = weapiEncrypt(data, secret);
  const layer1 = nodeCbc(PRESET_KEY, JSON.stringify(data));
  assert.equal(params, nodeCbc(secret, layer1));
  assert.equal(encSecKey, nodeRsa(secret));
});

test('weapiEncrypt output decrypts back to the JSON with the secret', () => {
  const data = { type: 1, text: '中文 😀' };
  const secret = randomSecret();
  const { params } = weapiEncrypt(data, secret);
  const decrypt = (key, b64) => {
    const d = createDecipheriv('aes-128-cbc', Buffer.from(key), Buffer.from(IV));
    return Buffer.concat([d.update(Buffer.from(b64, 'base64')), d.final()]).toString('utf8');
  };
  assert.deepEqual(JSON.parse(decrypt(PRESET_KEY, decrypt(secret, params))), data);
});

test('randomSecret is 16 base62 characters and differs between calls', () => {
  const a = randomSecret();
  const b = randomSecret();
  assert.match(a, /^[a-zA-Z0-9]{16}$/);
  assert.notEqual(a, b);
  assert.equal(randomSecret(() => 0), 'a'.repeat(16));
  assert.equal(randomSecret(() => 0.999999), '9'.repeat(16));
});

test('every weapiEncrypt call uses a fresh secret', () => {
  const data = { type: 1 };
  assert.notEqual(weapiEncrypt(data).encSecKey, weapiEncrypt(data).encSecKey);
});
