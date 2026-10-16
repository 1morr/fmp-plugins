// charts：音樂區排行榜（假的宿主 API，不連網）。榜單項目的形狀來自舊專案 getRankingVideos 讀的欄位
// （bvid、title、owner.name、duration、pic）；真實回應見 fixtures/charts/002.json（001 是取 WBI key 的 nav）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

import { chart, chartList, rankingTrack } from '../src/plugin.js';

const recorded = (name) => JSON.parse(readFileSync(new URL(`../fixtures/charts/${name}`, import.meta.url), 'utf8'));
const md5 = (text) => createHash('md5').update(text).digest('hex');

// 預設當天的 WBI key 已存好：chart 不必先問 nav。storedKeys: false 時 md5 是真的，storage 是空的
// 或沿用傳入的 store。
function fakeHost(responses, { storedKeys = true, store = new Map() } = {}) {
  const requests = [];
  const queue = [...responses];
  const day = new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);
  if (storedKeys) store.set('wbiKeys', JSON.stringify({ imgKey: 'a'.repeat(32), subKey: 'b'.repeat(32), day }));
  globalThis.fmp = {
    store,
    crypto: { md5: storedKeys ? () => 'f'.repeat(32) : md5 },
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

async function rejects(promise, fmpError) {
  await assert.rejects(promise, (e) => {
    assert.equal(e.fmpError, fmpError, JSON.stringify(e));
    return true;
  });
}

const item = (bvid, extra = {}) => ({
  bvid,
  title: `title ${bvid}`,
  owner: { mid: 1, name: `up ${bvid}` },
  duration: 200,
  pic: 'http://i0.hdslb.com/bfs/archive/x.jpg',
  stat: { view: 100 },
  ...extra,
});

test('chartList: one fixed chart', () => {
  assert.deepEqual(chartList(), { charts: [{ chartId: 'music', title: '音樂排行榜' }] });
});

test('chart: asks ranking/v2 for region 1003, keeps the ranking order and maps the fields', async () => {
  const requests = fakeHost([ok({ list: [item('BV1aaaaaaaaa'), item('BV1bbbbbbbbb', { title: ' a &amp; b <c> & d  ', duration: 0 })] })]);
  const { tracks } = await chart({ chartId: 'music' });
  assert.deepEqual(tracks.map((t) => t.sourceId), ['BV1aaaaaaaaa', 'BV1bbbbbbbbb']);
  assert.deepEqual(tracks[0], {
    sourceId: 'BV1aaaaaaaaa',
    title: 'title BV1aaaaaaaaa',
    uploader: 'up BV1aaaaaaaaa',
    durationMs: 200000,
    artwork: [
      { url: 'https://i0.hdslb.com/bfs/archive/x.jpg@160w', width: 160 },
      { url: 'https://i0.hdslb.com/bfs/archive/x.jpg@480w', width: 480 },
      { url: 'https://i0.hdslb.com/bfs/archive/x.jpg' },
    ],
  });
  // 榜單標題是純文字：只去頭尾空白，`<…>` 與實體原樣留著（不同於 search 的 HTML 標題）。
  assert.equal(tracks[1].title, 'a &amp; b <c> & d');
  assert.equal(tracks[1].durationMs, 0);
  assert.equal(requests.length, 1);
  const url = new URL(requests[0].url);
  assert.equal(url.origin + url.pathname, 'https://api.bilibili.com/x/web-interface/ranking/v2');
  assert.equal(url.searchParams.get('rid'), '1003');
  assert.equal(url.searchParams.get('type'), 'all');
  // 不簽的匿名請求一律 -352：網頁版的 web_location 與 WBI 簽名都要帶。
  assert.equal(url.searchParams.get('web_location'), '333.934');
  assert.match(url.searchParams.get('wts'), /^\d+$/);
  assert.equal(url.searchParams.get('w_rid'), 'f'.repeat(32));
  assert.equal(requests[0].auth, 'userPreference');
  assert.match(requests[0].headers['User-Agent'], /^Mozilla\/5\.0 .*Chrome/);
  assert.equal(requests[0].headers.Referer, 'https://www.bilibili.com/');
});

test('chart: keeps the ranking order, not bvid, view or duration order', async () => {
  fakeHost([
    ok({
      list: [
        item('BV1ccccccccc', { stat: { view: 1 }, duration: 300 }),
        item('BV1aaaaaaaaa', { stat: { view: 300 }, duration: 100 }),
        item('BV1bbbbbbbbb', { stat: { view: 20 }, duration: 200 }),
      ],
    }),
  ]);
  const { tracks } = await chart({ chartId: 'music' });
  assert.deepEqual(tracks.map((t) => t.sourceId), ['BV1ccccccccc', 'BV1aaaaaaaaa', 'BV1bbbbbbbbb']);
});

test('chart: without cached keys asks nav first, signs web_location into w_rid and caches the keys', async () => {
  // nav 是錄下的真實回應；它的 img_key、sub_key 依 WBI 重排表得到的 mixin key 是
  // ea1db124af3c7062474693fa704f4ff8（與 bilibili-API-collect 的 WBI 文件範例同一組 key）。
  const requests = fakeHost([{ body: recorded('001.json').response.jsonBody }, ok({ list: [item('BV1aaaaaaaaa')] })], {
    storedKeys: false,
  });
  await chart({ chartId: 'music' });
  assert.deepEqual(
    requests.map((r) => new URL(r.url).pathname),
    ['/x/web-interface/nav', '/x/web-interface/ranking/v2'],
  );
  const params = new URL(requests[1].url).searchParams;
  const wts = params.get('wts');
  assert.match(wts, /^\d+$/);
  const signedText = `rid=1003&type=all&web_location=333.934&wts=${wts}`;
  assert.equal(params.get('w_rid'), md5(`${signedText}ea1db124af3c7062474693fa704f4ff8`));
  const cached = JSON.parse(globalThis.fmp.store.get('wbiKeys'));
  assert.equal(cached.imgKey, '7cd084941338484aae1ad9425b84077c');
  assert.equal(cached.subKey, '4932caff0ff746eab6f01bf08b70ac45');

  // 同一天再取：沿用存好的 key，只發 ranking 一個請求。
  const again = fakeHost([ok({ list: [] })], { storedKeys: false, store: globalThis.fmp.store });
  await chart({ chartId: 'music' });
  assert.deepEqual(again.map((r) => new URL(r.url).pathname), ['/x/web-interface/ranking/v2']);
});

test('chart: nav under risk control is RateLimited and the ranking is not requested', async () => {
  const requests = fakeHost([{ body: { code: -352, message: '风控校验失败', data: null } }], { storedKeys: false });
  await rejects(chart({ chartId: 'music' }), 'RateLimited');
  assert.equal(requests.length, 1);
  assert.equal(globalThis.fmp.store.has('wbiKeys'), false);
});

test('rankingTrack: skips entries without a bvid, fills in missing fields', () => {
  assert.equal(rankingTrack(null), null);
  assert.equal(rankingTrack({ title: 'x' }), null);
  assert.equal(rankingTrack({ bvid: '' }), null);
  assert.deepEqual(rankingTrack({ bvid: 'BV1aaaaaaaaa', title: '  ' }), {
    sourceId: 'BV1aaaaaaaaa',
    title: 'Unknown',
    uploader: null,
    durationMs: null,
    artwork: [],
  });
  // 封面不在 hdslb.com 就不給。
  assert.deepEqual(rankingTrack(item('BV1aaaaaaaaa', { pic: 'https://evil.example/x.jpg' })).artwork, []);
  // videos 是分 P 數：正整數才給 partCount。
  assert.equal(rankingTrack(item('BV1aaaaaaaaa', { videos: 3 })).partCount, 3);
  assert.equal('partCount' in rankingTrack(item('BV1aaaaaaaaa', { videos: 0 })), false);
  assert.equal('partCount' in rankingTrack(item('BV1aaaaaaaaa', { videos: '3' })), false);
});

test('chart: an empty list is an empty chart, a list that is not an array is a ParseError', async () => {
  fakeHost([ok({ list: [] })]);
  assert.deepEqual(await chart({ chartId: 'music' }), { tracks: [] });
  fakeHost([ok({})]);
  await rejects(chart({ chartId: 'music' }), 'ParseError');
});

test('chart: risk control codes are RateLimited, HTTP 412 too', async () => {
  for (const code of [-352, -412, -509, -799]) {
    fakeHost([{ body: { code, message: 'risk control', data: null } }]);
    await rejects(chart({ chartId: 'music' }), 'RateLimited');
  }
  fakeHost([{ status: 412, body: '' }]);
  await rejects(chart({ chartId: 'music' }), 'RateLimited');
  fakeHost([{ status: 502, body: '' }]);
  await rejects(chart({ chartId: 'music' }), 'NetworkError');
});

test('chart: unknown chartId is NotFound and sends no request', async () => {
  const requests = fakeHost([]);
  await rejects(chart({ chartId: 'nope' }), 'NotFound');
  assert.equal(requests.length, 0);
});

test('chart: maps the recorded ranking response in its order', async () => {
  const body = recorded('002.json').response.jsonBody;
  fakeHost([{ body }]);
  const { tracks } = await chart({ chartId: 'music' });
  // 錄到的 100 筆都有 bvid，所以一筆不少、順序原樣。
  assert.deepEqual(
    tracks.map((t) => t.sourceId),
    body.data.list.map((entry) => entry.bvid),
  );
  for (const t of tracks) {
    assert.match(t.sourceId, /^BV[0-9A-Za-z]{10}$/);
    assert.ok(t.title !== '');
    assert.ok(t.artwork.length > 0, t.sourceId);
  }
});
