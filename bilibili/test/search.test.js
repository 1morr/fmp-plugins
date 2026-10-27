// search：viewCount 來自每筆的 play（假的宿主 API，不連網）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { search } from '../src/plugin.js';

function fakeHost(body) {
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
      async request() {
        return { status: 200, headers: {}, body: JSON.stringify(body) };
      },
    },
  };
}
const ok = (data) => ({ code: 0, message: '0', data });
const video = (bvid, extra = {}) => ({ bvid, title: bvid, author: 'a', duration: '1:00', pic: '', ...extra });

test('search: viewCount is play when it is a non-negative integer, otherwise left out', async () => {
  fakeHost(
    ok({
      numResults: 5,
      result: [
        video('BV1aaaaaaaaa', { play: 466187 }),
        video('BV1bbbbbbbbb', { play: 0 }),
        video('BV1ccccccccc', { play: '--' }),
        video('BV1ddddddddd', { play: -3 }),
        video('BV1eeeeeeeee'),
      ],
    }),
  );
  const { items } = await search({ keyword: 'k', page: 1 });
  assert.equal(items[0].viewCount, 466187);
  assert.equal(items[1].viewCount, 0);
  for (const item of items.slice(2)) assert.equal('viewCount' in item, false, item.sourceId);
});

test('search: maps the recorded response, every item has a viewCount', async () => {
  const recorded = JSON.parse(readFileSync(new URL('../fixtures/search/001.json', import.meta.url), 'utf8'));
  fakeHost(recorded.response.jsonBody);
  const { items } = await search({ keyword: '钢琴', page: 1 });
  assert.ok(items.length >= 10);
  for (const item of items) assert.ok(Number.isInteger(item.viewCount) && item.viewCount >= 0, item.sourceId);
});
