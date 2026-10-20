// createPlaylist／addToPlaylist／removeFromPlaylist：整條路徑（YouTube.js session 在內）宿主以假回應模擬，不連網。
// 回應是手寫的：形狀照舊版 youtube_playlist_service.dart 認的（playlistVideoRenderer 的 videoId、setVideoId，
// edit_playlist 的 STATUS_SUCCEEDED），新版面（lockupViewModel）的 setVideoId 位置是推測，未驗證，見 README。
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

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
const { addToPlaylist, createPlaylist, removeFromPlaylist } = await import(
  `data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`
);

const read = (path) => JSON.parse(readFileSync(new URL(path, import.meta.url), 'utf8'));
const fixture = (n) => read(`../fixtures/resolveStream/00${n}.json`).response;
const bodyOf = (r) => (r.body !== undefined ? r.body : JSON.stringify(r.jsonBody));

const PL = 'PLfmpTestFakePlaylistId000000000001';
const V1 = 'aaaaaaaaaa1';
const V2 = 'aaaaaaaaaa2';
const V3 = 'aaaaaaaaaa3';

const row = (videoId, setVideoId) => ({ playlistVideoRenderer: { videoId, setVideoId, lengthSeconds: '100', isPlayable: true } });
const token = (t) => ({ continuationItemRenderer: { continuationEndpoint: { continuationCommand: { token: t, request: 'CONTINUATION_REQUEST_TYPE_BROWSE' } } } });
const firstPage = (items) => ({
  contents: {
    twoColumnBrowseResultsRenderer: {
      tabs: [{ tabRenderer: { content: { sectionListRenderer: { contents: [{ itemSectionRenderer: { contents: [{ playlistVideoListRenderer: { contents: items } }] } }] } } } }],
    },
  },
});
const nextPage = (items) => ({ onResponseReceivedActions: [{ appendContinuationItemsAction: { continuationItems: items } }] });
const lockupRow = (videoId, setVideoId) => ({
  lockupViewModel: {
    contentId: videoId,
    contentType: 'LOCKUP_CONTENT_TYPE_VIDEO',
    metadata: { lockupMetadataViewModel: { menuButton: { menu: [{ playlistEditEndpoint: { actions: [{ action: 'ACTION_REMOVE_VIDEO', setVideoId }] } }] } } },
  },
});

let calls; // browse／edit_playlist／playlist/create 的請求（解析過 body）
let browseReply; // (body, n) => {status?, body}
let editReply; // (body, n) => {status?, body}
let createReply;
let credentials;
beforeEach(() => {
  calls = [];
  browseReply = () => ({ body: JSON.stringify(firstPage([])) });
  editReply = () => ({ body: JSON.stringify({ status: 'STATUS_SUCCEEDED' }) });
  createReply = () => ({ body: JSON.stringify({ playlistId: 'PLfmpCreated0000000000000000000001' }) });
  credentials = { cookies: { SAPISID: 'fake-sapisid' } };
  const store = new Map();
  globalThis.fmp = {
    http: {
      request: async (r) => {
        const attached = credentials !== null && (r.auth === 'required' || r.auth === 'userPreference');
        const reply = (body, status = 200) => ({ status, url: r.url, headers: {}, body, credentialsAttached: attached });
        if (r.url.includes('/sw.js_data')) return reply(bodyOf(fixture(1)));
        if (r.url.includes('/youtubei/v1/config')) return reply(bodyOf(fixture(2)));
        const kind = r.url.includes('/youtubei/v1/browse/edit_playlist') ? 'edit'
          : r.url.includes('/youtubei/v1/playlist/create') ? 'create'
            : r.url.includes('/youtubei/v1/browse') ? 'browse' : null;
        if (kind === null) return { status: 404, url: r.url, headers: {}, body: '' };
        const body = JSON.parse(r.body);
        const call = { kind, url: r.url, method: r.method, body, idempotent: r.idempotent, auth: r.auth, attached };
        calls.push(call);
        const n = calls.filter((c) => c.kind === kind).length;
        const next = (kind === 'edit' ? editReply : kind === 'create' ? createReply : browseReply)(body, n);
        return reply(next.body, next.status);
      },
    },
    storage: { get: async (k) => store.get(k) ?? null, set: async (k, v) => { store.set(k, v); }, delete: async (k) => { store.delete(k); } },
    credentials: { get: async () => credentials },
    log: { debug() {}, info() {}, warn() {}, error() {} },
  };
});

const isError = (kind) => (e) => e.fmpError === kind;
const ofKind = (kind) => calls.filter((c) => c.kind === kind);
const summary = (results) => results.map((r) => (r.error ? `${r.status}:${r.error.fmpError}` : r.status));

test('createPlaylist: posts playlist/create as PRIVATE with required auth and no idempotent retry', async () => {
  assert.deepEqual(await createPlaylist({ title: ' My list ' }), { playlistId: 'PLfmpCreated0000000000000000000001' });
  const [c] = ofKind('create');
  assert.equal(c.method, 'POST');
  assert.match(c.url, /^https:\/\/www\.youtube\.com\/youtubei\/v1\/playlist\/create\?/);
  assert.equal(c.body.title, 'My list');
  assert.equal(c.body.privacyStatus, 'PRIVATE');
  assert.equal(c.body.context.client.clientName, 'WEB');
  assert.equal(c.auth, 'required');
  assert.notEqual(c.idempotent, true);
});

test('createPlaylist: rejects an empty title and a response without a usable playlistId', async () => {
  await assert.rejects(createPlaylist({ title: ' ' }), isError('ParseError'));
  createReply = () => ({ body: JSON.stringify({}) });
  await assert.rejects(createPlaylist({ title: 'a' }), isError('ParseError'));
  createReply = () => ({ status: 404, body: '{"error":{"code":404}}' });
  await assert.rejects(createPlaylist({ title: 'a' }), isError('NotFound'));
});

test('addToPlaylist: scans the playlist first (required), skips what is there, adds the rest one request each', async () => {
  browseReply = () => ({ body: JSON.stringify(firstPage([row(V1, 'sv1'), row('zzzzzzzzzz9', 'sv9')])) });
  const { results } = await addToPlaylist({ playlistId: PL, tracks: [{ sourceId: V1 }, { sourceId: V2 }, { sourceId: V3, cid: 3 }] });
  assert.deepEqual(summary(results), ['alreadyPresent', 'added', 'added']);
  const [browse] = ofKind('browse');
  assert.equal(browse.body.browseId, `VL${PL}`);
  assert.equal(browse.auth, 'required');
  const edits = ofKind('edit');
  assert.equal(edits.length, 2);
  assert.match(edits[0].url, /^https:\/\/www\.youtube\.com\/youtubei\/v1\/browse\/edit_playlist\?/);
  assert.equal(edits[0].method, 'POST');
  assert.equal(edits[0].auth, 'required');
  assert.notEqual(edits[0].idempotent, true);
  assert.equal(edits[0].body.playlistId, PL);
  assert.deepEqual(edits[0].body.actions, [{ addedVideoId: V2, action: 'ACTION_ADD_VIDEO' }]);
  assert.equal(edits[0].body.context.client.clientName, 'WEB');
  assert.deepEqual(edits[1].body.actions, [{ addedVideoId: V3, action: 'ACTION_ADD_VIDEO' }]);
});

test('addToPlaylist: follows continuation pages and stops once every target is found', async () => {
  browseReply = (body) => (body.continuation === 'next1'
    ? { body: JSON.stringify(nextPage([row(V2, 'sv2'), token('next2')])) }
    : { body: JSON.stringify(firstPage([row(V1, 'sv1'), token('next1')])) });
  const { results } = await addToPlaylist({ playlistId: PL, tracks: [{ sourceId: V1 }, { sourceId: V2 }] });
  assert.deepEqual(summary(results), ['alreadyPresent', 'alreadyPresent']);
  assert.deepEqual(ofKind('browse').map((c) => c.body.continuation), [undefined, 'next1']);
  assert.equal(ofKind('edit').length, 0);
});

test('addToPlaylist: repeats in one request, invalid ids and results order', async () => {
  const { results } = await addToPlaylist({ playlistId: PL, tracks: [{ sourceId: V1 }, { sourceId: 'bad' }, { sourceId: V1, cid: 2 }, {}] });
  assert.deepEqual(summary(results), ['added', 'failed:ParseError', 'alreadyPresent', 'failed:ParseError']);
  assert.equal(ofKind('edit').length, 1);
});

test('addToPlaylist: a non-success status is a failed item and the next items still go', async () => {
  editReply = (_, n) => (n === 1 ? { body: JSON.stringify({ status: 'STATUS_FAILED' }) } : { body: JSON.stringify({ status: 'STATUS_SUCCEEDED' }) });
  const { results } = await addToPlaylist({ playlistId: PL, tracks: [{ sourceId: V1 }, { sourceId: V2 }] });
  assert.deepEqual(summary(results), ['failed:UnexpectedError', 'added']);
  assert.match(results[0].error.message, /STATUS_FAILED/);
});

test('addToPlaylist: a 200 with an error object is a failed item', async () => {
  editReply = () => ({ body: JSON.stringify({ error: { code: 400, message: 'Precondition check failed.' } }) });
  const { results } = await addToPlaylist({ playlistId: PL, tracks: [{ sourceId: V1 }] });
  assert.deepEqual(summary(results), ['failed:UnexpectedError']);
});

test('addToPlaylist: HTTP 404 on one item is NotFound; 403 with credentials is a per-item UnexpectedError', async () => {
  editReply = (_, n) => (n === 1 ? { status: 404, body: '{"error":{"code":404}}' } : { status: 403, body: '{"error":{"code":403}}' });
  const { results } = await addToPlaylist({ playlistId: PL, tracks: [{ sourceId: V1 }, { sourceId: V2 }] });
  assert.deepEqual(summary(results), ['failed:NotFound', 'failed:UnexpectedError']);
});

test('addToPlaylist: a rejected credential (401 with credentials) after progress stops the batch', async () => {
  editReply = (_, n) => (n === 1 ? { body: JSON.stringify({ status: 'STATUS_SUCCEEDED' }) } : { status: 401, body: '{"error":{"code":401}}' });
  const { results } = await addToPlaylist({ playlistId: PL, tracks: [{ sourceId: V1 }, { sourceId: V2 }, { sourceId: V3 }] });
  assert.deepEqual(summary(results), ['added', 'failed:CredentialInvalid', 'failed:CredentialInvalid']);
  assert.equal(ofKind('edit').length, 2);
});

test('addToPlaylist: a host error in results keeps only the FmpError fields (no hostErrorId); a thrown one stays as is', async () => {
  // 宿主丟的錯誤（js_prelude 的 toError）：Error 加上 fmpError、hostErrorId 等欄位。
  const original = globalThis.fmp.http.request;
  let n = 0;
  globalThis.fmp.http.request = async (r) => {
    if (r.url.includes('/youtubei/v1/browse/edit_playlist') && ++n === 2) {
      throw Object.assign(new Error('RateLimited'), { fmpError: 'RateLimited', hostErrorId: 7, retryAfterSeconds: 3 });
    }
    return original(r);
  };
  const { results } = await addToPlaylist({ playlistId: PL, tracks: [{ sourceId: V1 }, { sourceId: V2 }, { sourceId: V3 }] });
  const limited = { status: 'failed', error: { fmpError: 'RateLimited', message: 'RateLimited', retryAfterSeconds: 3 } };
  assert.deepEqual(JSON.parse(JSON.stringify(results)), [{ status: 'added' }, limited, limited]);
  n = 1;
  await assert.rejects(addToPlaylist({ playlistId: PL, tracks: [{ sourceId: V1 }] }), (e) => e.hostErrorId === 7);
});

test('addToPlaylist: when nothing got done, a rejected credential throws the whole request', async () => {
  editReply = () => ({ status: 401, body: '{"error":{"code":401}}' });
  await assert.rejects(addToPlaylist({ playlistId: PL, tracks: [{ sourceId: V1 }, { sourceId: V2 }] }), isError('CredentialInvalid'));
  assert.equal(ofKind('edit').length, 1);
});

test('addToPlaylist: a rejected credential while scanning throws before any write', async () => {
  browseReply = () => ({ status: 401, body: '{"error":{"code":401}}' });
  await assert.rejects(addToPlaylist({ playlistId: PL, tracks: [{ sourceId: V1 }] }), isError('CredentialInvalid'));
  assert.equal(ofKind('edit').length, 0);
});

test('addToPlaylist: a playlist that cannot be read fails every item without any edit', async () => {
  browseReply = () => ({ status: 404, body: '{"error":{"code":404}}' });
  const { results } = await addToPlaylist({ playlistId: PL, tracks: [{ sourceId: V1 }, { sourceId: V2 }] });
  assert.deepEqual(summary(results), ['failed:NotFound', 'failed:NotFound']);
  assert.equal(ofKind('edit').length, 0);
});

test('addToPlaylist: a first page without a video list is NotFound for every item', async () => {
  browseReply = () => ({ body: JSON.stringify({ contents: {} }) });
  const { results } = await addToPlaylist({ playlistId: PL, tracks: [{ sourceId: V1 }] });
  assert.deepEqual(summary(results), ['failed:NotFound']);
});

test('addToPlaylist: a failing continuation page throws instead of guessing (no edit is sent)', async () => {
  browseReply = (body) => (body.continuation ? { status: 500, body: '{}' } : { body: JSON.stringify(firstPage([row('zzzzzzzzzz9', 's9'), token('next1')])) });
  await assert.rejects(addToPlaylist({ playlistId: PL, tracks: [{ sourceId: V1 }] }), isError('NetworkError'));
  assert.equal(ofKind('edit').length, 0);
});

test('addToPlaylist: an unsigned 401 is AuthRequired for every item', async () => {
  credentials = null;
  browseReply = () => ({ status: 401, body: '{"error":{"code":401}}' });
  const { results } = await addToPlaylist({ playlistId: PL, tracks: [{ sourceId: V1 }] });
  assert.deepEqual(summary(results), ['failed:AuthRequired']);
});

test('addToPlaylist: validates the playlistId and the list; an empty list sends nothing', async () => {
  await assert.rejects(addToPlaylist({ playlistId: 'RDabc', tracks: [] }), isError('ParseError'));
  await assert.rejects(addToPlaylist({ playlistId: PL, tracks: null }), isError('ParseError'));
  assert.deepEqual(await addToPlaylist({ playlistId: PL, tracks: [] }), { results: [] });
  assert.equal(calls.length, 0);
});

test('removeFromPlaylist: finds setVideoId by scanning, then ACTION_REMOVE_VIDEO per item; missing is notPresent', async () => {
  browseReply = () => ({ body: JSON.stringify(firstPage([row(V1, 'sv1'), row(V2, 'sv2')])) });
  const { results } = await removeFromPlaylist({ playlistId: PL, items: [{ sourceId: V2 }, { sourceId: V3 }, { sourceId: V1, cid: 9 }] });
  assert.deepEqual(summary(results), ['removed', 'notPresent', 'removed']);
  const edits = ofKind('edit');
  assert.equal(edits.length, 2);
  assert.deepEqual(edits[0].body.actions, [{ setVideoId: 'sv2', removedVideoId: V2, action: 'ACTION_REMOVE_VIDEO' }]);
  assert.deepEqual(edits[1].body.actions, [{ setVideoId: 'sv1', removedVideoId: V1, action: 'ACTION_REMOVE_VIDEO' }]);
  assert.equal(edits[0].auth, 'required');
  assert.notEqual(edits[0].idempotent, true);
  assert.equal(ofKind('browse')[0].auth, 'required');
});

test('removeFromPlaylist: a remoteItemId is used as the setVideoId and needs no scan', async () => {
  const { results } = await removeFromPlaylist({ playlistId: PL, items: [{ sourceId: V1, remoteItemId: 'given-set-id' }] });
  assert.deepEqual(summary(results), ['removed']);
  assert.equal(ofKind('browse').length, 0);
  assert.deepEqual(ofKind('edit')[0].body.actions, [{ setVideoId: 'given-set-id', removedVideoId: V1, action: 'ACTION_REMOVE_VIDEO' }]);
});

test('removeFromPlaylist: a video listed twice is removed once per remoteItemId; a repeated slot is notPresent', async () => {
  browseReply = () => ({ body: JSON.stringify(firstPage([row(V1, 'set-a'), row(V1, 'set-b')])) });
  const { results } = await removeFromPlaylist({
    playlistId: PL,
    items: [{ sourceId: V1, remoteItemId: 'set-a' }, { sourceId: V1, remoteItemId: 'set-b' }, { sourceId: V1, remoteItemId: 'set-a' }, { sourceId: V1 }],
  });
  // 最後一項沒有 remoteItemId：掃到的第一格是 set-a，已經移除過，不再送。
  assert.deepEqual(summary(results), ['removed', 'removed', 'notPresent', 'notPresent']);
  assert.deepEqual(ofKind('edit').map((c) => c.body.actions[0].setVideoId), ['set-a', 'set-b']);
});

test('removeFromPlaylist: the setVideoId of a lockupViewModel row is found anywhere under it', async () => {
  browseReply = () => ({ body: JSON.stringify(firstPage([lockupRow(V1, 'sv-lockup')])) });
  const { results } = await removeFromPlaylist({ playlistId: PL, items: [{ sourceId: V1 }] });
  assert.deepEqual(summary(results), ['removed']);
  assert.equal(ofKind('edit')[0].body.actions[0].setVideoId, 'sv-lockup');
});

test('removeFromPlaylist: the video is listed but no setVideoId can be found: failed, no edit request', async () => {
  browseReply = () => ({ body: JSON.stringify(firstPage([{ lockupViewModel: { contentId: V1, contentType: 'LOCKUP_CONTENT_TYPE_VIDEO' } }])) });
  const { results } = await removeFromPlaylist({ playlistId: PL, items: [{ sourceId: V1 }] });
  assert.deepEqual(summary(results), ['failed:UnexpectedError']);
  assert.equal(ofKind('edit').length, 0);
});

test('removeFromPlaylist: repeats are notPresent, a failed edit does not stop the others', async () => {
  browseReply = () => ({ body: JSON.stringify(firstPage([row(V1, 'sv1'), row(V2, 'sv2')])) });
  editReply = (_, n) => (n === 1 ? { body: JSON.stringify({ status: 'STATUS_FAILED' }) } : { body: JSON.stringify({ status: 'STATUS_SUCCEEDED' }) });
  const { results } = await removeFromPlaylist({ playlistId: PL, items: [{ sourceId: V1 }, { sourceId: V2 }, { sourceId: V1 }, { sourceId: 'bad' }] });
  assert.deepEqual(summary(results), ['failed:UnexpectedError', 'removed', 'failed:UnexpectedError', 'failed:ParseError']);
  assert.equal(results.length, 4);
});

test('removeFromPlaylist: a successful first removal makes the repeat notPresent', async () => {
  browseReply = () => ({ body: JSON.stringify(firstPage([row(V1, 'sv1')])) });
  const { results } = await removeFromPlaylist({ playlistId: PL, items: [{ sourceId: V1 }, { sourceId: V1, cid: 1 }] });
  assert.deepEqual(summary(results), ['removed', 'notPresent']);
});
