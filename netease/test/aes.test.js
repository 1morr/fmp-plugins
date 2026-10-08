// AES 實作與 node:crypto 逐位元組比對，加上 eapi 的已知輸出結構。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCipheriv, randomBytes } from 'node:crypto';

import { aes128EcbEncrypt, utf8Bytes, hexUpper } from '../src/aes.js';

test('matches node:crypto aes-128-ecb for many lengths and keys', () => {
  for (let len = 0; len <= 70; len++) {
    const key = randomBytes(16);
    const data = randomBytes(len);
    const cipher = createCipheriv('aes-128-ecb', key, null);
    const expected = Buffer.concat([cipher.update(data), cipher.final()]);
    assert.equal(Buffer.from(aes128EcbEncrypt(key, data)).toString('hex'), expected.toString('hex'), `len ${len}`);
  }
});

test('FIPS 197 appendix C.1 vector (first block)', () => {
  const key = Uint8Array.from({ length: 16 }, (_, i) => i);
  const plain = Uint8Array.from({ length: 16 }, (_, i) => i * 0x11);
  const out = aes128EcbEncrypt(key, plain);
  assert.equal(Buffer.from(out.subarray(0, 16)).toString('hex'), '69c4e0d86a7b0430d8cdb78070b4c55a');
});

test('utf8Bytes matches TextEncoder, including astral characters', () => {
  const text = 'a é 中 😀 {"x":1}';
  assert.deepEqual([...utf8Bytes(text)], [...new TextEncoder().encode(text)]);
});

test('hexUpper', () => {
  assert.equal(hexUpper(Uint8Array.from([0, 15, 16, 255])), '000F10FF');
});
