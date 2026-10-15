// importPlaylist（假的宿主 API，不連網）：收藏夾 fav/resource/list、多 P 展開（pagelist）、私人收藏夾的重送。
// 回應形狀照 2026-10-15 匿名實測的官方帳號收藏夾（見 fixtures/importPlaylist 與 README），其餘是手寫的變體。
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { importPlaylist, playlistFromUrl } from '../src/plugin.js';

// 收藏夾的完整 id（media_id）；list-all 回的短 fid（40267484）不能用，見 README。
const FID = '4026748432';

// ------------------------------------------------------------------ 假宿主

let requests;
let reply; // (req, n) => {status?, body, credentialsAttached?}
let credentials;
let preferenceOn;
beforeEach(() => {
  requests = [];
  credentials = null;
  preferenceOn = true;
  reply = () => ({ body: { code: 0, message: '0', data: {} } });
  const store = new Map();
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
    credentials: { get: async () => credentials },
    http: {
      async request(req) {
        // 宿主只在已登入且（required，或 userPreference 且開關開著）時帶憑證。
        const attached = credentials !== null && (req.auth === 'required' || (req.auth === 'userPreference' && preferenceOn));
        requests.push({ ...req, attached });
        const next = reply(req, requests.length);
        const body = next.body;
        return { status: 200, headers: {}, credentialsAttached: attached, ...next, body: typeof body === 'string' ? body : JSON.stringify(body) };
      },
    },
  };
});

const ok = (data) => ({ body: { code: 0, message: '0', data } });
const err = (code, message = '') => ({ body: { code, message, ttl: 1 } });
const isError = (kind) => (e) => e.fmpError === kind;
const params = (req) => Object.fromEntries(new URL(req.url).searchParams);

const info = (extra = {}) => ({
  id: 4026748432,
  title: 'B站 × WAIC AI会客厅',
  cover: 'http://i0.hdslb.com/bfs/archive/cover.jpg',
  intro: '简介',
  upper: { mid: 8047632, name: '哔哩哔哩弹幕网' },
  media_count: 3,
  ...extra,
});
const media = (bvid, extra = {}) => ({
  id: 1,
  type: 2,
  title: `title ${bvid}`,
  cover: 'http://i1.hdslb.com/bfs/archive/c.jpg',
  page: 1,
  duration: 120,
  upper: { mid: 1, name: `up ${bvid}` },
  attr: 0,
  bvid,
  ...extra,
});
const BV1 = 'BV1xx411c79H';
const BV2 = 'BV1YmHx6QEV6';
const BV3 = 'BV1GJ411x7h7';
const page = (medias, { hasMore = false, infoExtra } = {}) => ok({ info: info(infoExtra), medias, has_more: hasMore });
const pagelist = (parts) => ok(parts.map(([cid, part, duration], i) => ({ cid, page: i + 1, part, duration })));

// ------------------------------------------------------------------ playlistFromUrl

test('playlistFromUrl: every accepted form', () => {
  for (const url of [
    `https://space.bilibili.com/8047632/favlist?fid=${FID}&ftype=create`,
    `https://space.bilibili.com/8047632/favlist?ftype=create&fid=${FID}`,
    `https://www.bilibili.com/medialist/detail/ml${FID}`,
    `https://www.bilibili.com/medialist/detail/ml${FID}?type=1`,
    `https://www.bilibili.com/list/ml${FID}`,
    `https://m.bilibili.com/medialist/detail/ml${FID}`,
    `https://bilibili.com/medialist/play/ml${FID}`,
    `www.bilibili.com/medialist/detail/ml${FID}`,
    `  http://WWW.bilibili.com./medialist/detail/ml${FID}#top  `,
    `https://www.bilibili.com:443/medialist/detail/ml${FID}`,
  ]) {
    assert.deepEqual(playlistFromUrl({ url }), { playlistId: FID }, url);
  }
  assert.equal(requests.length, 0, 'no request');
});

test('playlistFromUrl: anything else is null', () => {
  for (const url of [
    '',
    'not a url',
    `ml${FID}`,
    'https://space.bilibili.com/8047632/favlist',
    'https://space.bilibili.com/8047632/favlist?fid=abc',
    'https://space.bilibili.com/8047632/favlist?fid=',
    'https://www.bilibili.com/video/BV1xx411c79H',
    'https://www.bilibili.com/medialist/detail/ml',
    'https://www.bilibili.com/medialist/detail/xml123',
    'https://www.bilibili.com/medialist/detail/ml0',
    `https://evil.example.com/medialist/detail/ml${FID}`,
    `https://bilibili.com.evil.example/medialist/detail/ml${FID}`,
    `https://attacker.example/?u=www.bilibili.com&fid=${FID}`,
    `https://www.bilibili.com@evil.example/medialist/detail/ml${FID}`,
    `ftp://www.bilibili.com/medialist/detail/ml${FID}`,
    `https://b23.tv/ml${FID}`,
    // 清單 id 含 html5 的 YouTube 歌單：舊版靠主機檢查才不被搶走。
    'https://www.youtube.com/playlist?list=PLhtml5abc',
    `https://www.bilibili.com/medialist/detail/ml${'9'.repeat(19)}`,
  ]) {
    assert.equal(playlistFromUrl({ url }), null, url);
  }
  assert.equal(playlistFromUrl({}), null);
  assert.equal(playlistFromUrl(undefined), null);
  assert.equal(playlistFromUrl({ url: 7 }), null);
});

// ------------------------------------------------------------------ importPlaylist

test('importPlaylist: a single page of single-part videos', async () => {
  reply = () => page([media(BV1), media(BV2, { page: 1 })]);
  const result = await importPlaylist({ playlistId: FID });
  assert.deepEqual(result.playlist, {
    title: 'B站 × WAIC AI会客厅',
    description: '简介',
    artwork: [
      { url: 'https://i0.hdslb.com/bfs/archive/cover.jpg@160w', width: 160 },
      { url: 'https://i0.hdslb.com/bfs/archive/cover.jpg@480w', width: 480 },
      { url: 'https://i0.hdslb.com/bfs/archive/cover.jpg' },
    ],
    ownerName: '哔哩哔哩弹幕网',
  });
  assert.equal(result.items.length, 2);
  assert.deepEqual(result.items[0], {
    track: {
      sourceId: BV1,
      title: `title ${BV1}`,
      uploader: `up ${BV1}`,
      durationMs: 120000,
      artwork: [
        { url: 'https://i1.hdslb.com/bfs/archive/c.jpg@160w', width: 160 },
        { url: 'https://i1.hdslb.com/bfs/archive/c.jpg@480w', width: 480 },
        { url: 'https://i1.hdslb.com/bfs/archive/c.jpg' },
      ],
      partCount: 1,
    },
  });
  for (const item of result.items) {
    assert.deepEqual(Object.keys(item), ['track'], 'no remoteItemId, no unavailable');
    for (const key of ['cid', 'partIndex', 'parentTitle']) assert.equal(key in item.track, false, `single part has no ${key}`);
  }
  assert.equal(result.cursor, null);
  assert.equal('total' in result, false, 'no total');
  assert.equal('writable' in result.playlist, false, 'anonymous: writable unknown');
  assert.equal(requests.length, 1);
  assert.equal(requests[0].method === undefined || requests[0].method === 'GET', true);
  assert.equal(requests[0].auth, 'userPreference');
  assert.deepEqual(params(requests[0]), { media_id: FID, pn: '1', ps: '20', platform: 'web' });
  assert.match(requests[0].url, /^https:\/\/api\.bilibili\.com\/x\/v3\/fav\/resource\/list\?/);
  assert.match(requests[0].headers.Cookie, /buvid3=/);
});

test('importPlaylist: a multi-part video expands into its parts', async () => {
  reply = (req) => {
    if (req.url.includes('/x/v3/fav/resource/list')) return page([media(BV1), media(BV2, { page: 3, title: '直播回放', duration: 9000 })]);
    assert.match(req.url, /\/x\/player\/pagelist\?bvid=BV1YmHx6QEV6$/);
    return pagelist([[101, '上半场', 3000], [102, '下半场', 3600], [103, '花絮', 60]]);
  };
  const result = await importPlaylist({ playlistId: FID });
  assert.equal(requests.length, 2, 'the list page and one pagelist for the multi-part video only');
  assert.equal(result.items.length, 4);
  assert.equal(result.items[0].track.sourceId, BV1);
  const parts = result.items.slice(1).map((i) => i.track);
  assert.deepEqual(parts.map((t) => [t.sourceId, t.cid, t.title, t.durationMs, t.partIndex, t.parentTitle, t.partCount]), [
    [BV2, 101, '上半场', 3000000, 1, '直播回放', 3],
    [BV2, 102, '下半场', 3600000, 2, '直播回放', 3],
    [BV2, 103, '花絮', 60000, 3, '直播回放', 3],
  ]);
  assert.equal(parts[0].uploader, `up ${BV2}`);
  assert.deepEqual(parts[0].artwork, result.items[1].track.artwork);
  assert.equal(result.cursor, null);
  assert.equal('total' in result, false, 'no total after expansion');
});

test('importPlaylist: pagelist with a single part keeps the video as one track without cid', async () => {
  reply = (req) => (req.url.includes('/fav/resource/list') ? page([media(BV2, { page: 2 })]) : pagelist([[101, 'only', 100]]));
  const result = await importPlaylist({ playlistId: FID });
  assert.equal(result.items.length, 1);
  for (const key of ['cid', 'partIndex', 'parentTitle']) assert.equal(key in result.items[0].track, false, key);
});

test('importPlaylist: a pagelist NotFound fails the page, not as NotFound (that would mark the folder gone)', async () => {
  reply = (req) => (req.url.includes('/fav/resource/list') ? page([media(BV1), media(BV2, { page: 2 })]) : err(-404, '啥都木有'));
  await assert.rejects(importPlaylist({ playlistId: FID }), isError('UnexpectedError'));
});

test('importPlaylist: other pagelist failures fail the page', async () => {
  reply = (req) => (req.url.includes('/fav/resource/list') ? page([media(BV2, { page: 2 })]) : err(-352, 'risk'));
  await assert.rejects(importPlaylist({ playlistId: FID }), isError('RateLimited'));
  reply = (req) => (req.url.includes('/fav/resource/list') ? page([media(BV2, { page: 2 })]) : ok({}));
  await assert.rejects(importPlaylist({ playlistId: FID }), isError('ParseError'));
});

test('importPlaylist: deleted videos are unavailable and are not expanded; non-videos are skipped', async () => {
  reply = () => page([
    media(BV1, { attr: 9, title: '已失效视频', page: 4, duration: 0 }),
    media(BV2, { attr: 1 }),
    media(BV3),
    media('', { type: 12, bvid: '', id: 77 }), // 音訊
    media(BV1, { type: 21 }), // 合集
    media('not-a-bvid'),
    null,
  ]);
  const result = await importPlaylist({ playlistId: FID });
  assert.deepEqual(result.items.map((i) => [i.track.sourceId, i.unavailable]), [[BV1, true], [BV2, true], [BV3, undefined]]);
  assert.equal(result.items[0].track.title, '已失效视频');
  assert.equal(requests.length, 1, 'a deleted multi-part video costs no pagelist request');
});

test('importPlaylist: missing optional fields give null and omit the extras', async () => {
  reply = () => ok({ info: { title: ' 空封面 ', upper: null }, medias: [{ bvid: BV1, upper: null }, { bvid: BV2, title: '  ', duration: 'x', cover: 'https://evil.example/c.jpg' }] });
  const result = await importPlaylist({ playlistId: FID });
  assert.deepEqual(result.playlist, { title: '空封面' });
  assert.deepEqual(result.items.map((i) => i.track), [
    { sourceId: BV1, title: 'Unknown', uploader: null, durationMs: null, artwork: [] },
    { sourceId: BV2, title: 'Unknown', uploader: null, durationMs: null, artwork: [] },
  ]);
});

test('importPlaylist: an empty folder is an empty page (medias null), cursor null', async () => {
  reply = () => ok({ info: info(), medias: null, has_more: false });
  const result = await importPlaylist({ playlistId: FID });
  assert.deepEqual(result.items, []);
  assert.equal(result.cursor, null);
});

test('importPlaylist: has_more gives the next cursor and the next page asks for pn 2', async () => {
  reply = (req) => (params(req).pn === '1' ? page([media(BV1)], { hasMore: true }) : page([media(BV2)], { hasMore: false }));
  const first = await importPlaylist({ playlistId: FID });
  assert.equal(first.cursor, 'v1:2:0');
  const second = await importPlaylist({ playlistId: FID, cursor: first.cursor });
  assert.equal(params(requests[1]).pn, '2');
  assert.equal(second.cursor, null);
  assert.equal(second.playlist.title, first.playlist.title, 'every page carries the playlist');
});

test('importPlaylist: has_more with an empty page ends instead of looping', async () => {
  reply = () => page([], { hasMore: true });
  assert.equal((await importPlaylist({ playlistId: FID })).cursor, null);
});

test('importPlaylist: invalid input is ParseError and sends no request', async () => {
  for (const input of [
    {},
    { playlistId: '' },
    { playlistId: 'abc' },
    { playlistId: '0' },
    { playlistId: 123 },
    { playlistId: '1'.repeat(19) },
    { playlistId: FID, cursor: '' },
    { playlistId: FID, cursor: 'token' },
    { playlistId: FID, cursor: 'v1:0:0' },
    { playlistId: FID, cursor: 'v1:2:2' },
    { playlistId: FID, cursor: 'v1:2' },
    { playlistId: FID, cursor: 'v2:2:0' },
    { playlistId: FID, cursor: 'v1:2:0:x' },
    { playlistId: FID, cursor: 'v1:2:0\n' },
    { playlistId: FID, cursor: 7 },
  ]) {
    await assert.rejects(importPlaylist(input), isError('ParseError'), JSON.stringify(input));
  }
  await assert.rejects(importPlaylist(undefined), isError('ParseError'));
  assert.equal(requests.length, 0);
});

test('importPlaylist: a response of the wrong shape is ParseError', async () => {
  reply = () => ok({ medias: [] });
  await assert.rejects(importPlaylist({ playlistId: FID }), isError('ParseError'));
  reply = () => ok({ info: { title: '' }, medias: [] });
  await assert.rejects(importPlaylist({ playlistId: FID }), isError('ParseError'));
  reply = () => ({ body: 'not json' });
  await assert.rejects(importPlaylist({ playlistId: FID }), isError('ParseError'));
  reply = () => ({ body: { code: 0, data: null } });
  await assert.rejects(importPlaylist({ playlistId: FID }), isError('ParseError'));
});

test('importPlaylist: risk-control codes and HTTP errors map as elsewhere', async () => {
  reply = () => err(-352, 'risk');
  await assert.rejects(importPlaylist({ playlistId: FID }), isError('RateLimited'));
  reply = () => ({ status: 412, body: '' });
  await assert.rejects(importPlaylist({ playlistId: FID }), isError('RateLimited'));
  reply = () => ({ status: 502, body: '' });
  await assert.rejects(importPlaylist({ playlistId: FID }), isError('NetworkError'));
  assert.equal(requests.length, 3, 'never resent');
});

// ------------------------------------------------------------------ 錯誤與私人收藏夾

test('a missing folder is NotFound; private and not signed in is AuthRequired', async () => {
  reply = () => err(-404, '啥都木有');
  await assert.rejects(importPlaylist({ playlistId: FID }), isError('NotFound'));
  reply = () => err(-403, '访问权限不足');
  await assert.rejects(importPlaylist({ playlistId: FID }), isError('AuthRequired'));
  reply = () => err(-101, '账号未登录');
  await assert.rejects(importPlaylist({ playlistId: FID }), isError('AuthRequired'));
  assert.equal(requests.length, 3, 'nobody is signed in: no resend');
});

test('private folder, signed in but the preference is off: resent once with required', async () => {
  credentials = { cookies: { SESSDATA: 's', bili_jct: 'j', DedeUserID: '1000001' } };
  preferenceOn = false;
  reply = (req, n) => (n === 1 ? err(-403, '访问权限不足') : page([media(BV1)], { hasMore: true, infoExtra: { upper: { mid: 1000001, name: '我' } } }));
  const result = await importPlaylist({ playlistId: FID });
  assert.equal(result.items.length, 1);
  assert.deepEqual(requests.map((r) => [r.auth, r.attached]), [['userPreference', false], ['required', true]]);
  assert.equal(requests[1].url, requests[0].url);
  assert.equal(result.playlist.writable, true, 'own folder, credentials attached');
  // 這一頁靠 required 讀到，下一頁也以 required 送，cursor 記著。
  assert.equal(result.cursor, 'v1:2:1');
  reply = () => page([media(BV2)]);
  await importPlaylist({ playlistId: FID, cursor: result.cursor });
  assert.equal(requests[2].auth, 'required');
  assert.equal(requests.length, 3);
});

test('private folder: -101 and -404 without credentials are resent once too', async () => {
  credentials = { cookies: { DedeUserID: '1000001' } };
  preferenceOn = false;
  for (const code of [-101, -404]) {
    requests.length = 0;
    reply = (req, n) => (n === 1 ? err(code) : page([media(BV1)]));
    assert.equal((await importPlaylist({ playlistId: FID })).items.length, 1, String(code));
    assert.deepEqual(requests.map((r) => r.auth), ['userPreference', 'required']);
  }
});

test('private folder denied again after the resend is NotFound, not resent a second time', async () => {
  credentials = { cookies: { DedeUserID: '1000001' } };
  preferenceOn = false;
  reply = () => err(-403, '访问权限不足');
  await assert.rejects(importPlaylist({ playlistId: FID }), isError('NotFound'));
  assert.deepEqual(requests.map((r) => r.auth), ['userPreference', 'required']);
});

test('denied although credentials were attached: NotFound, not resent', async () => {
  credentials = { cookies: { DedeUserID: '1000001' } };
  preferenceOn = true;
  reply = () => err(-403, '访问权限不足');
  await assert.rejects(importPlaylist({ playlistId: FID }), isError('NotFound'));
  assert.equal(requests.length, 1);
  assert.equal(requests[0].attached, true);
});

test('-101 with credentials attached is CredentialInvalid, not NotFound', async () => {
  credentials = { cookies: { DedeUserID: '1000001' } };
  reply = () => err(-101, '账号未登录');
  await assert.rejects(importPlaylist({ playlistId: FID }), isError('CredentialInvalid'));
  assert.equal(requests.length, 1);
});

test('a continuation page denied without credentials is resent once with required too', async () => {
  credentials = { cookies: { DedeUserID: '1000001' } };
  preferenceOn = false;
  reply = (req, n) => (n === 1 ? err(-403) : page([media(BV2)]));
  const result = await importPlaylist({ playlistId: FID, cursor: 'v1:2:0' });
  assert.equal(result.items.length, 1);
  assert.deepEqual(requests.map((r) => [params(r).pn, r.auth]), [['2', 'userPreference'], ['2', 'required']]);
});

test('writable: false for somebody else\'s folder read with credentials, absent without them', async () => {
  credentials = { cookies: { DedeUserID: '1000001' } };
  reply = () => page([media(BV1)]);
  assert.equal((await importPlaylist({ playlistId: FID })).playlist.writable, false);
  // 憑證沒有可用的 DedeUserID，或擁有者 mid 不是整數：判斷不了就不給。
  credentials = { cookies: { SESSDATA: 's' } };
  assert.equal('writable' in (await importPlaylist({ playlistId: FID })).playlist, false);
  credentials = { cookies: { DedeUserID: '1000001' } };
  reply = () => page([media(BV1)], { infoExtra: { upper: { name: 'x' } } });
  assert.equal('writable' in (await importPlaylist({ playlistId: FID })).playlist, false);
  // 開關關著（沒帶憑證）：不知道。
  preferenceOn = false;
  reply = () => page([media(BV1)]);
  assert.equal('writable' in (await importPlaylist({ playlistId: FID })).playlist, false);
});
