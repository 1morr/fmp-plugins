import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import { sha1Hex, sapisidHash, authHeadersFor } from '../src/sapisid.js';

test('sha1Hex matches node:crypto, including block boundaries and non-ASCII', () => {
  const inputs = [
    '',
    'abc',
    'a'.repeat(55),
    'a'.repeat(56),
    'a'.repeat(63),
    'a'.repeat(64),
    'a'.repeat(65),
    'a'.repeat(1000),
    '中文 😀 é',
    '1700000000 fake-sapisid https://www.youtube.com',
  ];
  for (const input of inputs) {
    assert.equal(sha1Hex(input), createHash('sha1').update(input, 'utf8').digest('hex'), JSON.stringify(input.slice(0, 20)));
  }
});

test('sapisidHash follows the legacy formula: SHA1("{ts} {SAPISID} https://www.youtube.com")', () => {
  const nowMs = 1_700_000_000_123;
  const expected = createHash('sha1').update('1700000000 fake-sapisid https://www.youtube.com').digest('hex');
  assert.equal(sapisidHash('fake-sapisid', nowMs), `SAPISIDHASH 1700000000_${expected}`);
});

test('authHeadersFor needs a SAPISID', () => {
  assert.equal(authHeadersFor(null, 0), null);
  assert.equal(authHeadersFor({ cookies: {} }, 0), null);
  const headers = authHeadersFor({ cookies: { SAPISID: 'fake-sapisid' } }, 1_700_000_000_000);
  assert.deepEqual(Object.keys(headers).sort(), ['Authorization', 'X-Origin']);
  assert.equal(headers['X-Origin'], 'https://www.youtube.com');
  assert.match(headers.Authorization, /^SAPISIDHASH 1700000000_[0-9a-f]{40}$/);
});
