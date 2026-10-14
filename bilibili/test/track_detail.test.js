// trackDetail（假的宿主 API，不連網）。
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { trackDetail } from '../src/plugin.js';

const BVID = 'BV1xx411c79H';
const IMG_KEY = 'a'.repeat(32);
const SUB_KEY = 'b'.repeat(32);

function fakeHost(responses, { storedKeys = false } = {}) {
  const requests = [];
  const queue = [...responses];
  const store = new Map();
  if (storedKeys) {
    const day = new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);
    store.set('wbiKeys', JSON.stringify({ imgKey: IMG_KEY, subKey: SUB_KEY, day }));
  }
  globalThis.fmp = {
    crypto: { md5: () => 'f'.repeat(32) },
    log: { debug() {}, info() {}, warn() {} },
    storage: {
      async get(key) {
        return store.has(key) ? store.get(key) : null;
      },
      async set(key, value) {
        store.set(key, value);
      },
    },
    http: {
      async request(req) {
        requests.push(req);
        const next = queue.shift();
        if (next === undefined) throw new Error(`unexpected request ${req.url}`);
        return {
          status: 200,
          headers: {},
          ...next,
          body: typeof next.body === 'string' ? next.body : JSON.stringify(next.body),
        };
      },
    },
  };
  return requests;
}
const ok = (data) => ({ body: { code: 0, message: '0', data } });
const nav = ok({
  wbi_img: {
    img_url: `https://i0.hdslb.com/bfs/wbi/${IMG_KEY}.png`,
    sub_url: `https://i0.hdslb.com/bfs/wbi/${SUB_KEY}.png`,
  },
});

async function rejects(promise, fmpError) {
  await assert.rejects(promise, (e) => {
    assert.equal(e.fmpError, fmpError, JSON.stringify(e));
    return true;
  });
}

const VIEW = {
  bvid: BVID,
  cid: 1,
  desc: '  简介第一行\n第二行 ',
  pubdate: 1700000000,
  owner: { mid: 1, name: 'up', face: 'https://i1.hdslb.com/bfs/face/abc.jpg' },
  stat: { view: 100, like: 10, coin: 3, favorite: 7, share: 2, danmaku: 5, reply: 4, his_rank: 0 },
};

test('trackDetail maps description, date, avatar and stats from wbi/view', async () => {
  const requests = fakeHost([nav, ok(VIEW)]);
  const detail = await trackDetail({ sourceId: BVID });
  assert.deepEqual(detail, {
    description: '简介第一行\n第二行',
    publishedAt: 1700000000000,
    uploaderAvatar: [
      { url: 'https://i1.hdslb.com/bfs/face/abc.jpg@160w', width: 160 },
      { url: 'https://i1.hdslb.com/bfs/face/abc.jpg@480w', width: 480 },
      { url: 'https://i1.hdslb.com/bfs/face/abc.jpg' },
    ],
    stats: [
      { kind: 'view', count: 100 },
      { kind: 'like', count: 10 },
      { kind: 'favorite', count: 7 },
      { kind: 'comment', count: 4 },
      { kind: 'share', count: 2 },
      { kind: 'danmaku', count: 5 },
      { kind: 'coin', count: 3 },
    ],
  });
  assert.equal(requests.length, 2);
  const url = new URL(requests[1].url);
  assert.equal(url.origin + url.pathname, 'https://api.bilibili.com/x/web-interface/wbi/view');
  assert.equal(url.searchParams.get('bvid'), BVID);
  assert.ok(url.searchParams.get('w_rid'));
  assert.ok(url.searchParams.get('wts'));
});

test('trackDetail treats a "-" description as no description', async () => {
  fakeHost([ok({ ...VIEW, desc: ' - ' })], { storedKeys: true });
  const detail = await trackDetail({ sourceId: BVID });
  assert.equal('description' in detail, false);
});

test('trackDetail needs one request when the WBI keys are cached', async () => {
  const requests = fakeHost([ok(VIEW)], { storedKeys: true });
  await trackDetail({ sourceId: BVID, cid: 123 });
  assert.equal(requests.length, 1);
});

test('trackDetail omits what the endpoint does not provide', async () => {
  fakeHost([ok({ bvid: BVID, desc: '   ', pubdate: 0, owner: { face: 'https://evil.example/a.jpg' }, stat: {} })], {
    storedKeys: true,
  });
  assert.deepEqual(await trackDetail({ sourceId: BVID }), {});
});

test('trackDetail skips stats that are not non-negative integers', async () => {
  fakeHost(
    [ok({ ...VIEW, stat: { view: '--', like: -1, coin: 1.5, favorite: 0, share: null, danmaku: 8 } })],
    { storedKeys: true },
  );
  const detail = await trackDetail({ sourceId: BVID });
  assert.deepEqual(detail.stats, [
    { kind: 'favorite', count: 0 },
    { kind: 'danmaku', count: 8 },
  ]);
});

test('trackDetail tags requests with auth userPreference', async () => {
  const requests = fakeHost([nav, ok(VIEW)]);
  await trackDetail({ sourceId: BVID });
  assert.deepEqual(
    requests.map((r) => r.auth),
    ['userPreference', 'userPreference'],
  );
});

test('trackDetail rejects invalid input without a request', async () => {
  const requests = fakeHost([]);
  await rejects(trackDetail({ sourceId: 'av170001' }), 'ParseError');
  await rejects(trackDetail({ sourceId: undefined }), 'ParseError');
  await rejects(trackDetail({ sourceId: BVID, cid: 0 }), 'ParseError');
  await rejects(trackDetail({ sourceId: BVID, cid: '1' }), 'ParseError');
  assert.equal(requests.length, 0);
});

test('trackDetail maps errors like the other capabilities', async () => {
  fakeHost([{ body: { code: -404, message: 'not found' } }], { storedKeys: true });
  await rejects(trackDetail({ sourceId: BVID }), 'NotFound');
  fakeHost([{ body: { code: -352, message: 'risk' } }], { storedKeys: true });
  await rejects(trackDetail({ sourceId: BVID }), 'RateLimited');
  fakeHost([{ status: 500, body: '' }], { storedKeys: true });
  await rejects(trackDetail({ sourceId: BVID }), 'NetworkError');
  fakeHost([{ body: 'not json' }], { storedKeys: true });
  await rejects(trackDetail({ sourceId: BVID }), 'ParseError');
});

test('trackDetail reports a credential the site rejected only when one was attached', async () => {
  fakeHost([{ body: { code: -101, message: 'x' }, credentialsAttached: true }], { storedKeys: true });
  await rejects(trackDetail({ sourceId: BVID }), 'CredentialInvalid');
  fakeHost([{ body: { code: -101, message: 'x' }, credentialsAttached: false }], { storedKeys: true });
  await rejects(trackDetail({ sourceId: BVID }), 'AuthRequired');
});
