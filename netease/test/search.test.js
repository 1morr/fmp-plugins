// search 以假的宿主 API 跑：X-Real-IP 只在取流送（README § X-Real-IP），搜尋不帶。
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { search } from '../src/plugin.js';

test('the search request carries no X-Real-IP and is idempotent', async () => {
  const requests = [];
  globalThis.fmp = {
    log: { debug() {}, info() {}, warn() {} },
    http: {
      async request(req) {
        requests.push(req);
        return { status: 200, headers: {}, body: JSON.stringify({ code: 200, result: { songs: [], songCount: 0 } }) };
      },
    },
  };
  const result = await search({ keyword: 'x', page: 1 });
  assert.deepEqual(result, { items: [], hasMore: false });
  assert.equal(requests.length, 1);
  const names = Object.keys(requests[0].headers).map((n) => n.toLowerCase());
  assert.ok(!names.includes('x-real-ip'), `headers: ${names.join(', ')}`);
  assert.equal(requests[0].idempotent, true);
  assert.equal(requests[0].auth, 'userPreference');
});

function hostReturning(response) {
  globalThis.fmp = {
    log: { debug() {}, info() {}, warn() {} },
    http: { request: async () => ({ headers: {}, ...response }) },
  };
}

test('a top-level 301 is CredentialInvalid with credentials attached, AuthRequired without', async () => {
  const body = JSON.stringify({ code: 301, message: 'not logged in' });
  hostReturning({ status: 200, body, credentialsAttached: true });
  await assert.rejects(search({ keyword: 'x', page: 1 }), (e) => e.fmpError === 'CredentialInvalid');
  hostReturning({ status: 200, body, credentialsAttached: false });
  await assert.rejects(search({ keyword: 'x', page: 1 }), (e) => e.fmpError === 'AuthRequired');
});

test('risk and network failures stay what they were even with credentials attached', async () => {
  hostReturning({ status: 200, body: JSON.stringify({ code: -460 }), credentialsAttached: true });
  await assert.rejects(search({ keyword: 'x', page: 1 }), (e) => e.fmpError === 'VerificationRequired');
  hostReturning({ status: 503, body: '', credentialsAttached: true });
  await assert.rejects(search({ keyword: 'x', page: 1 }), (e) => e.fmpError === 'NetworkError');
});
