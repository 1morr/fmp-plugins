// trackDetail 以假的宿主 API 跑，不連網。
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { trackDetail } from '../src/plugin.js';

function host(response) {
  const requests = [];
  globalThis.fmp = {
    log: { debug() {}, info() {}, warn() {} },
    http: {
      async request(req) {
        requests.push(req);
        return { status: 200, headers: {}, ...response, body: typeof response.body === 'string' ? response.body : JSON.stringify(response.body) };
      },
    },
  };
  return requests;
}
const song = (extra = {}) => ({
  code: 200,
  songs: [{ id: 139774, name: 'x', ar: [{ id: 1, name: 'a' }], al: { id: 9, name: '  专辑名 ', picUrl: 'http://p1.music.126.net/a.jpg' }, publishTime: 1262275200000, ...extra }],
  privileges: [],
});

test('trackDetail maps the album and the song publish time with one request', async () => {
  const requests = host({ body: song() });
  assert.deepEqual(await trackDetail({ sourceId: '139774' }), { album: '专辑名', publishedAt: 1262275200000 });
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, 'https://music.163.com/api/v3/song/detail');
  assert.equal(requests[0].method, 'POST');
  assert.deepEqual(JSON.parse(decodeURIComponent(requests[0].body.replace(/^c=/, ''))), [{ id: 139774 }]);
  assert.equal(requests[0].auth, 'userPreference');
  assert.equal(requests[0].idempotent, true);
  assert.ok(!Object.keys(requests[0].headers).some((n) => n.toLowerCase() === 'x-real-ip'));
});

test('trackDetail omits fields the endpoint does not provide (publishTime 0, no album)', async () => {
  host({ body: song({ publishTime: 0, al: { id: 0, name: '' } }) });
  assert.deepEqual(await trackDetail({ sourceId: '139774' }), {});
  host({ body: song({ publishTime: undefined, al: undefined, album: { name: 'alt' } }) });
  assert.deepEqual(await trackDetail({ sourceId: '139774' }), { album: 'alt' });
  host({ body: song({ publishTime: -5 }) });
  assert.equal((await trackDetail({ sourceId: '139774' })).publishedAt, undefined);
});

test('trackDetail with no song is NotFound; a non-object song is ParseError', async () => {
  host({ body: { code: 200, songs: [], privileges: [] } });
  await assert.rejects(trackDetail({ sourceId: '1' }), (e) => e.fmpError === 'NotFound');
  host({ body: { code: 200 } });
  await assert.rejects(trackDetail({ sourceId: '1' }), (e) => e.fmpError === 'NotFound');
  host({ body: { code: 200, songs: ['x'] } });
  await assert.rejects(trackDetail({ sourceId: '1' }), (e) => e.fmpError === 'ParseError');
});

test('trackDetail rejects a bad song id as ParseError without a request', async () => {
  const requests = host({ body: song() });
  for (const sourceId of ['', 'abc', '12a', '-1', undefined, 12, '9007199254740993']) {
    await assert.rejects(trackDetail({ sourceId }), (e) => e.fmpError === 'ParseError');
  }
  assert.equal(requests.length, 0);
});

test('trackDetail errors follow the shared mapping', async () => {
  host({ status: 200, body: { code: -460 } });
  await assert.rejects(trackDetail({ sourceId: '1' }), (e) => e.fmpError === 'VerificationRequired');
  host({ status: 503, body: '' });
  await assert.rejects(trackDetail({ sourceId: '1' }), (e) => e.fmpError === 'NetworkError');
  host({ status: 200, body: 'nope' });
  await assert.rejects(trackDetail({ sourceId: '1' }), (e) => e.fmpError === 'ParseError');
  host({ status: 200, body: { code: 500, message: 'x' } });
  await assert.rejects(trackDetail({ sourceId: '1' }), (e) => e.fmpError === 'UnexpectedError');
});

test('a top-level 301 is CredentialInvalid with credentials attached, AuthRequired without', async () => {
  host({ status: 200, body: { code: 301 }, credentialsAttached: true });
  await assert.rejects(trackDetail({ sourceId: '1' }), (e) => e.fmpError === 'CredentialInvalid');
  host({ status: 200, body: { code: 301 }, credentialsAttached: false });
  await assert.rejects(trackDetail({ sourceId: '1' }), (e) => e.fmpError === 'AuthRequired');
});
