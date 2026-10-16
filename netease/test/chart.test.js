// charts：官方熱歌榜（歌單 3778678，前 50 首）。假的宿主 API，不連網；回應形狀同 importPlaylist 的測試
// （api/v6/playlist/detail 加 api/v3/song/detail），其餘是手寫的變體。
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { chart, chartList } from '../src/plugin.js';

let requests;
let reply;
beforeEach(() => {
  requests = [];
  reply = () => ({ body: { code: 200 } });
  globalThis.fmp = {
    log: { debug() {}, info() {}, warn() {} },
    credentials: { get: async () => null },
    http: {
      async request(req) {
        requests.push(req);
        const next = reply(req, requests.length);
        const body = next.body;
        return { status: 200, headers: {}, url: req.url, credentialsAttached: false, ...next, body: typeof body === 'string' ? body : JSON.stringify(body) };
      },
    },
  };
});

const isError = (kind) => (e) => e.fmpError === kind;
const isDetail = (req) => req.url.endsWith('/api/v6/playlist/detail');
const isSongs = (req) => req.url.endsWith('/api/v3/song/detail');
const formOf = (req) => Object.fromEntries(new URLSearchParams(req.body));
const idsOfSongRequest = (req) => JSON.parse(formOf(req).c).map((x) => x.id);
const range = (from, count) => Array.from({ length: count }, (_, i) => from + i);

const song = (id, extra = {}) => ({
  id,
  name: `song ${id}`,
  ar: [{ id: 1, name: 'a' }, { id: 2, name: 'b' }],
  al: { id: 9, name: 'album', picUrl: `http://p1.music.126.net/${id}/a.jpg` },
  dt: 200123,
  ...extra,
});
// ids：榜單全部的 trackIds；full：詳情自帶完整資料的前幾首。
const detailBody = (ids, { full = 10, playlist = {} } = {}) => ({
  code: 200,
  playlist: { id: 3778678, name: '云音乐热歌榜', trackIds: ids.map((id) => ({ id, v: 1 })), tracks: ids.slice(0, full).map((id) => song(id)), ...playlist },
  privileges: ids.slice(0, full).map((id) => ({ id, st: 0 })),
});
const songsBody = (ids) => ({ code: 200, songs: ids.map((id) => song(id)), privileges: ids.map((id) => ({ id, st: 0 })) });

test('chartList: one fixed chart', () => {
  assert.deepEqual(chartList(), { charts: [{ chartId: 'hot', title: '熱歌榜' }] });
});

test('chart: first 50 of the playlist, the rest filled in by one song/detail batch, in playlist order', async () => {
  const ids = range(1000, 100);
  reply = (req) => (isDetail(req) ? { body: detailBody(ids) } : { body: songsBody(idsOfSongRequest(req).reverse()) });
  const { tracks } = await chart({ chartId: 'hot' });
  assert.deepEqual(tracks.map((t) => t.sourceId), range(1000, 50).map(String));
  assert.deepEqual(tracks[0], {
    sourceId: '1000',
    title: 'song 1000',
    uploader: 'a, b',
    durationMs: 200123,
    artwork: [120, 200, 400].map((size) => ({ url: `https://p1.music.126.net/1000/a.jpg?param=${size}y${size}`, width: size })),
  });
  assert.equal(requests.length, 2);
  assert.ok(isDetail(requests[0]));
  assert.equal(formOf(requests[0]).id, '3778678');
  assert.ok(isSongs(requests[1]));
  assert.deepEqual(idsOfSongRequest(requests[1]), range(1010, 40), 'only the ones the detail did not carry');
  for (const req of requests) {
    assert.equal(req.method, 'POST');
    assert.equal(req.auth, 'userPreference');
    assert.equal(req.idempotent, true);
    assert.equal(req.headers['X-Real-IP'], undefined, 'the mainland address is only for resolveStream');
  }
});

test('chart: a playlist whose detail already carries every wanted song needs one request', async () => {
  reply = () => ({ body: detailBody(range(1, 8), { full: 8 }) });
  const { tracks } = await chart({ chartId: 'hot' });
  assert.equal(tracks.length, 8);
  assert.equal(requests.length, 1);
});

test('chart: a song the batch does not return is left out', async () => {
  reply = (req) => (isDetail(req) ? { body: detailBody(range(1, 12), { full: 10 }) } : { body: songsBody([11]) });
  const { tracks } = await chart({ chartId: 'hot' });
  assert.deepEqual(tracks.map((t) => t.sourceId), [...range(1, 11)].map(String));
});

test('chart: an empty playlist is an empty chart', async () => {
  reply = () => ({ body: detailBody([]) });
  assert.deepEqual(await chart({ chartId: 'hot' }), { tracks: [] });
  assert.equal(requests.length, 1);
});

test('chart: wrong shapes are ParseError, error codes map as elsewhere', async () => {
  for (const body of [{ code: 200 }, { code: 200, playlist: {} }, detailBody([1, 2], { playlist: { trackIds: [{ id: 'x' }] } })]) {
    reply = () => ({ body });
    await assert.rejects(chart({ chartId: 'hot' }), isError('ParseError'));
  }
  reply = () => ({ body: { code: -460, message: 'Cheating' } });
  await assert.rejects(chart({ chartId: 'hot' }), isError('VerificationRequired'));
  reply = () => ({ status: 502, body: '' });
  await assert.rejects(chart({ chartId: 'hot' }), isError('NetworkError'));
});

test('chart: unknown chartId is NotFound and sends no request', async () => {
  await assert.rejects(chart({ chartId: 'nope' }), isError('NotFound'));
  assert.equal(requests.length, 0);
});

test('chart: maps the recorded hot list (fixtures/charts: detail, then one song/detail batch)', async () => {
  const recorded = (n) => JSON.parse(readFileSync(new URL(`../fixtures/charts/00${n}.json`, import.meta.url), 'utf8')).response.jsonBody;
  const detail = recorded(1);
  reply = (req) => ({ body: isDetail(req) ? detail : recorded(2) });
  const { tracks } = await chart({ chartId: 'hot' });
  assert.deepEqual(tracks.map((t) => t.sourceId), detail.playlist.trackIds.slice(0, 50).map((t) => String(t.id)));
  assert.equal(requests.length, 2);
  for (const t of tracks) {
    assert.ok(t.title !== '' && t.uploader !== null && t.durationMs > 0 && t.artwork.length === 3, t.sourceId);
  }
});
