// importPlaylist（假的宿主 API，不連網）：歌單詳情、其餘以 id 分批補、短網址、私人歌單的重送。
// 回應形狀照 2026-10-15 匿名實測的官方榜單歌單（見 fixtures/importPlaylist 與 README），其餘是手寫的變體。
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { importPlaylist, playlistFromUrl, search } from '../src/plugin.js';

const ID = '19723756';

// ------------------------------------------------------------------ 假宿主

let requests;
let reply; // (req, n) => {status?, url?, body}
let credentials;
let preferenceOn;
beforeEach(() => {
  requests = [];
  credentials = null;
  preferenceOn = true;
  reply = () => ({ body: { code: 200 } });
  globalThis.fmp = {
    log: { debug() {}, info() {}, warn() {} },
    credentials: { get: async () => credentials },
    http: {
      async request(req) {
        // 宿主只在已登入且（required，或 userPreference 且開關開著）時帶憑證。
        const attached = credentials !== null && (req.auth === 'required' || (req.auth === 'userPreference' && preferenceOn));
        requests.push({ ...req, attached });
        const next = reply(req, requests.length);
        const body = next.body;
        return { status: 200, headers: {}, url: req.url, credentialsAttached: attached, ...next, body: typeof body === 'string' ? body : JSON.stringify(body) };
      },
    },
  };
});

const isError = (kind) => (e) => e.fmpError === kind;
const isDetail = (req) => req.url.endsWith('/api/v6/playlist/detail');
const isSongs = (req) => req.url.endsWith('/api/v3/song/detail');
const formOf = (req) => Object.fromEntries(new URLSearchParams(req.body));
const idsOfSongRequest = (req) => JSON.parse(formOf(req).c).map((x) => x.id);

const song = (id, extra = {}) => ({
  id,
  name: `song ${id}`,
  ar: [{ id: 1, name: 'a' }, { id: 2, name: 'b' }],
  al: { id: 9, name: 'album', picUrl: `http://p1.music.126.net/${id}/a.jpg` },
  dt: 200123,
  ...extra,
});
const playlistBody = (ids, { full = ids.length, extra = {}, privileges, code = 200 } = {}) => ({
  code,
  playlist: {
    id: Number(ID),
    name: ' 飙升榜 ',
    description: '云音乐中每天热度上升最快的100首单曲，每日更新。',
    coverImgUrl: 'http://p2.music.126.net/cover/a.jpg?param=200y200',
    creator: { userId: 1, nickname: '云音乐官方' },
    trackCount: ids.length,
    trackIds: ids.map((id) => ({ id, v: 1 })),
    tracks: ids.slice(0, full).map((id) => song(id)),
    ...extra,
  },
  privileges: privileges ?? ids.slice(0, full).map((id) => ({ id, st: 0, fee: 8 })),
});
const songsBody = (ids, privileges) => ({ code: 200, songs: ids.map((id) => song(id)), privileges: privileges ?? ids.map((id) => ({ id, st: 0 })) });
const range = (from, count) => Array.from({ length: count }, (_, i) => from + i);

// ------------------------------------------------------------------ playlistFromUrl

test('playlistFromUrl: every accepted form of a playlist url', async () => {
  for (const url of [
    `https://music.163.com/#/playlist?id=${ID}`,
    `https://music.163.com/#/playlist?id=${ID}&userid=1`,
    `https://music.163.com/playlist?id=${ID}`,
    `https://music.163.com/playlist?id=${ID}&uct2=abc`,
    `https://music.163.com/m/playlist?id=${ID}`,
    `https://y.music.163.com/m/playlist?app_version=9.0&id=${ID}&dlt=0846`,
    `https://music.163.com/#/my/m/music/playlist?id=${ID}`,
    `https://music.163.com/playlist/${ID}/123456/?userid=123456`,
    `https://y.music.163.com/m/playlist/${ID}`,
    `music.163.com/#/playlist?id=${ID}`,
    `  http://MUSIC.163.com./#/playlist?id=${ID}  `,
    `https://music.163.com:443/playlist?id=${ID}`,
  ]) {
    assert.deepEqual(await playlistFromUrl({ url }), { playlistId: ID }, url);
  }
  assert.equal(requests.length, 0, 'no request for a full url');
});

test('playlistFromUrl: anything else is null, without a request', async () => {
  for (const url of [
    '',
    'not a url',
    ID,
    'https://music.163.com/',
    'https://music.163.com/#/discover',
    'https://music.163.com/#/song?id=139774',
    'https://music.163.com/song?id=139774',
    'https://music.163.com/#/playlist',
    'https://music.163.com/#/playlist?id=abc',
    'https://music.163.com/#/playlist?id=0',
    `https://music.163.com/#/album?id=${ID}`,
    `https://evil.example.com/#/playlist?id=${ID}`,
    `https://music.163.com.evil.example/playlist?id=${ID}`,
    `https://attacker.example/?u=music.163.com/playlist&id=${ID}`,
    `https://music.163.com@evil.example/playlist?id=${ID}`,
    `ftp://music.163.com/playlist?id=${ID}`,
    `https://163cn.tv.evil.example/abc`,
    `https://www.youtube.com/playlist?list=PL${ID}`,
    `https://music.163.com/playlist?id=${'9'.repeat(19)}`,
  ]) {
    assert.equal(await playlistFromUrl({ url }), null, url);
  }
  assert.equal(await playlistFromUrl({}), null);
  assert.equal(await playlistFromUrl(undefined), null);
  assert.equal(await playlistFromUrl({ url: 7 }), null);
  assert.equal(requests.length, 0);
});

test('playlistFromUrl: a 163cn.tv short url is expanded with one GET without credentials', async () => {
  reply = (req) => ({ url: `https://y.music.163.com/m/playlist?id=${ID}&app_version=9`, body: '<html></html>' });
  assert.deepEqual(await playlistFromUrl({ url: 'https://163cn.tv/AbCdEf' }), { playlistId: ID });
  assert.deepEqual(await playlistFromUrl({ url: 'http://163cn.tv/AbCdEf?x=1' }), { playlistId: ID });
  assert.equal(requests.length, 2);
  assert.equal(requests[0].url, 'https://163cn.tv/AbCdEf');
  assert.equal(requests[1].url, 'https://163cn.tv/AbCdEf?x=1', 'http is sent as https');
  assert.equal(requests[0].method, 'GET');
  assert.equal(requests[0].auth, 'never');
});

test('playlistFromUrl: a short url that lands on something else is null, a dead one is NotFound', async () => {
  reply = () => ({ url: 'https://music.163.com/#/song?id=139774', body: '' });
  assert.equal(await playlistFromUrl({ url: 'https://163cn.tv/AbCdEf' }), null);
  reply = () => ({ url: `https://evil.example.com/playlist?id=${ID}`, body: '' });
  assert.equal(await playlistFromUrl({ url: 'https://163cn.tv/AbCdEf' }), null);
  reply = (req) => ({ url: req.url, body: '' }); // 沒有轉址
  assert.equal(await playlistFromUrl({ url: 'https://163cn.tv/AbCdEf' }), null);
  reply = () => ({ status: 404, body: '' });
  await assert.rejects(playlistFromUrl({ url: 'https://163cn.tv/AbCdEf' }), isError('NotFound'));
  reply = () => ({ status: 503, body: '' });
  await assert.rejects(playlistFromUrl({ url: 'https://163cn.tv/AbCdEf' }), isError('NetworkError'));
});

// ------------------------------------------------------------------ importPlaylist

test('importPlaylist: a short playlist whose detail already has every song needs one request', async () => {
  reply = () => ({ body: playlistBody([11, 12, 13]) });
  const result = await importPlaylist({ playlistId: ID });
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, 'https://music.163.com/api/v6/playlist/detail');
  assert.equal(requests[0].method, 'POST');
  assert.deepEqual(formOf(requests[0]), { id: ID });
  assert.equal(requests[0].auth, 'userPreference');
  assert.equal(requests[0].idempotent, true);
  assert.ok(!Object.keys(requests[0].headers).some((n) => n.toLowerCase() === 'x-real-ip'), 'no X-Real-IP');
  assert.deepEqual(result.playlist, {
    title: '飙升榜',
    description: '云音乐中每天热度上升最快的100首单曲，每日更新。',
    artwork: [
      { url: 'https://p2.music.126.net/cover/a.jpg?param=120y120', width: 120 },
      { url: 'https://p2.music.126.net/cover/a.jpg?param=200y200', width: 200 },
      { url: 'https://p2.music.126.net/cover/a.jpg?param=400y400', width: 400 },
    ],
    ownerName: '云音乐官方',
  });
  assert.deepEqual(result.items.map((i) => Object.keys(i)), [['track'], ['track'], ['track']], 'no remoteItemId, no unavailable');
  assert.deepEqual(result.items[0].track, {
    sourceId: '11',
    title: 'song 11',
    uploader: 'a, b',
    durationMs: 200123,
    artwork: [
      { url: 'https://p1.music.126.net/11/a.jpg?param=120y120', width: 120 },
      { url: 'https://p1.music.126.net/11/a.jpg?param=200y200', width: 200 },
      { url: 'https://p1.music.126.net/11/a.jpg?param=400y400', width: 400 },
    ],
  });
  assert.equal(result.cursor, null);
  assert.equal(result.total, 3);
  assert.equal('writable' in result.playlist, false);
});

test('importPlaylist: tracks beyond the ones the detail gives are filled in by id in one batch, in trackIds order', async () => {
  const ids = range(100, 30);
  reply = (req) => (isDetail(req) ? { body: playlistBody(ids, { full: 10 }) } : { body: songsBody(idsOfSongRequest(req).reverse()) });
  const result = await importPlaylist({ playlistId: ID });
  assert.equal(requests.length, 2);
  assert.ok(isSongs(requests[1]));
  assert.deepEqual(idsOfSongRequest(requests[1]), range(110, 20), 'only the missing ids');
  assert.equal(requests[1].auth, 'userPreference');
  assert.equal(requests[1].idempotent, true);
  assert.deepEqual(result.items.map((i) => i.track.sourceId), ids.map(String), 'trackIds order, whatever order the batch came back in');
  assert.equal(result.cursor, null);
  assert.equal(result.total, 30);
});

test('importPlaylist: a long playlist pages by 400 ids; every page re-reads the detail', async () => {
  const ids = range(1, 900);
  reply = (req) => (isDetail(req) ? { body: playlistBody(ids, { full: 10 }) } : { body: songsBody(idsOfSongRequest(req)) });
  const first = await importPlaylist({ playlistId: ID });
  assert.equal(first.items.length, 400);
  assert.equal(first.cursor, 'v1:400:0');
  assert.equal(first.total, 900);
  assert.deepEqual(idsOfSongRequest(requests[1]), range(11, 390));
  const second = await importPlaylist({ playlistId: ID, cursor: first.cursor });
  assert.deepEqual(second.items.map((i) => i.track.sourceId).slice(0, 2), ['401', '402']);
  assert.equal(second.cursor, 'v1:800:0');
  assert.deepEqual(idsOfSongRequest(requests[3]), range(401, 400));
  const third = await importPlaylist({ playlistId: ID, cursor: second.cursor });
  assert.equal(third.items.length, 100);
  assert.equal(third.cursor, null);
  assert.deepEqual(second.playlist, first.playlist, 'every page carries the playlist');
  assert.equal(requests.length, 6);
});

test('importPlaylist: exactly 400 or 800 ids end on a full page, with no empty page after it', async () => {
  for (const count of [400, 800]) {
    const ids = range(1, count);
    reply = (req) => (isDetail(req) ? { body: playlistBody(ids, { full: 10 }) } : { body: songsBody(idsOfSongRequest(req)) });
    let page = await importPlaylist({ playlistId: ID });
    let pages = 1;
    while (page.cursor !== null) {
      page = await importPlaylist({ playlistId: ID, cursor: page.cursor });
      pages++;
    }
    assert.equal(pages, count / 400, String(count));
    assert.equal(page.items.length, 400, String(count));
  }
});

test('importPlaylist: an empty playlist is an empty page with total 0', async () => {
  reply = () => ({ body: playlistBody([]) });
  const result = await importPlaylist({ playlistId: ID });
  assert.deepEqual(result.items, []);
  assert.equal(result.cursor, null);
  assert.equal(result.total, 0);
});

test('importPlaylist: songs without copyright (privilege st -200) are unavailable, others are not', async () => {
  reply = (req) => (isDetail(req)
    ? { body: playlistBody([1, 2, 3, 4], { full: 1, privileges: [{ id: 1, st: -200 }] }) }
    : { body: songsBody([2, 3, 4], [{ id: 2, st: 0 }, { id: 3, st: -200, fee: 1 }, { id: 4, st: -100 }]) });
  const result = await importPlaylist({ playlistId: ID });
  // st -100 是匿名時多數歌都有的值（實測的榜單 100 首裡 77 首），不是失效。
  assert.deepEqual(result.items.map((i) => [i.track.sourceId, i.unavailable]), [['1', true], ['2', undefined], ['3', true], ['4', undefined]]);
});

test('importPlaylist: a song the batch does not return is left out, and total then exceeds the items', async () => {
  reply = (req) => (isDetail(req) ? { body: playlistBody([1, 2, 3], { full: 1 }) } : { body: songsBody([3]) });
  const result = await importPlaylist({ playlistId: ID });
  assert.deepEqual(result.items.map((i) => i.track.sourceId), ['1', '3']);
  assert.equal(result.total, 3);
});

test('importPlaylist: track fields follow search (Unknown title, null artists and duration, no foreign artwork)', async () => {
  reply = () => ({
    body: playlistBody([5], { extra: { tracks: [{ id: 5, name: '', ar: [], al: { picUrl: 'https://evil.example.com/a.jpg' } }], description: null, creator: null, coverImgUrl: 'https://evil.example.com/c.jpg' } }),
  });
  const result = await importPlaylist({ playlistId: ID });
  assert.deepEqual(result.items[0].track, { sourceId: '5', title: 'Unknown', uploader: null, durationMs: null, artwork: [] });
  assert.deepEqual(result.playlist, { title: '飙升榜' });
  // 同一個映射：search 對同樣的歌給同樣的曲目。
  reply = () => ({ body: { code: 200, result: { songs: [song(11)], songCount: 1 } } });
  const searched = await search({ keyword: 'x', page: 1 });
  reply = () => ({ body: playlistBody([11]) });
  assert.deepEqual((await importPlaylist({ playlistId: ID })).items[0].track, searched.items[0]);
});

test('importPlaylist: invalid input is ParseError and sends no request', async () => {
  for (const input of [
    {},
    { playlistId: '' },
    { playlistId: 'abc' },
    { playlistId: '0' },
    { playlistId: 123 },
    { playlistId: '1'.repeat(19) },
    { playlistId: ID, cursor: '' },
    { playlistId: ID, cursor: 'token' },
    { playlistId: ID, cursor: 'v1:200:0' },
    { playlistId: ID, cursor: 'v1:-400:0' },
    { playlistId: ID, cursor: 'v1:400:2' },
    { playlistId: ID, cursor: 'v1:400' },
    { playlistId: ID, cursor: 'v2:400:0' },
    { playlistId: ID, cursor: 'v1:400:0\n' },
    { playlistId: ID, cursor: 'v1:0400:0' },
    { playlistId: ID, cursor: 400 },
  ]) {
    await assert.rejects(importPlaylist(input), isError('ParseError'), JSON.stringify(input));
  }
  await assert.rejects(importPlaylist(undefined), isError('ParseError'));
  assert.equal(requests.length, 0);
});

test('importPlaylist: a cursor past the end gives an empty last page', async () => {
  reply = () => ({ body: playlistBody([1, 2]) });
  const result = await importPlaylist({ playlistId: ID, cursor: 'v1:400:0' });
  assert.deepEqual(result.items, []);
  assert.equal(result.cursor, null);
});

test('importPlaylist: a response of the wrong shape is ParseError', async () => {
  reply = () => ({ body: playlistBody([1], { extra: { name: '' } }) });
  await assert.rejects(importPlaylist({ playlistId: ID }), isError('ParseError'));
  reply = () => ({ body: playlistBody([1], { extra: { trackIds: undefined } }) });
  await assert.rejects(importPlaylist({ playlistId: ID }), isError('ParseError'));
  reply = () => ({ body: playlistBody([1], { extra: { trackIds: [{ id: 'x' }] } }) });
  await assert.rejects(importPlaylist({ playlistId: ID }), isError('ParseError'));
  reply = () => ({ body: 'not json' });
  await assert.rejects(importPlaylist({ playlistId: ID }), isError('ParseError'));
  reply = (req) => (isDetail(req) ? { body: playlistBody([1], { full: 0 }) } : { body: { code: 200, songs: 'x' } });
  // song/detail 的 songs 不是陣列：這一批當作沒有歌曲。
  assert.deepEqual((await importPlaylist({ playlistId: ID })).items, []);
});

test('importPlaylist: risk control and HTTP errors map as elsewhere, and are not resent', async () => {
  reply = () => ({ body: { code: -460, message: 'cheating' } });
  await assert.rejects(importPlaylist({ playlistId: ID }), isError('VerificationRequired'));
  reply = () => ({ status: 460, body: '' });
  await assert.rejects(importPlaylist({ playlistId: ID }), isError('VerificationRequired'));
  reply = () => ({ status: 502, body: '' });
  await assert.rejects(importPlaylist({ playlistId: ID }), isError('NetworkError'));
  reply = () => ({ body: { code: 500, msg: 'oops' } });
  await assert.rejects(importPlaylist({ playlistId: ID }), isError('UnexpectedError'));
  // song/detail 的失敗讓這一頁失敗。
  reply = (req) => (isDetail(req) ? { body: playlistBody([1, 2], { full: 1 }) } : { body: { code: -460 } });
  await assert.rejects(importPlaylist({ playlistId: ID }), isError('VerificationRequired'));
  assert.equal(requests.length, 6);
});

// ------------------------------------------------------------------ 錯誤與私人歌單

test('a missing playlist is NotFound; a code that asks for a login is AuthRequired when signed out', async () => {
  reply = () => ({ body: { code: 404, msg: '歌单不存在' } });
  await assert.rejects(importPlaylist({ playlistId: ID }), isError('NotFound'));
  reply = () => ({ body: { code: 200 } }); // 沒有 playlist
  await assert.rejects(importPlaylist({ playlistId: ID }), isError('NotFound'));
  for (const code of [301, 401, 403]) {
    reply = () => ({ body: { code } });
    await assert.rejects(importPlaylist({ playlistId: ID }), isError('AuthRequired'), String(code));
  }
  assert.equal(requests.length, 5, 'nobody is signed in: no resend');
});

test('private playlist, signed in but the preference is off: resent once with required, and later pages follow', async () => {
  credentials = { cookies: { MUSIC_U: 'fake' } };
  preferenceOn = false;
  const ids = range(1, 500);
  reply = (req, n) => (isDetail(req)
    ? (n === 1 ? { body: { code: 404 } } : { body: playlistBody(ids, { full: 10 }) })
    : { body: songsBody(idsOfSongRequest(req)) });
  const first = await importPlaylist({ playlistId: ID });
  assert.equal(first.items.length, 400);
  assert.deepEqual(requests.map((r) => [isDetail(r) ? 'detail' : 'songs', r.auth, r.attached]), [
    ['detail', 'userPreference', false],
    ['detail', 'required', true],
    ['songs', 'userPreference', false],
  ]);
  assert.equal(requests[1].body, requests[0].body);
  assert.equal(first.cursor, 'v1:400:1');
  await importPlaylist({ playlistId: ID, cursor: first.cursor });
  assert.equal(requests[3].auth, 'required');
});

test('private playlist: 401, 403 and 301 without credentials are resent once too', async () => {
  credentials = { cookies: { MUSIC_U: 'fake' } };
  preferenceOn = false;
  for (const code of [301, 401, 403]) {
    requests.length = 0;
    reply = (req, n) => (n === 1 ? { body: { code } } : { body: playlistBody([1]) });
    assert.equal((await importPlaylist({ playlistId: ID })).items.length, 1, String(code));
    assert.deepEqual(requests.map((r) => r.auth), ['userPreference', 'required']);
  }
});

test('private playlist denied again after the resend is NotFound, not resent a second time', async () => {
  credentials = { cookies: { MUSIC_U: 'fake' } };
  preferenceOn = false;
  reply = () => ({ body: { code: 404 } });
  await assert.rejects(importPlaylist({ playlistId: ID }), isError('NotFound'));
  assert.deepEqual(requests.map((r) => r.auth), ['userPreference', 'required']);
});

test('denied although credentials were attached: NotFound, not resent', async () => {
  credentials = { cookies: { MUSIC_U: 'fake' } };
  reply = () => ({ body: { code: 403 } });
  await assert.rejects(importPlaylist({ playlistId: ID }), isError('NotFound'));
  assert.equal(requests.length, 1);
  assert.equal(requests[0].attached, true);
});

test('301 with credentials attached is CredentialInvalid, not NotFound', async () => {
  credentials = { cookies: { MUSIC_U: 'fake' } };
  reply = () => ({ body: { code: 301, message: 'not logged in' } });
  await assert.rejects(importPlaylist({ playlistId: ID }), isError('CredentialInvalid'));
  assert.equal(requests.length, 1);
});

test('a continuation page denied without credentials is resent once with required too', async () => {
  credentials = { cookies: { MUSIC_U: 'fake' } };
  preferenceOn = false;
  reply = (req, n) => (n === 1 ? { body: { code: 403 } } : { body: playlistBody([1, 2]) });
  const result = await importPlaylist({ playlistId: ID, cursor: 'v1:0:0' });
  assert.equal(result.items.length, 2);
  assert.deepEqual(requests.map((r) => r.auth), ['userPreference', 'required']);
});
