// multiPart 與 search 的 partCount（假的宿主 API，不連網）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { multiPart, search } from '../src/plugin.js';

const BVID = 'BV1xx411c79H';

function fakeHost(responses) {
  const requests = [];
  const queue = [...responses];
  globalThis.fmp = {
    crypto: { md5: () => '' },
    log: { debug() {}, info() {}, warn() {} },
    storage: {
      async get() {
        return null;
      },
      async set() {},
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

async function rejects(promise, fmpError) {
  await assert.rejects(promise, (e) => {
    assert.equal(e.fmpError, fmpError, JSON.stringify(e));
    return true;
  });
}

test('multiPart maps cid, title, duration (s -> ms) and index', async () => {
  const requests = fakeHost([
    ok([
      { cid: 111, page: 1, part: '开场', duration: 61, from: 'vupload' },
      { cid: 222, page: 2, part: '  第二段 ', duration: 0 },
      { cid: 333, page: 3, part: '', duration: 5 },
    ]),
  ]);
  const result = await multiPart({ sourceId: BVID });
  assert.deepEqual(result, {
    parts: [
      { cid: 111, title: '开场', index: 1, durationMs: 61000 },
      { cid: 222, title: '第二段', index: 2, durationMs: 0 },
      { cid: 333, title: 'P3', index: 3, durationMs: 5000 },
    ],
  });
  assert.equal(requests.length, 1);
  const url = new URL(requests[0].url);
  assert.equal(url.origin + url.pathname, 'https://api.bilibili.com/x/player/pagelist');
  assert.equal(url.searchParams.get('bvid'), BVID);
  assert.equal(requests[0].auth, 'userPreference');
});

test('multiPart maps the recorded pagelist response', async () => {
  const fixture = JSON.parse(
    readFileSync(new URL('../fixtures/multiPart/001.json', import.meta.url), 'utf8'),
  );
  fakeHost([{ body: fixture.response.jsonBody }]);
  const { parts } = await multiPart({ sourceId: 'BV1YmHx6QEV6' });
  assert.equal(parts.length, 9);
  assert.deepEqual(
    parts.map((p) => p.index),
    [1, 2, 3, 4, 5, 6, 7, 8, 9],
  );
  assert.deepEqual(parts[0], { cid: 42488760246, title: '01', index: 1, durationMs: 4635000 });
  assert.deepEqual(parts[8], { cid: 42488825990, title: '更新', index: 9, durationMs: 3611000 });
});

test('multiPart omits durationMs when duration is missing, and falls back to position for index', async () => {
  fakeHost([ok([{ cid: 7, part: 'a' }, { cid: 8, part: 'b', page: 0, duration: 'x' }])]);
  const { parts } = await multiPart({ sourceId: BVID });
  assert.deepEqual(parts, [
    { cid: 7, title: 'a', index: 1 },
    { cid: 8, title: 'b', index: 2 },
  ]);
});

test('multiPart: a blank or non-string part title becomes P<index>', async () => {
  fakeHost([ok([{ cid: 1, page: 1, part: ' \t ' }, { cid: 2, page: 2, part: null }, { cid: 3, page: 3 }])]);
  const { parts } = await multiPart({ sourceId: BVID });
  assert.deepEqual(
    parts.map((p) => p.title),
    ['P1', 'P2', 'P3'],
  );
});

test('multiPart omits a negative or fractional duration', async () => {
  fakeHost([ok([{ cid: 1, page: 1, part: 'a', duration: -1 }, { cid: 2, page: 2, part: 'b', duration: 1.5 }])]);
  const { parts } = await multiPart({ sourceId: BVID });
  assert.ok(parts.every((p) => !('durationMs' in p)), JSON.stringify(parts));
});

test('multiPart: a video without parts is NotFound', async () => {
  fakeHost([ok([])]);
  await rejects(multiPart({ sourceId: BVID }), 'NotFound');
});

test('multiPart: invalid bvid is ParseError and sends no request', async () => {
  const requests = fakeHost([]);
  for (const sourceId of ['', 'av170001', 'BV123', 'BV1xx411c79H1', 'BV1xx411c79!', undefined, 12, 'x&bvid=BV1xx411c79H']) {
    await rejects(multiPart({ sourceId }), 'ParseError');
  }
  assert.equal(requests.length, 0);
});

test('multiPart: shape problems are ParseError', async () => {
  fakeHost([ok({ pages: [] })]);
  await rejects(multiPart({ sourceId: BVID }), 'ParseError');
  fakeHost([ok([{ cid: 1, part: 'a' }, { part: 'no cid' }])]);
  await rejects(multiPart({ sourceId: BVID }), 'ParseError');
  for (const cid of ['1', 0, -5, 1.5, null]) {
    fakeHost([ok([{ cid, part: 'a' }])]);
    await rejects(multiPart({ sourceId: BVID }), 'ParseError');
  }
  fakeHost([ok([null])]);
  await rejects(multiPart({ sourceId: BVID }), 'ParseError');
  fakeHost([ok(null)]);
  await rejects(multiPart({ sourceId: BVID }), 'ParseError');
  fakeHost([{ body: 'null' }]);
  await rejects(multiPart({ sourceId: BVID }), 'ParseError');
  fakeHost([{ body: 'not json' }]);
  await rejects(multiPart({ sourceId: BVID }), 'ParseError');
});

test('multiPart: business codes and HTTP statuses use the shared mapping', async () => {
  const cases = [
    [{ body: { code: -404, message: '啥都木有' } }, 'NotFound'],
    [{ body: { code: 62002, message: '稿件不可见' } }, 'NotFound'],
    [{ body: { code: -352 } }, 'RateLimited'],
    [{ body: { code: -400 } }, 'UnexpectedError'],
    [{ status: 412, body: '' }, 'RateLimited'],
    [{ status: 502, body: '' }, 'NetworkError'],
  ];
  for (const [response, fmpError] of cases) {
    fakeHost([response]);
    await rejects(multiPart({ sourceId: BVID }), fmpError);
  }
});

test('multiPart: -101 is CredentialInvalid only when credentials were attached', async () => {
  fakeHost([{ credentialsAttached: true, body: { code: -101 } }]);
  await rejects(multiPart({ sourceId: BVID }), 'CredentialInvalid');
  fakeHost([{ credentialsAttached: false, body: { code: -101 } }]);
  await rejects(multiPart({ sourceId: BVID }), 'AuthRequired');
});

test('search gives partCount from page only when it is a positive integer', async () => {
  fakeHost([
    ok({
      numResults: 5,
      result: [
        { bvid: 'BV1aaaaaaaaa', title: 'a', page: 3 },
        { bvid: 'BV1bbbbbbbbb', title: 'b', page: 1 },
        { bvid: 'BV1ccccccccc', title: 'c' },
        { bvid: 'BV1ddddddddd', title: 'd', page: 0 },
        { bvid: 'BV1eeeeeeeee', title: 'e', page: '2' },
      ],
    }),
  ]);
  const { items } = await search({ keyword: 'x', page: 1 });
  assert.deepEqual(
    items.map((i) => ('partCount' in i ? i.partCount : 'none')),
    [3, 1, 'none', 'none', 'none'],
  );
});
