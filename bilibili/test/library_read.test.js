// libraryPlaylists（假的宿主 API，不連網）：收藏夾列表 fav/folder/created/list。
// 回應是手寫的（假 id、假標題），欄位照舊專案 bilibili_favorites_service.dart 讀的那些。
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { artwork, libraryPlaylists } from '../src/plugin.js';

let requests;
let reply; // (req, n) => {status?, body, credentialsAttached?}
let credentials;
beforeEach(() => {
  requests = [];
  credentials = { cookies: { SESSDATA: 'fake-sessdata', DedeUserID: '1234567', bili_jct: 'fake-jct' } };
  reply = () => ({ body: { code: 0, message: '0', data: { list: [], has_more: false } } });
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
        // 宿主只在已登入且 required 時帶憑證（沒登入的 required 請求宿主會先拋）。
        const attached = credentials !== null && req.auth === 'required';
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
const folder = (id, extra = {}) => ({
  id,
  fid: Math.floor(id / 100),
  mid: 1234567,
  attr: 22,
  title: `folder ${id}`,
  cover: 'http://i0.hdslb.com/bfs/archive/cover.jpg',
  media_count: 7,
  ...extra,
});

test('libraryPlaylists: maps created folders and sends the legacy request', async () => {
  reply = () => ok({ count: 2, list: [folder(4026748432), folder(4026748433, { cover: '', media_count: 0 })], has_more: false });
  const page = await libraryPlaylists({});
  assert.equal(page.cursor, null);
  assert.equal(page.playlists.length, 2);
  assert.deepEqual(page.playlists[0], {
    playlistId: '4026748432',
    title: 'folder 4026748432',
    writable: true,
    artwork: artwork('http://i0.hdslb.com/bfs/archive/cover.jpg'),
    trackCount: 7,
  });
  assert.deepEqual(page.playlists[1], { playlistId: '4026748433', title: 'folder 4026748433', writable: true, trackCount: 0 });
  assert.equal(requests.length, 1);
  const url = new URL(requests[0].url);
  assert.equal(url.origin + url.pathname, 'https://api.bilibili.com/x/v3/fav/folder/created/list');
  assert.deepEqual(params(requests[0]), { up_mid: '1234567', type: '2', pn: '1', ps: '20' });
  assert.equal(requests[0].auth, 'required');
});

test('libraryPlaylists: the playlistId is the id importPlaylist takes (full media id, not fid)', async () => {
  reply = () => ok({ list: [folder(4026748432)], has_more: false });
  const { playlists } = await libraryPlaylists({});
  assert.match(playlists[0].playlistId, /^[1-9]\d{0,17}$/);
  assert.equal(playlists[0].playlistId, '4026748432');
});

test('libraryPlaylists: paging follows has_more with an opaque cursor', async () => {
  reply = (req) =>
    params(req).pn === '1'
      ? ok({ list: [folder(11), folder(12)], has_more: true })
      : ok({ list: [folder(13)], has_more: false });
  const first = await libraryPlaylists({});
  assert.equal(first.cursor, 'v1:2');
  const second = await libraryPlaylists({ cursor: first.cursor });
  assert.equal(second.cursor, null);
  assert.deepEqual(second.playlists.map((p) => p.playlistId), ['13']);
  assert.equal(params(requests[1]).pn, '2');
});

test('libraryPlaylists: has_more with an empty page ends the listing (no empty-string or looping cursor)', async () => {
  reply = () => ok({ list: [], has_more: true });
  const page = await libraryPlaylists({});
  assert.deepEqual(page, { playlists: [], cursor: null });
});

test('libraryPlaylists: empty list', async () => {
  reply = () => ok({ count: 0, list: null, has_more: false });
  assert.deepEqual(await libraryPlaylists({}), { playlists: [], cursor: null });
  reply = () => ok({ count: 0, has_more: false });
  assert.deepEqual(await libraryPlaylists(undefined), { playlists: [], cursor: null });
});

test('libraryPlaylists: titles, ids and counts are normalised; duplicates and junk are dropped', async () => {
  reply = () =>
    ok({
      list: [
        folder(21, { title: '  padded  ' }),
        folder(21, { title: 'duplicate id' }),
        folder(22, { title: '   ' }),
        folder(23, { media_count: -1 }),
        folder(24, { media_count: 1.5 }),
        { id: 'abc', title: 'string id' },
        { id: 0, title: 'zero id' },
        null,
        'junk',
        folder(25, { cover: 'https://evil.example.com/x.jpg' }),
      ],
      has_more: false,
    });
  const { playlists } = await libraryPlaylists({});
  assert.deepEqual(playlists.map((p) => p.playlistId), ['21', '22', '23', '24', '25']);
  assert.equal(playlists[0].title, 'padded');
  assert.equal(playlists[1].title, 'ml22', 'a blank title falls back to a non-empty one');
  assert.equal('trackCount' in playlists[2], false);
  assert.equal('trackCount' in playlists[3], false);
  assert.equal('artwork' in playlists[4], false, 'artwork outside hdslb.com is dropped');
  assert.equal(new Set(playlists.map((p) => p.playlistId)).size, playlists.length);
});

test('libraryPlaylists: malformed cursor is ParseError and sends nothing', async () => {
  for (const cursor of ['', 'v1:', 'v1:0', 'v1:-1', 'v1:2:0', '2', 7, {}]) {
    await assert.rejects(libraryPlaylists({ cursor }), isError('ParseError'), JSON.stringify(cursor));
  }
  assert.equal(requests.length, 0);
});

test('libraryPlaylists: credentials without a usable DedeUserID are AuthRequired', async () => {
  for (const c of [null, {}, { cookies: {} }, { cookies: { DedeUserID: '' } }, { cookies: { DedeUserID: 'abc' } }, { cookies: { DedeUserID: '0' } }]) {
    credentials = c;
    await assert.rejects(libraryPlaylists({}), isError('AuthRequired'), JSON.stringify(c));
  }
  assert.equal(requests.length, 0);
});

test('libraryPlaylists: error mapping', async () => {
  // 帶了憑證的 -101／-111 是憑證失效（既有的判定表）。
  reply = () => err(-101, '账号未登录');
  await assert.rejects(libraryPlaylists({}), isError('CredentialInvalid'));
  reply = () => err(-111, 'csrf 校验失败');
  await assert.rejects(libraryPlaylists({}), isError('CredentialInvalid'));
  // -403 權限不足。
  reply = () => err(-403, '访问权限不足');
  await assert.rejects(libraryPlaylists({}), isError('AuthRequired'));
  // 風控。
  reply = () => err(-352, '');
  await assert.rejects(libraryPlaylists({}), isError('RateLimited'));
  reply = () => err(12345, 'other');
  await assert.rejects(libraryPlaylists({}), isError('UnexpectedError'));
  // 沒帶憑證回 -101（宿主沒附憑證的情況）：未登入。
  reply = () => ({ body: { code: -101, message: '账号未登录' }, credentialsAttached: false });
  await assert.rejects(libraryPlaylists({}), isError('AuthRequired'));
  reply = () => ({ status: 412, body: '' });
  await assert.rejects(libraryPlaylists({}), isError('RateLimited'));
  reply = () => ({ status: 502, body: '' });
  await assert.rejects(libraryPlaylists({}), isError('NetworkError'));
  reply = () => ({ body: 'not json' });
  await assert.rejects(libraryPlaylists({}), isError('ParseError'));
  reply = () => ({ body: { code: 0, message: '0', data: null } });
  await assert.rejects(libraryPlaylists({}), isError('ParseError'));
});
