// createPlaylist／addToPlaylist／removeFromPlaylist（假的宿主 API，不連網）：linux forward 的
// playlist/create、v6/playlist/detail（預讀）、playlist/manipulate/tracks。
// 回應是手寫的（假 id），欄位照舊專案 netease_playlist_service.dart 讀的那些；真實連線的行為（重複加入的碼、
// 不帶 X-Real-IP 行不行）未驗證，見 README。
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createDecipheriv } from 'node:crypto';

import { addToPlaylist, createPlaylist, removeFromPlaylist } from '../src/plugin.js';

const PL = '900000001';

let requests;
let reply; // (path, params, req) => {status?, body}
let credentials;
beforeEach(() => {
  requests = [];
  credentials = { cookies: { MUSIC_U: 'fake-music-u', __csrf: 'fake-csrf' } };
  reply = (path) => {
    if (path === 'v6/playlist/detail') return { body: detail([]) };
    return { body: { code: 200 } };
  };
  globalThis.fmp = {
    log: { debug() {}, info() {}, warn() {} },
    credentials: { get: async () => credentials },
    http: {
      async request(req) {
        const attached = credentials !== null && req.auth === 'required';
        const payload = payloadOf(req);
        const call = { ...req, attached, path: payload.url.replace('https://music.163.com/api/', ''), params: payload.params };
        requests.push(call);
        const next = reply(call.path, call.params, req);
        const body = next.body;
        return { status: 200, headers: {}, url: req.url, credentialsAttached: attached, ...next, body: typeof body === 'string' ? body : JSON.stringify(body) };
      },
    },
  };
});

/** eparams（AES-128-ECB，金鑰是舊專案的 _linuxApiKey）→ 解開後的 JSON，獨立於插件的實作。 */
function payloadOf(req) {
  const eparams = new URLSearchParams(req.body).get('eparams');
  const decipher = createDecipheriv('aes-128-ecb', Buffer.from('rFgB&h#%2?^eDg:Q'), null);
  return JSON.parse(Buffer.concat([decipher.update(Buffer.from(eparams, 'hex')), decipher.final()]).toString('utf8'));
}

const detail = (ids) => ({ code: 200, playlist: { id: Number(PL), name: 'fake', trackIds: ids.map((id) => ({ id: Number(id) })) } });
const isError = (kind) => (e) => e.fmpError === kind;
const summary = (results) => results.map((r) => (r.error ? `${r.status}:${r.error.fmpError}` : r.status));
const ofPath = (path) => requests.filter((r) => r.path === path);

test('createPlaylist: linux forward playlist/create with privacy 10 (private), required, no X-Real-IP', async () => {
  reply = () => ({ body: { code: 200, id: 900000777, playlist: { id: 900000777, name: 'new' } } });
  assert.deepEqual(await createPlaylist({ title: ' new ' }), { playlistId: '900000777' });
  assert.equal(requests.length, 1);
  const [req] = requests;
  assert.equal(req.url, 'https://music.163.com/api/linux/forward');
  assert.equal(req.method, 'POST');
  assert.equal(req.auth, 'required');
  assert.notEqual(req.idempotent, true);
  assert.equal(req.path, 'playlist/create');
  assert.deepEqual(req.params, { name: 'new', privacy: '10' });
  assert.equal(req.headers['X-Real-IP'], undefined);
  assert.equal(req.headers['User-Agent'].includes('Linux'), true);
});

test('createPlaylist: falls back to the top-level id; rejects an empty title, a missing id and non-200 codes', async () => {
  reply = () => ({ body: { code: 200, id: 900000778 } });
  assert.deepEqual(await createPlaylist({ title: 'a' }), { playlistId: '900000778' });
  await assert.rejects(createPlaylist({ title: '' }), isError('ParseError'));
  reply = () => ({ body: { code: 200 } });
  await assert.rejects(createPlaylist({ title: 'a' }), isError('ParseError'));
  reply = () => ({ body: { code: -460, message: 'cheating' } });
  await assert.rejects(createPlaylist({ title: 'a' }), isError('VerificationRequired'));
});

test('addToPlaylist: reads the playlist, then adds the missing ones in one batch', async () => {
  reply = (path) => (path === 'v6/playlist/detail' ? { body: detail(['111']) } : { body: { code: 200, count: 2 } });
  const { results } = await addToPlaylist({ playlistId: PL, tracks: [{ sourceId: '111' }, { sourceId: '222' }, { sourceId: '333', cid: 1 }] });
  assert.deepEqual(summary(results), ['alreadyPresent', 'added', 'added']);
  assert.equal(requests.length, 2);
  assert.deepEqual(requests[0].params, { id: PL });
  assert.equal(requests[0].path, 'v6/playlist/detail');
  assert.equal(requests[0].idempotent, true);
  assert.deepEqual(requests[1].params, { trackIds: ['222', '333'], pid: PL, op: 'add' });
  assert.equal(requests[1].path, 'playlist/manipulate/tracks');
  for (const req of requests) {
    assert.equal(req.auth, 'required');
    assert.equal(req.headers['X-Real-IP'], undefined);
  }
  assert.notEqual(requests[1].idempotent, true);
});

test('addToPlaylist: everything is already there: no manipulate request', async () => {
  reply = () => ({ body: detail(['111', '222']) });
  const { results } = await addToPlaylist({ playlistId: PL, tracks: [{ sourceId: '222' }, { sourceId: '111' }] });
  assert.deepEqual(summary(results), ['alreadyPresent', 'alreadyPresent']);
  assert.equal(requests.length, 1);
});

test('addToPlaylist: repeats and invalid ids keep order and length', async () => {
  const { results } = await addToPlaylist({ playlistId: PL, tracks: [{ sourceId: '222' }, { sourceId: 'x' }, { sourceId: '222' }, {}] });
  assert.deepEqual(summary(results), ['added', 'failed:ParseError', 'alreadyPresent', 'failed:ParseError']);
  assert.deepEqual(ofPath('playlist/manipulate/tracks')[0].params.trackIds, ['222']);
});

test('addToPlaylist: a non-200 code fails the whole batch (and its repeats), present ones stay alreadyPresent', async () => {
  reply = (path) => (path === 'v6/playlist/detail' ? { body: detail(['111']) } : { body: { code: 502, message: 'duplicate?' } });
  const { results } = await addToPlaylist({ playlistId: PL, tracks: [{ sourceId: '111' }, { sourceId: '222' }, { sourceId: '222' }] });
  assert.deepEqual(summary(results), ['alreadyPresent', 'failed:UnexpectedError', 'failed:UnexpectedError']);
  assert.match(results[1].error.message, /502/);
});

test('addToPlaylist: -460 risk control is VerificationRequired for the batch', async () => {
  reply = (path) => (path === 'v6/playlist/detail' ? { body: detail([]) } : { body: { code: -460, message: 'cheating' } });
  const { results } = await addToPlaylist({ playlistId: PL, tracks: [{ sourceId: '1' }] });
  assert.deepEqual(summary(results), ['failed:VerificationRequired']);
});

test('addToPlaylist: an unreadable playlist (404) fails every item with NotFound and sends no write', async () => {
  reply = () => ({ body: { code: 404, message: 'playlist not exist' } });
  const { results } = await addToPlaylist({ playlistId: PL, tracks: [{ sourceId: '1' }, { sourceId: '2' }] });
  assert.deepEqual(summary(results), ['failed:NotFound', 'failed:NotFound']);
  assert.equal(requests.length, 1);
});

test('code 301 on an attached request throws CredentialInvalid, in the read and in the write', async () => {
  reply = () => ({ body: { code: 301, message: '未登录' } });
  await assert.rejects(addToPlaylist({ playlistId: PL, tracks: [{ sourceId: '1' }] }), isError('CredentialInvalid'));
  await assert.rejects(removeFromPlaylist({ playlistId: PL, items: [{ sourceId: '1' }] }), isError('CredentialInvalid'));
  reply = (path) => (path === 'v6/playlist/detail' ? { body: detail([]) } : { body: { code: 301, message: '未登录' } });
  await assert.rejects(addToPlaylist({ playlistId: PL, tracks: [{ sourceId: '1' }] }), isError('CredentialInvalid'));
  assert.equal(ofPath('playlist/manipulate/tracks').length, 1);
});

test('a host error reported per item keeps only the FmpError fields (no hostErrorId)', async () => {
  // 宿主丟的錯誤（js_prelude 的 toError）：Error 加上 fmpError、hostErrorId。
  globalThis.fmp.http.request = async () => {
    throw Object.assign(new Error('AuthRequired'), { fmpError: 'AuthRequired', hostErrorId: 7 });
  };
  const { results } = await addToPlaylist({ playlistId: PL, tracks: [{ sourceId: '1' }, { sourceId: '2' }] });
  const failed = { status: 'failed', error: { fmpError: 'AuthRequired', message: 'AuthRequired' } };
  assert.deepEqual(JSON.parse(JSON.stringify(results)), [failed, failed]);
});

test('addToPlaylist: an HTTP failure throws the whole request', async () => {
  reply = () => ({ status: 503, body: '' });
  await assert.rejects(addToPlaylist({ playlistId: PL, tracks: [{ sourceId: '1' }] }), isError('NetworkError'));
});

test('addToPlaylist: validates the input; an empty or all-invalid list sends nothing', async () => {
  await assert.rejects(addToPlaylist({ playlistId: 'abc', tracks: [] }), isError('ParseError'));
  await assert.rejects(addToPlaylist({ playlistId: PL, tracks: {} }), isError('ParseError'));
  assert.deepEqual(await addToPlaylist({ playlistId: PL, tracks: [] }), { results: [] });
  assert.deepEqual(summary((await addToPlaylist({ playlistId: PL, tracks: [{ sourceId: 'x' }] })).results), ['failed:ParseError']);
  assert.equal(requests.length, 0);
});

test('removeFromPlaylist: reads the playlist, deletes the present ones in one batch, the rest are notPresent', async () => {
  reply = (path) => (path === 'v6/playlist/detail' ? { body: detail(['111', '222']) } : { body: { code: 200 } });
  const { results } = await removeFromPlaylist({
    playlistId: PL,
    items: [{ sourceId: '111' }, { sourceId: '999' }, { sourceId: '222', cid: 3, remoteItemId: 'ignored' }],
  });
  assert.deepEqual(summary(results), ['removed', 'notPresent', 'removed']);
  assert.equal(requests.length, 2);
  assert.deepEqual(requests[1].params, { trackIds: ['111', '222'], pid: PL, op: 'del' });
  assert.equal(requests[1].auth, 'required');
  assert.notEqual(requests[1].idempotent, true);
  assert.equal(requests[1].headers['X-Real-IP'], undefined);
});

test('removeFromPlaylist: nothing present: no delete request; repeats are notPresent', async () => {
  reply = (path) => (path === 'v6/playlist/detail' ? { body: detail(['111']) } : { body: { code: 200 } });
  const { results } = await removeFromPlaylist({ playlistId: PL, items: [{ sourceId: '111' }, { sourceId: '111' }, { sourceId: '5' }, { sourceId: 'bad' }] });
  assert.deepEqual(summary(results), ['removed', 'notPresent', 'notPresent', 'failed:ParseError']);
  assert.equal(ofPath('playlist/manipulate/tracks').length, 1);
  const none = await removeFromPlaylist({ playlistId: PL, items: [{ sourceId: '5' }] });
  assert.deepEqual(summary(none.results), ['notPresent']);
  assert.equal(ofPath('playlist/manipulate/tracks').length, 1);
});

test('removeFromPlaylist: a failed delete fails every item in the batch', async () => {
  reply = (path) => (path === 'v6/playlist/detail' ? { body: detail(['111', '222']) } : { body: { code: 404, message: 'playlist not exist' } });
  const { results } = await removeFromPlaylist({ playlistId: PL, items: [{ sourceId: '111' }, { sourceId: '222' }, { sourceId: '111' }] });
  assert.deepEqual(summary(results), ['failed:UnexpectedError', 'failed:UnexpectedError', 'failed:UnexpectedError']);
});

test('removeFromPlaylist: validates the input and reports an unreadable playlist per item', async () => {
  await assert.rejects(removeFromPlaylist({ playlistId: '0', items: [] }), isError('ParseError'));
  await assert.rejects(removeFromPlaylist({ playlistId: PL }), isError('ParseError'));
  reply = () => ({ body: { code: 404 } });
  const { results } = await removeFromPlaylist({ playlistId: PL, items: [{ sourceId: '1' }] });
  assert.deepEqual(summary(results), ['failed:NotFound']);
});
