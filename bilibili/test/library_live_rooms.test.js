// libraryLiveRooms（假的宿主 API，不連網）：勳章牆 MedalWall + get_status_info_by_uids。
// 回應是手寫的（假 id、假名稱），欄位照舊專案 bilibili_live_client.dart 的 getMedalWallRooms 讀的那些，
// 與 liveAnchorSearch 已驗過的 get_status_info_by_uids 形狀。
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { artwork, libraryLiveRooms, liveRoomFromUrl } from '../src/plugin.js';

let requests;
let reply; // (req, n) => {status?, body, credentialsAttached?}
let credentials;
beforeEach(() => {
  requests = [];
  credentials = { cookies: { SESSDATA: 'fake-sessdata', DedeUserID: '1234567', bili_jct: 'fake-jct' } };
  reply = () => ok({ list: [] });
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
const params = (req) => new URL(req.url).searchParams;
const medal = (uid, name, extra = {}) => ({
  medal_info: { target_id: uid, medal_name: 'fake', level: 5 },
  target_name: name,
  target_icon: `https://i0.hdslb.com/bfs/face/${uid}.jpg`,
  live_status: 0,
  ...extra,
});
const status = (uid, roomId, extra = {}) => ({
  uid,
  room_id: roomId,
  title: `title ${roomId}`,
  uname: `uname ${uid}`,
  live_status: 0,
  online: 0,
  cover_from_user: `https://i0.hdslb.com/bfs/live/cover${roomId}.jpg`,
  keyframe: '',
  ...extra,
});
const isWall = (req) => req.url.includes('/MedalWall');

test('libraryLiveRooms: sends the legacy medal wall request, then one status batch', async () => {
  reply = (req) =>
    isWall(req)
      ? ok({ list: [medal(111, 'host one'), medal(222, 'host two')], count: 2 })
      : ok({ 111: status(111, 9001), 222: status(222, 9002) });
  await libraryLiveRooms();
  assert.equal(requests.length, 2);
  const wall = new URL(requests[0].url);
  assert.equal(wall.origin + wall.pathname, 'https://api.live.bilibili.com/xlive/web-ucenter/user/MedalWall');
  assert.deepEqual(Object.fromEntries(wall.searchParams), { target_id: '1234567' });
  assert.equal(requests[0].auth, 'required');
  assert.equal(requests[0].headers.Referer, 'https://live.bilibili.com/');
  const batch = new URL(requests[1].url);
  assert.equal(batch.origin + batch.pathname, 'https://api.live.bilibili.com/room/v1/Room/get_status_info_by_uids');
  assert.deepEqual(batch.searchParams.getAll('uids[]'), ['111', '222']);
  assert.equal(requests[1].auth, 'required');
});

test('libraryLiveRooms: maps to LiveRoom with the same room id format as search', async () => {
  reply = (req) =>
    isWall(req)
      ? ok({ list: [medal(111, 'wall name'), medal(222, 'host two')] })
      : ok({
          111: status(111, 9001, { live_status: 1, online: 321, title: ' <em>hello</em> &amp; bye ' }),
          222: status(222, 9002, { live_status: 2, cover_from_user: '', keyframe: 'http://i0.hdslb.com/bfs/live/key.jpg', uname: '' }),
        });
  const { rooms } = await libraryLiveRooms();
  assert.deepEqual(rooms, [
    {
      roomId: '9001',
      title: 'hello & bye',
      hostName: 'wall name',
      artwork: artwork('https://i0.hdslb.com/bfs/live/cover9001.jpg'),
      status: 'live',
      online: 321,
    },
    {
      roomId: '9002',
      title: 'title 9002',
      hostName: 'host two',
      artwork: artwork('http://i0.hdslb.com/bfs/live/key.jpg'),
      status: 'offline',
      online: 0,
    },
  ]);
  // 與網址加入的 roomId 相同格式（宿主以它比對重複）。
  for (const room of rooms) {
    assert.deepEqual(liveRoomFromUrl({ url: `https://live.bilibili.com/${room.roomId}` }), { roomId: room.roomId });
  }
});

test('libraryLiveRooms: falls back to the wall avatar and Unknown title, host name from the status entry', async () => {
  reply = (req) =>
    isWall(req)
      ? ok({ list: [medal(111, '')] })
      : ok({ 111: status(111, 9001, { title: '', cover_from_user: '', keyframe: '', uname: 'uname 111', online: 'x' }) });
  const { rooms } = await libraryLiveRooms();
  assert.deepEqual(rooms, [
    {
      roomId: '9001',
      title: 'Unknown',
      hostName: 'uname 111',
      artwork: artwork('https://i0.hdslb.com/bfs/face/111.jpg'),
      status: 'offline',
      online: null,
    },
  ]);
});

test('libraryLiveRooms: skips medals without a uid, without a live room, and duplicate rooms', async () => {
  reply = (req) =>
    isWall(req)
      ? ok({
          list: [
            medal(111, 'a'),
            null,
            { target_name: 'no medal_info' },
            medal(0, 'zero uid'),
            medal(333, 'no room'),
            medal(444, 'room zero'),
            medal(555, 'same room as a'),
            medal(111, 'duplicate medal'),
          ],
        })
      : ok({ 111: status(111, 9001), 444: status(444, 0), 555: status(555, 9001), 333: null });
  const { rooms } = await libraryLiveRooms();
  assert.deepEqual(rooms.map((r) => [r.roomId, r.hostName]), [['9001', 'a']]);
  assert.deepEqual(params(requests[1]).getAll('uids[]'), ['111', '333', '444', '555']);
});

test('libraryLiveRooms: an empty wall sends no status request', async () => {
  assert.deepEqual(await libraryLiveRooms(), { rooms: [] });
  assert.equal(requests.length, 1);
  reply = () => ok({});
  assert.deepEqual(await libraryLiveRooms(), { rooms: [] });
});

test('libraryLiveRooms: no live room for anyone (empty array data) is an empty list', async () => {
  reply = (req) => (isWall(req) ? ok({ list: [medal(111, 'a')] }) : ok([]));
  assert.deepEqual(await libraryLiveRooms(), { rooms: [] });
});

test('libraryLiveRooms: more than 50 anchors go out in batches of 50', async () => {
  const uids = Array.from({ length: 120 }, (_, i) => 1000 + i);
  reply = (req) =>
    isWall(req)
      ? ok({ list: uids.map((uid) => medal(uid, `h${uid}`)) })
      : ok(Object.fromEntries(params(req).getAll('uids[]').map((uid) => [uid, status(Number(uid), Number(uid) + 5000)])));
  const { rooms } = await libraryLiveRooms();
  assert.equal(rooms.length, 120);
  assert.equal(rooms[0].roomId, '6000');
  assert.deepEqual(requests.slice(1).map((r) => params(r).getAll('uids[]').length), [50, 50, 20]);
});

test('libraryLiveRooms: no DedeUserID is AuthRequired before any request', async () => {
  for (const bad of [null, {}, { cookies: {} }, { cookies: { DedeUserID: 'abc' } }, { cookies: { DedeUserID: '0' } }]) {
    credentials = bad;
    await assert.rejects(libraryLiveRooms(), isError('AuthRequired'));
  }
  assert.equal(requests.length, 0);
});

test('libraryLiveRooms: -101 with credentials attached is CredentialInvalid', async () => {
  reply = () => err(-101, '账号未登录');
  await assert.rejects(libraryLiveRooms(), isError('CredentialInvalid'));
  assert.equal(requests.length, 1);
});

test('libraryLiveRooms: other errors', async () => {
  reply = () => err(-352);
  await assert.rejects(libraryLiveRooms(), isError('RateLimited'));
  reply = () => ({ status: 500, body: '' });
  await assert.rejects(libraryLiveRooms(), isError('NetworkError'));
  reply = () => ({ body: 'not json' });
  await assert.rejects(libraryLiveRooms(), isError('ParseError'));
  reply = () => ({ body: { code: 0, message: '0', data: null } });
  await assert.rejects(libraryLiveRooms(), isError('ParseError'));
  // 狀態批次失敗不回部分結果。
  reply = (req) => (isWall(req) ? ok({ list: [medal(111, 'a')] }) : err(-352));
  await assert.rejects(libraryLiveRooms(), isError('RateLimited'));
});
