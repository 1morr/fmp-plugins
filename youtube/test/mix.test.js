// mix：整條路徑（YouTube.js session 在內）宿主以假回應模擬，不連網；/next 的回應是照 innertube 形狀手寫的。
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { mixRequest, parseMixResponse } from '../src/mix.js';

const bundle = await build({
  entryPoints: [fileURLToPath(new URL('../src/plugin.js', import.meta.url))],
  bundle: true,
  format: 'esm',
  platform: 'neutral',
  mainFields: ['module', 'main'],
  conditions: ['import', 'default'],
  target: 'es2020',
  write: false,
  logLevel: 'warning',
});
const { mix } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`);

const fixture = (n) => JSON.parse(readFileSync(new URL(`../fixtures/resolveStream/00${n}.json`, import.meta.url), 'utf8')).response;
const bodyOf = (r) => (r.body !== undefined ? r.body : JSON.stringify(r.jsonBody));

const panelVideo = (id, extra = {}) => ({
  playlistPanelVideoRenderer: {
    videoId: id,
    title: { runs: [{ text: `title ${id}` }] },
    shortBylineText: { runs: [{ text: `uploader ${id}` }] },
    lengthText: { simpleText: '3:33' },
    thumbnail: {
      thumbnails: [
        { url: `https://i.ytimg.com/vi/${id}/default.jpg`, width: 120, height: 90 },
        { url: 'https://evil.example.com/x.jpg', width: 1, height: 1 },
      ],
    },
    ...extra,
  },
});
const ids = (n, from = 0) => Array.from({ length: n }, (_, i) => `vid${String(from + i).padStart(8, '0')}`);
const seedResponse = (videos, continuation) => ({
  contents: {
    twoColumnWatchNextResults: {
      playlist: {
        playlist: {
          title: 'Mix - Rick Astley',
          playlistId: 'RDdQw4w9WgXcQ',
          isInfinite: true,
          contents: videos,
          ...(continuation ? { continuations: [{ nextRadioContinuationData: { continuation } }] } : {}),
        },
      },
    },
  },
});

const recorded = JSON.parse(readFileSync(new URL('../fixtures/mix/003.json', import.meta.url), 'utf8')).response;
const recordedBody = recorded.body !== undefined ? recorded.body : JSON.stringify(recorded.jsonBody);
const recordedIds = JSON.parse(recordedBody).contents.twoColumnWatchNextResults.playlist.playlist.contents.map((c) => c.playlistPanelVideoRenderer.videoId);

// 沒有 continuations 的視窗：第 from 首起 n 首，目前這首是第一首。
const windowResponse = (vids, currentIndex, extra = {}) => {
  const r = seedResponse(vids.map((id, i) => panelVideo(id, i === 0 ? { selected: true } : {})), null);
  Object.assign(r.contents.twoColumnWatchNextResults.playlist.playlist, { currentIndex, isInfinite: true }, extra);
  return r;
};

let nexts;
let nextReply;
beforeEach(() => {
  nexts = [];
  nextReply = () => ({ status: 200, body: JSON.stringify(seedResponse(ids(3).map((i) => panelVideo(i)), null)) });
  const store = new Map();
  globalThis.fmp = {
    http: {
      request: async (r) => {
        const reply = (body, status = 200) => ({ status, url: r.url, headers: {}, body, credentialsAttached: r.auth === 'userPreference' });
        if (r.url.includes('/sw.js_data')) return reply(bodyOf(fixture(1)));
        if (r.url.includes('/youtubei/v1/config')) return reply(bodyOf(fixture(2)));
        if (r.url.includes('/youtubei/v1/next')) {
          nexts.push({ body: JSON.parse(r.body), idempotent: r.idempotent, auth: r.auth });
          const { status, body } = nextReply(nexts.length);
          return reply(body, status);
        }
        return { status: 404, url: r.url, headers: {}, body: '' };
      },
    },
    storage: { get: async (k) => store.get(k) ?? null, set: async (k, v) => { store.set(k, v); }, delete: async (k) => { store.delete(k); } },
    credentials: { get: async () => ({ cookies: { SAPISID: 'fake-sapisid' } }) },
    log: { debug() {}, info() {}, warn() {}, error() {} },
  };
});

test('mix: seed starts RD<videoId> and returns the first batch with a cursor', async () => {
  const batch = await mix({ seed: { sourceId: 'dQw4w9WgXcQ' } });
  assert.equal(batch.mixId, 'RDdQw4w9WgXcQ');
  assert.equal(batch.title, 'Mix - Rick Astley');
  assert.equal(batch.cursor, `v1:${ids(3)[2]}:2`);
  assert.deepEqual(batch.tracks[0], {
    sourceId: ids(3)[0],
    title: `title ${ids(3)[0]}`,
    uploader: `uploader ${ids(3)[0]}`,
    durationMs: 213000,
    artwork: [{ url: `https://i.ytimg.com/vi/${ids(3)[0]}/default.jpg`, width: 120 }],
  });
  assert.equal(batch.tracks.length, 3);
  assert.equal(nexts.length, 1);
  assert.equal(nexts[0].body.videoId, 'dQw4w9WgXcQ');
  assert.equal(nexts[0].body.playlistId, 'RDdQw4w9WgXcQ');
  assert.equal(nexts[0].body.context.client.clientName, 'WEB');
  assert.equal(nexts[0].idempotent, true);
  // WEB client：已登入時由宿主決定帶不帶憑證，與 search 同樣標 userPreference。
  assert.equal(nexts[0].auth, 'userPreference');
});

test('mix: seed without a Mix playlist is NotFound', async () => {
  nextReply = () => ({ status: 200, body: JSON.stringify({ contents: { twoColumnWatchNextResults: {} } }) });
  await assert.rejects(mix({ seed: { sourceId: 'dQw4w9WgXcQ' } }), (e) => e.fmpError === 'NotFound');
});

test('mix: a response of the wrong shape is ParseError', async () => {
  nextReply = () => ({ status: 200, body: JSON.stringify({ responseContext: {} }) });
  await assert.rejects(mix({ seed: { sourceId: 'dQw4w9WgXcQ' } }), (e) => e.fmpError === 'ParseError');
  await assert.rejects(mix({ mixId: 'RDdQw4w9WgXcQ', cursor: 'v1:lastlastlas:24' }), (e) => e.fmpError === 'ParseError');
  assert.equal(nexts.length, 2);
});

test('mix: invalid input is ParseError and sends no request', async () => {
  await assert.rejects(mix({ seed: { sourceId: 'bad id' } }), (e) => e.fmpError === 'ParseError');
  await assert.rejects(mix({ mixId: 'PLabc', cursor: 'T' }), (e) => e.fmpError === 'ParseError');
  await assert.rejects(mix({ mixId: 'RDdQw4w9WgXcQ', cursor: '' }), (e) => e.fmpError === 'ParseError');
  assert.equal(nexts.length, 0);
});

test('mix: an HTTP 4xx rejects like search does (YouTube.js throws, the host maps it)', async () => {
  nextReply = () => ({ status: 400, body: JSON.stringify({ error: { status: 'INVALID_ARGUMENT', message: 'bad' } }) });
  await assert.rejects(mix({ seed: { sourceId: 'dQw4w9WgXcQ' } }), /status code 400/);
});

test('parseMixResponse: no duplicates within a batch, wrapper items unwrapped, live and junk items skipped', () => {
  const live = panelVideo('liveliveliv', { lengthText: undefined });
  const wrapped = { playlistPanelVideoWrapperRenderer: { primaryRenderer: panelVideo('wrapwrapwrap') } };
  const data = seedResponse([panelVideo('aaaaaaaaaaa'), panelVideo('aaaaaaaaaaa'), wrapped, live, { automixPreviewVideoRenderer: {} }, null, panelVideo('bbbbbbbbbbb')], null);
  const { tracks, cursor } = parseMixResponse(data, {});
  assert.deepEqual(tracks.map((t) => t.sourceId), ['aaaaaaaaaaa', 'wrapwrapwrap', 'bbbbbbbbbbb']);
  assert.equal(cursor, 'v1:bbbbbbbbbbb:6'); // 跳過的項目也佔索引
});

test('parseMixResponse: durations over an hour, missing artwork and uploader', () => {
  const v = panelVideo('longlonglon', { lengthText: { simpleText: '1:02:03' }, shortBylineText: undefined, thumbnail: undefined });
  const { tracks } = parseMixResponse(seedResponse([v], null), {});
  assert.equal(tracks[0].durationMs, 3723000);
  assert.equal(tracks[0].uploader, null);
  assert.deepEqual(tracks[0].artwork, []);
});

test('parseMixResponse: a seed Mix with no playable track is NotFound', () => {
  assert.throws(() => parseMixResponse(seedResponse([panelVideo('liveliveliv', { lengthText: undefined })], null), {}), (e) => e.fmpError === 'NotFound');
});

test('mix: the recorded anonymous response has no continuations, so the own cursor is used', async () => {
  nextReply = () => ({ status: 200, body: recordedBody });
  const batch = await mix({ seed: { sourceId: 'dQw4w9WgXcQ' } });
  assert.equal(batch.mixId, 'RDdQw4w9WgXcQ');
  assert.ok(batch.tracks.length >= 20);
  assert.equal(new Set(batch.tracks.map((t) => t.sourceId)).size, batch.tracks.length);
  const last = batch.tracks[batch.tracks.length - 1].sourceId;
  assert.equal(last, recordedIds[recordedIds.length - 1]);
  assert.equal(batch.cursor, `v1:${last}:${recordedIds.length - 1}`);
  for (const key of ['sourceId', 'title', 'uploader', 'durationMs', 'artwork']) {
    assert.ok(batch.tracks.every((t) => t[key] && (!Array.isArray(t[key]) || t[key].length > 0)), key);
  }
});

test('mix: own cursor continues with /next {videoId: last, playlistId, playlistIndex} and drops the overlap', async () => {
  const win = ['lastlastlas', 'newnewnew001', 'newnewnew002'];
  nextReply = () => ({ status: 200, body: JSON.stringify(windowResponse(win, 24)) });
  const batch = await mix({ mixId: 'RDdQw4w9WgXcQ', cursor: 'v1:lastlastlas:24' });
  assert.deepEqual(nexts[0].body.videoId, 'lastlastlas');
  assert.equal(nexts[0].body.playlistId, 'RDdQw4w9WgXcQ');
  assert.equal(nexts[0].body.playlistIndex, 24);
  assert.equal(nexts[0].body.continuation, undefined);
  assert.equal(batch.mixId, 'RDdQw4w9WgXcQ');
  assert.equal(batch.title, 'Mix - Rick Astley');
  assert.deepEqual(batch.tracks.map((t) => t.sourceId), ['newnewnew001', 'newnewnew002']);
  assert.equal(batch.cursor, 'v1:newnewnew002:26');
});

test('mix: own cursor keeps every item when the last video is not in the window', async () => {
  nextReply = () => ({ status: 200, body: JSON.stringify(windowResponse(['aaaaaaaaaaa', 'bbbbbbbbbbb'], 5)) });
  const batch = await mix({ mixId: 'RDdQw4w9WgXcQ', cursor: 'v1:zzzzzzzzzzz:4' });
  assert.deepEqual(batch.tracks.map((t) => t.sourceId), ['aaaaaaaaaaa', 'bbbbbbbbbbb']);
});

test('mix: own cursor with nothing new is an empty batch and cursor null', async () => {
  nextReply = () => ({ status: 200, body: JSON.stringify(windowResponse(['lastlastlas'], 24)) });
  const batch = await mix({ mixId: 'RDdQw4w9WgXcQ', cursor: 'v1:lastlastlas:24' });
  assert.deepEqual(batch.tracks, []);
  assert.equal(batch.cursor, null);
});

test('mix: a malformed own cursor is ParseError and sends no request', async () => {
  for (const cursor of ['v1:', 'v1:short:3', 'v1:lastlastlas', 'v1:lastlastlas:x', 'v1:lastlastlas:24:9']) {
    await assert.rejects(mix({ mixId: 'RDdQw4w9WgXcQ', cursor }), (e) => e.fmpError === 'ParseError', cursor);
  }
  assert.equal(nexts.length, 0);
});

test('mix: YouTube continuations in a response are ignored; the cursor is always the own one', async () => {
  nextReply = () => ({ status: 200, body: JSON.stringify(seedResponse([panelVideo('aaaaaaaaaaa')], 'TOKEN9')) });
  const batch = await mix({ seed: { sourceId: 'dQw4w9WgXcQ' } });
  assert.equal(batch.cursor, 'v1:aaaaaaaaaaa:0');
});

test('mix: a continuation whose response has no playlist is an empty batch with cursor null, so the host reseeds', async () => {
  nextReply = () => ({ status: 200, body: JSON.stringify({ contents: { twoColumnWatchNextResults: {} } }) });
  const batch = await mix({ mixId: 'RDdQw4w9WgXcQ', cursor: 'v1:lastlastlas:24' });
  assert.deepEqual(batch, { mixId: 'RDdQw4w9WgXcQ', title: 'Mix', tracks: [], cursor: null });
  assert.equal(nexts.length, 1);
});

test('mix: a cursor that is not the plugin v1 format (YouTube token, other version) is ParseError and sends no request', async () => {
  for (const cursor of ['v2:lastlastlas:24', 'v10:x', 'TOKEN1', '4qmFsgJhEhNWTHdhdGNoX3BhZ2U']) {
    await assert.rejects(mix({ mixId: 'RDdQw4w9WgXcQ', cursor }), (e) => e.fmpError === 'ParseError', cursor);
  }
  assert.equal(nexts.length, 0);
});

test('parseMixResponse: a wrapped selected item anchors the window index', () => {
  const wrappedSelected = { playlistPanelVideoWrapperRenderer: { primaryRenderer: panelVideo('ccccccccccc', { selected: true }) } };
  const data = seedResponse([panelVideo('aaaaaaaaaaa'), panelVideo('bbbbbbbbbbb'), wrappedSelected, panelVideo('ddddddddddd')], null);
  data.contents.twoColumnWatchNextResults.playlist.playlist.currentIndex = 10;
  // 目前這首（第 2 項）是索引 10，所以最後一項是 11。
  assert.equal(parseMixResponse(data, {}).cursor, 'v1:ddddddddddd:11');
});

test('parseMixResponse: every own cursor it emits parses back; an index out of range gives no cursor', () => {
  // currentIndex 缺、目前這首在第 3 項：算出的索引是負的，不能產生解析不回來的 cursor。
  const negative = seedResponse([panelVideo('aaaaaaaaaaa'), panelVideo('liveliveliv', { lengthText: undefined }), panelVideo('xxxxxxxxxxx', { lengthText: undefined }), panelVideo('ccccccccccc', { selected: true, lengthText: undefined })], null);
  assert.equal(parseMixResponse(negative, {}).cursor, null);
  const huge = windowResponse(['aaaaaaaaaaa', 'bbbbbbbbbbb'], 999999);
  assert.equal(parseMixResponse(huge, {}).cursor, null);
  const edge = windowResponse(['aaaaaaaaaaa', 'bbbbbbbbbbb'], 999998);
  const { cursor } = parseMixResponse(edge, {});
  assert.equal(cursor, 'v1:bbbbbbbbbbb:999999');
  assert.equal(mixRequest({ mixId: 'RDdQw4w9WgXcQ', cursor }).body.playlistIndex, 999999);
});

test('parseMixResponse: artwork is filtered with the same host check as search', () => {
  const v = panelVideo('aaaaaaaaaaa', {
    thumbnail: {
      thumbnails: [
        { url: 'https://i.ytimg.com/vi/a/1.jpg', width: 120 },
        { url: 'https://i.ytimg.com:abc/vi/a/2.jpg', width: 120 },
        { url: 'http://i.ytimg.com/vi/a/3.jpg', width: 120 },
        { url: 'https://ytimg.com.evil.example/vi/a/4.jpg', width: 120 },
      ],
    },
  });
  const { tracks } = parseMixResponse(seedResponse([v], null), {});
  assert.deepEqual(tracks[0].artwork.map((a) => a.url), ['https://i.ytimg.com/vi/a/1.jpg']);
});
