// createPlaylist／addToPlaylist／removeFromPlaylist（假的宿主 API，不連網）。
// 回應是手寫的：欄位照舊專案 bilibili_favorites_service.dart 讀的那些；真實連線的行為（11201 是否真的出現、
// batch-del 對不在收藏夾的影片回什麼）未驗證，見 README。
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { addToPlaylist, createPlaylist, removeFromPlaylist } from '../src/plugin.js';

const BV1 = 'BV1fmpTest01';
const BV2 = 'BV1fmpTest02';
const BV3 = 'BV1fmpTest03';
const AIDS = { [BV1]: 1001, [BV2]: 1002, [BV3]: 1003 };
const KEY = 'a'.repeat(32);

let requests;
let reply; // (req) => {status?, body}，只管 deal／batch-del／folder/add
let viewReply; // (bvid) => body；預設回 aid
let credentials;
beforeEach(() => {
  requests = [];
  credentials = { cookies: { SESSDATA: 'fake-sessdata', DedeUserID: '1234567', bili_jct: 'fake-jct' } };
  reply = () => ({ body: { code: 0, message: '0', ttl: 1, data: null } });
  viewReply = (bvid) => ({ code: 0, message: '0', data: { aid: AIDS[bvid], bvid } });
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
        const attached = credentials !== null && req.auth === 'required';
        requests.push({ ...req, attached });
        let next;
        if (req.url.includes('/x/web-interface/nav')) {
          next = { body: { code: 0, data: { wbi_img: { img_url: `https://i0.hdslb.com/bfs/wbi/${KEY}.png`, sub_url: `https://i0.hdslb.com/bfs/wbi/${KEY}.png` } } } };
        } else if (req.url.includes('/x/web-interface/wbi/view')) {
          next = { body: viewReply(new URL(req.url).searchParams.get('bvid')) };
        } else {
          next = reply(req);
        }
        const body = next.body;
        return { status: 200, headers: {}, credentialsAttached: attached, ...next, body: typeof body === 'string' ? body : JSON.stringify(body) };
      },
    },
  };
});

const err = (code, message = '') => ({ body: { code, message, ttl: 1 } });
const isError = (kind) => (e) => e.fmpError === kind;
const form = (req) => Object.fromEntries(new URLSearchParams(req.body));
const writes = (suffix) => requests.filter((r) => r.method === 'POST' && r.url.endsWith(suffix));
const views = () => requests.filter((r) => r.url.includes('/x/web-interface/wbi/view'));

test('createPlaylist: posts fav/folder/add as a private folder with csrf and returns the full media id', async () => {
  reply = () => ({ body: { code: 0, message: '0', data: { id: 4026748499, fid: 40267484, title: 'new list' } } });
  assert.deepEqual(await createPlaylist({ title: ' new list ' }), { playlistId: '4026748499' });
  assert.equal(requests.length, 1);
  const [req] = requests;
  assert.equal(req.url, 'https://api.bilibili.com/x/v3/fav/folder/add');
  assert.equal(req.method, 'POST');
  assert.equal(req.auth, 'required');
  assert.equal(req.headers['Content-Type'], 'application/x-www-form-urlencoded');
  assert.deepEqual(form(req), { title: 'new list', intro: '', privacy: '1', csrf: 'fake-jct' });
  assert.notEqual(req.idempotent, true);
});

test('createPlaylist: rejects an empty title, a missing bili_jct and a response without an id', async () => {
  await assert.rejects(createPlaylist({ title: '  ' }), isError('ParseError'));
  credentials = { cookies: { SESSDATA: 'x' } };
  await assert.rejects(createPlaylist({ title: 'a' }), isError('AuthRequired'));
  credentials = { cookies: { bili_jct: 'j' } };
  reply = () => ({ body: { code: 0, data: {} } });
  await assert.rejects(createPlaylist({ title: 'a' }), isError('ParseError'));
  assert.equal(requests.length, 1);
});

test('addToPlaylist: converts the bvid through wbi/view and posts fav/resource/deal per video', async () => {
  const { results } = await addToPlaylist({ playlistId: '4026748432', tracks: [{ sourceId: BV1 }, { sourceId: BV2 }] });
  assert.deepEqual(results, [{ status: 'added' }, { status: 'added' }]);
  assert.equal(views().length, 2);
  for (const req of views()) {
    assert.equal(req.auth, 'required');
    assert.match(new URL(req.url).search, /bvid=BV1fmpTest0[12]&wts=\d+&w_rid=/);
  }
  const deals = writes('/x/v3/fav/resource/deal');
  assert.equal(deals.length, 2);
  assert.deepEqual(form(deals[0]), { rid: '1001', type: '2', add_media_ids: '4026748432', del_media_ids: '', csrf: 'fake-jct' });
  assert.equal(form(deals[1]).rid, '1002');
  for (const req of deals) {
    assert.equal(req.auth, 'required');
    assert.notEqual(req.idempotent, true);
  }
});

test('addToPlaylist: code 11201 is alreadyPresent', async () => {
  reply = () => err(11201, '已收藏');
  const { results } = await addToPlaylist({ playlistId: '4026748432', tracks: [{ sourceId: BV1 }] });
  assert.deepEqual(results, [{ status: 'alreadyPresent' }]);
});

test('addToPlaylist: parts of one video (cid) add the whole video once; the repeats are alreadyPresent', async () => {
  const { results } = await addToPlaylist({
    playlistId: '4026748432',
    tracks: [{ sourceId: BV1, cid: 11 }, { sourceId: BV1, cid: 12 }, { sourceId: BV1 }],
  });
  assert.deepEqual(results, [{ status: 'added' }, { status: 'alreadyPresent' }, { status: 'alreadyPresent' }]);
  assert.equal(views().length, 1);
  assert.equal(writes('/x/v3/fav/resource/deal').length, 1);
});

test('addToPlaylist: per-item failures are reported in order without stopping the rest', async () => {
  viewReply = (bvid) => (bvid === BV2 ? { code: -404, message: '啥都木有' } : { code: 0, data: { aid: AIDS[bvid] } });
  let n = 0;
  reply = () => (++n === 2 ? err(11010, '内容不存在') : { body: { code: 0, data: null } });
  const { results } = await addToPlaylist({
    playlistId: '4026748432',
    tracks: [{ sourceId: BV1 }, { sourceId: BV2 }, { sourceId: 'not-a-bvid' }, { sourceId: BV3 }, { sourceId: BV2 }],
  });
  assert.equal(results.length, 5);
  assert.deepEqual(results[0], { status: 'added' });
  assert.equal(results[1].status, 'failed');
  assert.equal(results[1].error.fmpError, 'NotFound');
  assert.equal(results[2].status, 'failed');
  assert.equal(results[2].error.fmpError, 'ParseError');
  assert.equal(results[3].status, 'failed');
  assert.equal(results[3].error.fmpError, 'NotFound'); // 第二次 deal 回 11010
  assert.deepEqual(results[4], results[1]); // 重複的項目沿用第一次的失敗
});

test('addToPlaylist: a rejected credential after progress stops the batch and fails the rest with CredentialInvalid', async () => {
  let n = 0;
  reply = () => (++n === 1 ? { body: { code: 0, data: null } } : err(-111, 'csrf 校验失败'));
  const { results } = await addToPlaylist({ playlistId: '4026748432', tracks: [{ sourceId: BV1 }, { sourceId: BV2 }, { sourceId: BV3 }] });
  assert.deepEqual(results.map((r) => [r.status, r.error && r.error.fmpError]), [
    ['added', undefined],
    ['failed', 'CredentialInvalid'],
    ['failed', 'CredentialInvalid'],
  ]);
  assert.equal(writes('/x/v3/fav/resource/deal').length, 2);
});

test('addToPlaylist: risk control (-352) after progress stops the batch as RateLimited', async () => {
  let n = 0;
  reply = () => (++n === 1 ? { body: { code: 0, data: null } } : err(-352));
  const { results } = await addToPlaylist({ playlistId: '4026748432', tracks: [{ sourceId: BV1 }, { sourceId: BV2 }, { sourceId: BV3 }] });
  assert.deepEqual(results.map((r) => r.error && r.error.fmpError), [undefined, 'RateLimited', 'RateLimited']);
  assert.equal(writes('/x/v3/fav/resource/deal').length, 2);
});

/** 宿主丟的錯誤（js_prelude 的 toError）：Error 加上 fmpError、hostErrorId 等欄位。 */
const hostError = (fmpError, extra) => Object.assign(new Error(fmpError), { fmpError, hostErrorId: 7, ...extra });

test('addToPlaylist: a host error in results keeps only the FmpError fields (no hostErrorId); a thrown one stays as is', async () => {
  const original = globalThis.fmp.http.request;
  let n = 0;
  globalThis.fmp.http.request = async (req) => {
    if (req.url.includes('/fav/resource/deal') && ++n === 2) throw hostError('RateLimited', { retryAfterSeconds: 3 });
    return original(req);
  };
  const { results } = await addToPlaylist({ playlistId: '4026748432', tracks: [{ sourceId: BV1 }, { sourceId: BV2 }, { sourceId: BV3 }] });
  const limited = { status: 'failed', error: { fmpError: 'RateLimited', message: 'RateLimited', retryAfterSeconds: 3 } };
  assert.deepEqual(JSON.parse(JSON.stringify(results)), [{ status: 'added' }, limited, limited]);
  n = 1;
  await assert.rejects(addToPlaylist({ playlistId: '4026748432', tracks: [{ sourceId: BV1 }] }), (e) => e.hostErrorId === 7);
});

test('addToPlaylist: when nothing got done, a rejected credential or risk control throws the whole request', async () => {
  reply = () => err(-111, 'csrf 校验失败');
  await assert.rejects(addToPlaylist({ playlistId: '4026748432', tracks: [{ sourceId: BV1 }, { sourceId: BV2 }] }), isError('CredentialInvalid'));
  assert.equal(writes('/x/v3/fav/resource/deal').length, 1);
  reply = () => err(-352);
  await assert.rejects(addToPlaylist({ playlistId: '4026748432', tracks: [{ sourceId: BV1 }] }), isError('RateLimited'));
});

test('addToPlaylist: other business codes are failed items (UnexpectedError)', async () => {
  reply = () => err(-607, '收藏夹已满');
  const { results } = await addToPlaylist({ playlistId: '4026748432', tracks: [{ sourceId: BV1 }] });
  assert.equal(results[0].status, 'failed');
  assert.equal(results[0].error.fmpError, 'UnexpectedError');
  assert.match(results[0].error.message, /-607/);
});

test('addToPlaylist: a transport failure throws the whole request', async () => {
  const original = globalThis.fmp.http.request;
  globalThis.fmp.http.request = async (req) => {
    if (req.url.includes('/fav/resource/deal')) throw { fmpError: 'NetworkError', message: 'down' };
    return original(req);
  };
  await assert.rejects(addToPlaylist({ playlistId: '4026748432', tracks: [{ sourceId: BV1 }] }), isError('NetworkError'));
});

test('addToPlaylist: validates the playlistId and the list', async () => {
  await assert.rejects(addToPlaylist({ playlistId: 'abc', tracks: [] }), isError('ParseError'));
  await assert.rejects(addToPlaylist({ playlistId: '4026748432', tracks: 'x' }), isError('ParseError'));
  assert.deepEqual(await addToPlaylist({ playlistId: '4026748432', tracks: [] }), { results: [] });
});

test('removeFromPlaylist: one batch-del with <aid>:2 resources, every item removed', async () => {
  const { results } = await removeFromPlaylist({
    playlistId: '4026748432',
    items: [{ sourceId: BV1 }, { sourceId: BV2, cid: 5, remoteItemId: 'ignored' }],
  });
  assert.deepEqual(results, [{ status: 'removed' }, { status: 'removed' }]);
  const dels = writes('/x/v3/fav/resource/batch-del');
  assert.equal(dels.length, 1);
  assert.deepEqual(form(dels[0]), { media_id: '4026748432', resources: '1001:2,1002:2', csrf: 'fake-jct' });
  assert.equal(dels[0].auth, 'required');
  assert.notEqual(dels[0].idempotent, true);
});

test('removeFromPlaylist: repeats are notPresent, bad items fail, the rest still go in the batch', async () => {
  viewReply = (bvid) => (bvid === BV2 ? { code: -404, message: '啥都木有' } : { code: 0, data: { aid: AIDS[bvid] } });
  const { results } = await removeFromPlaylist({
    playlistId: '4026748432',
    items: [{ sourceId: BV1 }, { sourceId: BV2 }, { sourceId: BV1, cid: 3 }, {}, { sourceId: BV3 }, { sourceId: BV2 }],
  });
  assert.equal(results.length, 6);
  assert.deepEqual(results[0], { status: 'removed' });
  assert.equal(results[1].error.fmpError, 'NotFound');
  assert.deepEqual(results[2], { status: 'notPresent' });
  assert.equal(results[3].error.fmpError, 'ParseError');
  assert.deepEqual(results[4], { status: 'removed' });
  assert.deepEqual(results[5], results[1]);
  assert.equal(form(writes('/x/v3/fav/resource/batch-del')[0]).resources, '1001:2,1003:2');
});

test('removeFromPlaylist: a failed batch fails every item in it', async () => {
  reply = () => err(-607, 'whatever');
  const { results } = await removeFromPlaylist({ playlistId: '4026748432', items: [{ sourceId: BV1 }, { sourceId: BV2 }] });
  assert.deepEqual(results.map((r) => [r.status, r.error.fmpError]), [['failed', 'UnexpectedError'], ['failed', 'UnexpectedError']]);
});

test('removeFromPlaylist: a permission failure (-403) on the only batch throws AuthRequired', async () => {
  reply = () => err(-403, '无权限');
  await assert.rejects(removeFromPlaylist({ playlistId: '4026748432', items: [{ sourceId: BV1 }, { sourceId: BV2 }] }), isError('AuthRequired'));
});

test('removeFromPlaylist: risk control while converting stops before batch-del; converted items share the failure', async () => {
  viewReply = (bvid) => (bvid === BV2 ? { code: -352, message: '风控' } : { code: 0, data: { aid: AIDS[bvid] } });
  await assert.rejects(
    removeFromPlaylist({ playlistId: '4026748432', items: [{ sourceId: BV1 }, { sourceId: BV2 }, { sourceId: BV3 }] }),
    isError('RateLimited'),
  );
  assert.equal(writes('/x/v3/fav/resource/batch-del').length, 0);
  assert.equal(views().length, 2); // BV3 不再換
});

test('removeFromPlaylist: nothing convertible means no batch-del request', async () => {
  const { results } = await removeFromPlaylist({ playlistId: '4026748432', items: [{ sourceId: 'bad' }] });
  assert.equal(results.length, 1);
  assert.equal(results[0].status, 'failed');
  assert.equal(writes('/x/v3/fav/resource/batch-del').length, 0);
});

test('credentials rejected on an attached batch-del throw CredentialInvalid', async () => {
  const original = globalThis.fmp.http.request;
  globalThis.fmp.http.request = async (req) => {
    const res = await original(req);
    return req.url.endsWith('/fav/resource/batch-del') ? { ...res, body: JSON.stringify({ code: -101, message: '账号未登录' }) } : res;
  };
  await assert.rejects(removeFromPlaylist({ playlistId: '4026748432', items: [{ sourceId: BV1 }] }), isError('CredentialInvalid'));
});
