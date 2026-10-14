// live 能力：對應、篩選、網址解析、D10（失敗一律拋錯）、playUrl 取第一段、userPreference
// （假的宿主 API，不連網）。
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { liveRoomFromUrl, liveSearch, liveStatus, resolveLive } from '../src/plugin.js';

/** responses 依序回；回傳每次請求。每個 response 是 {status?, body}。 */
function fakeHost(responses) {
  const requests = [];
  const queue = [...responses];
  globalThis.fmp = {
    crypto: { md5: () => '' },
    log: { debug() {}, info() {}, warn() {} },
    storage: {
      async get() {
        return null;
      },
      async set() {},
    },
    http: {
      async request(req) {
        requests.push(req);
        const next = queue.shift();
        if (next === undefined) throw new Error(`unexpected request ${req.url}`);
        if (next instanceof Error) throw next;
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

// ---------------------------------------------------------------- liveRoomFromUrl

test('liveRoomFromUrl recognises live.bilibili.com room urls', () => {
  const cases = [
    ['https://live.bilibili.com/21452505', '21452505'],
    ['http://live.bilibili.com/123?broadcast_type=0&is_room_feed=1', '123'],
    ['live.bilibili.com/h5/456', '456'],
    ['https://live.bilibili.com/789/', '789'],
    ['https://live.bilibili.com/789#x', '789'],
    ['看看 https://live.bilibili.com/42 這個', '42'],
    ['HTTPS://LIVE.BILIBILI.COM/7', '7'],
    ['https://evil.example@live.bilibili.com/8', '8'], // userinfo：網域是 live.bilibili.com
    ['https://live.bilibili.com/h5/9?spm_id_from=a/b', '9'],
  ];
  for (const [url, roomId] of cases) assert.deepEqual(liveRoomFromUrl({ url }), { roomId }, url);
});

test('liveRoomFromUrl returns null for other urls', () => {
  const cases = [
    'https://www.bilibili.com/video/BV1xx411c79H',
    'https://live.bilibili.com/',
    'https://live.bilibili.com/p/eden/area-tags',
    'https://live.bilibili.com/abc',
    'https://live.bilibili.com/123abc',
    'https://evil-live.bilibili.com/123',
    'https://notlive.bilibili.com/123',
    'https://live.bilibili.com.evil.test/123',
    'https://example.com/?u=x.live.bilibili.com/123',
    'https://b23.tv/abcdef',
    // 網域不是 B 站，路徑裡才有 live.bilibili.com。
    'https://evil.example/live.bilibili.com/123',
    'https://evil.example/https://live.bilibili.com/123',
    'evil.example/live.bilibili.com/h5/123',
    'https://live.bilibili.com:8443/123',
    '',
    'not a url',
  ];
  for (const url of cases) assert.equal(liveRoomFromUrl({ url }), null, url);
  assert.equal(liveRoomFromUrl({ url: undefined }), null);
});

// ---------------------------------------------------------------- liveSearch

const searchBody = {
  numResults: 45,
  result: [
    {
      roomid: 111,
      uname: '<em class="keyword">主播</em>&amp;A',
      title: '<em class="keyword">唱歌</em> &quot;夜&quot;',
      user_cover: '//i0.hdslb.com/bfs/live/cover.jpg',
      online: 321,
    },
    { roomid: 0, title: 'no room' },
    { title: 'no room id' },
    { roomid: 222, uname: 'B', title: 'x', user_cover: 'https://example.com/x.jpg' },
  ],
};

test('liveSearch maps live_room results, always live, and tags userPreference', async () => {
  const requests = fakeHost([ok(searchBody)]);
  const page = await liveSearch({ keyword: '唱歌', page: 2, status: 'live' });
  assert.equal(requests.length, 1);
  assert.equal(requests[0].auth, 'userPreference');
  const url = new URL(requests[0].url);
  assert.equal(url.host, 'api.bilibili.com');
  assert.equal(url.searchParams.get('search_type'), 'live_room');
  assert.equal(url.searchParams.get('keyword'), '唱歌');
  assert.equal(url.searchParams.get('page'), '2');
  assert.equal(page.hasMore, true); // 2 * 20 < 45
  assert.equal(page.items.length, 2);
  assert.deepEqual(page.items[0], {
    roomId: '111',
    title: '唱歌 "夜"',
    hostName: '主播&A',
    artwork: [
      { url: 'https://i0.hdslb.com/bfs/live/cover.jpg@160w', width: 160 },
      { url: 'https://i0.hdslb.com/bfs/live/cover.jpg@480w', width: 480 },
      { url: 'https://i0.hdslb.com/bfs/live/cover.jpg' },
    ],
    status: 'live',
    online: 321,
  });
  assert.deepEqual(page.items[1].artwork, []);
  assert.equal(page.items[1].online, null);
});

test('liveSearch hasMore is false on the last page', async () => {
  fakeHost([ok({ numResults: 40, result: [] })]);
  assert.deepEqual(await liveSearch({ keyword: 'a', page: 2, status: 'live' }), { items: [], hasMore: false });
});

const userBody = {
  numResults: 25,
  result: [
    { mid: 10, uname: '<em class="keyword">甲</em>', room_id: 1001 },
    { mid: 20, uname: '乙', room_id: 1002 },
    { mid: 30, uname: '丙', room_id: 0 },
    { mid: 40, uname: '丁', room_id: 1004 },
    { uname: '無mid', room_id: 1005 },
  ],
};
const entry = (extra) => ({
  title: 't',
  room_id: 1001,
  live_status: 0,
  online: 0,
  cover_from_user: '',
  keyframe: 'https://i0.hdslb.com/bfs/live/k.jpg',
  uname: 'x',
  ...extra,
});

test('liveSearch status null: bili_user search + one batch request, live and offline rooms', async () => {
  const requests = fakeHost([
    ok(userBody),
    ok({
      10: entry({ title: '開播', room_id: 1001, live_status: 1, online: 77, cover_from_user: 'https://i0.hdslb.com/bfs/live/c.jpg' }),
      20: entry({ title: '沒開', room_id: 1002, live_status: 0 }),
      // 40 不在批次回應裡：丟掉
    }),
  ]);
  const page = await liveSearch({ keyword: 'k', page: 1, status: null });
  assert.equal(requests.length, 2);
  const search = new URL(requests[0].url);
  assert.equal(search.host, 'api.bilibili.com');
  assert.equal(search.searchParams.get('search_type'), 'bili_user');
  assert.equal(requests[0].auth, 'userPreference');
  // 批次：GET、重複的 uids[]，只含 mid 和 room_id 都有效的主播，順序同搜尋結果。
  assert.ok(requests[1].method === undefined || requests[1].method === 'GET');
  assert.equal(requests[1].auth, 'userPreference');
  assert.equal(
    requests[1].url,
    'https://api.live.bilibili.com/room/v1/Room/get_status_info_by_uids?uids%5B%5D=10&uids%5B%5D=20&uids%5B%5D=40',
  );
  assert.deepEqual(
    page.items.map((r) => [r.roomId, r.title, r.hostName, r.status, r.online]),
    [
      ['1001', '開播', '甲', 'live', 77],
      ['1002', '沒開', '乙', 'offline', 0],
    ],
  );
  assert.equal(page.items[0].artwork[2].url, 'https://i0.hdslb.com/bfs/live/c.jpg');
  assert.equal(page.items[1].artwork[2].url, 'https://i0.hdslb.com/bfs/live/k.jpg');
  assert.equal(page.hasMore, true); // 1 * 20 < 25
});

test('liveSearch status offline keeps only offline rooms; live uses live_room', async () => {
  fakeHost([
    ok(userBody),
    ok({
      10: entry({ room_id: 1001, live_status: 1 }),
      20: entry({ room_id: 1002, live_status: 2 }),
      40: entry({ room_id: 1004, live_status: 0 }),
    }),
  ]);
  const off = await liveSearch({ keyword: 'k', page: 1, status: 'offline' });
  assert.deepEqual(off.items.map((r) => [r.roomId, r.status]), [['1002', 'offline'], ['1004', 'offline']]);

  const requests = fakeHost([ok(searchBody)]);
  const live = await liveSearch({ keyword: 'a', page: 1, status: 'live' });
  assert.equal(live.items.length, 2);
  assert.equal(new URL(requests[0].url).searchParams.get('search_type'), 'live_room');
  assert.equal(requests.length, 1);
});

test('liveSearch anchor path: a batch whose data is not keyed by the requested uids is a ParseError', async () => {
  // 問了 uid：`[]`（PHP 的空 map）、`{}`、鍵對不上（例如改成以房號為鍵）、陣列形式，都不能變成空頁。
  const shapes = [
    [],
    {},
    { 1001: entry({ room_id: 1001 }), 1002: entry({ room_id: 1002 }) },
    [entry({ uid: 10 }), entry({ uid: 20 })],
    { 10: 'x', 20: null },
  ];
  for (const data of shapes) {
    for (const status of [null, 'offline']) {
      fakeHost([ok(userBody), ok(data)]);
      await assert.rejects(liveSearch({ keyword: 'k', page: 1, status }), (e) => {
        assert.equal(e.fmpError, 'ParseError', `${JSON.stringify(data)}: ${JSON.stringify(e)}`);
        return true;
      });
    }
  }
  // data 根本不是物件：checkCode 已經拋。
  fakeHost([ok(userBody), { body: { code: 0, data: 'x' } }]);
  await rejects(liveSearch({ keyword: 'k', page: 1, status: null }), 'ParseError');
});

test('liveSearch anchor path: an entry for another uid is a ParseError', async () => {
  fakeHost([ok(userBody), ok({ 10: entry({ uid: 99 }) })]);
  await rejects(liveSearch({ keyword: 'k', page: 1, status: null }), 'ParseError');
  // uid 是字串或缺都可以，只要對得上。
  fakeHost([ok(userBody), ok({ 10: entry({ uid: '10' }), 20: entry({ uid: undefined, room_id: 1002 }) })]);
  const page = await liveSearch({ keyword: 'k', page: 1, status: null });
  assert.deepEqual(page.items.map((r) => r.roomId), ['1001', '1002']);
});

test('liveSearch anchor path: no usable anchors means no batch request', async () => {
  const requests = fakeHost([ok({ numResults: 1, result: [{ mid: 3, room_id: 0 }] })]);
  assert.deepEqual(await liveSearch({ keyword: 'k', page: 1 }), { items: [], hasMore: false });
  assert.equal(requests.length, 1);
});

test('liveSearch anchor path throws when the batch fails or is malformed, never partial', async () => {
  fakeHost([ok(userBody), { status: 500, body: '' }]);
  await rejects(liveSearch({ keyword: 'k', page: 1, status: 'offline' }), 'NetworkError');
  fakeHost([ok(userBody), { body: { code: -352, message: '' } }]);
  await rejects(liveSearch({ keyword: 'k', page: 1, status: null }), 'RateLimited');
  fakeHost([ok(userBody), ok({ 10: entry({ live_status: 9 }) })]);
  await rejects(liveSearch({ keyword: 'k', page: 1, status: null }), 'ParseError');
  fakeHost([ok(userBody), ok({ 10: entry({ title: undefined }) })]);
  await rejects(liveSearch({ keyword: 'k', page: 1, status: null }), 'ParseError');
  fakeHost([{ body: { code: -352, message: '' } }]);
  await rejects(liveSearch({ keyword: 'k', page: 1, status: null }), 'RateLimited');
});

test('liveSearch never returns an empty title or host name (the host rejects the whole page)', async () => {
  fakeHost([
    ok({
      numResults: 2,
      result: [
        null,
        { roomid: 7, title: '<em class="keyword"></em> ', uname: ' ' },
        { roomid: 8 },
      ],
    }),
  ]);
  const live = await liveSearch({ keyword: 'a', page: 1, status: 'live' });
  assert.deepEqual(live.items.map((r) => [r.roomId, r.title, r.hostName]), [['7', 'Unknown', null], ['8', 'Unknown', null]]);

  fakeHost([
    ok({ numResults: 2, result: [{ mid: 10, uname: '', room_id: 1001 }, { mid: 20, room_id: 1002 }] }),
    ok({ 10: entry({ title: '', uname: '批次名' }), 20: entry({ title: 'ok', uname: '', room_id: 1002 }) }),
  ]);
  const anchors = await liveSearch({ keyword: 'a', page: 1, status: null });
  assert.deepEqual(
    anchors.items.map((r) => [r.roomId, r.title, r.hostName]),
    [['1001', 'Unknown', '批次名'], ['1002', 'ok', null]],
  );
});

test('liveSearch throws on failures', async () => {
  fakeHost([{ body: { code: -352, message: 'risk' } }]);
  await rejects(liveSearch({ keyword: 'a', page: 1, status: 'live' }), 'RateLimited');
  fakeHost([{ status: 500, body: '' }]);
  await rejects(liveSearch({ keyword: 'a', page: 1, status: 'live' }), 'NetworkError');
});

// ---------------------------------------------------------------- liveStatus

const roomInit = ok({ room_id: 21452505, short_id: 0, uid: 1 });
const roomInfo = (extra) =>
  ok({
    room_id: 21452505,
    title: '直播標題',
    user_cover: 'https://i0.hdslb.com/bfs/live/c.jpg',
    keyframe: 'https://i0.hdslb.com/bfs/live/k.jpg',
    online: 1234,
    live_status: 1,
    ...extra,
  });
const anchor = ok({ info: { uid: 1, uname: '主播名', face: 'https://i0.hdslb.com/bfs/face/f.jpg' } });

test('liveStatus resolves the real room id and maps the room', async () => {
  const requests = fakeHost([roomInit, roomInfo(), anchor]);
  const room = await liveStatus({ roomId: '5' });
  assert.deepEqual(
    requests.map((r) => new URL(r.url).pathname),
    ['/room/v1/Room/room_init', '/room/v1/Room/get_info', '/live_user/v1/UserInfo/get_anchor_in_room'],
  );
  assert.equal(new URL(requests[0].url).searchParams.get('id'), '5');
  assert.equal(new URL(requests[1].url).searchParams.get('room_id'), '21452505');
  assert.equal(new URL(requests[2].url).searchParams.get('roomid'), '21452505');
  for (const r of requests) {
    assert.equal(r.auth, 'userPreference');
    assert.equal(new URL(r.url).host, 'api.live.bilibili.com');
  }
  assert.equal(room.roomId, '21452505');
  assert.equal(room.title, '直播標題');
  assert.equal(room.hostName, '主播名');
  assert.equal(room.status, 'live');
  assert.equal(room.online, 1234);
  assert.equal(room.artwork.length, 3);
  assert.equal(room.artwork[2].url, 'https://i0.hdslb.com/bfs/live/c.jpg');
});

test('liveStatus returns the real room id from room_init and an Unknown title for an empty one', async () => {
  fakeHost([ok({ room_id: 5440, short_id: 1 }), roomInfo({ room_id: { weird: true }, title: '  ' }), anchor]);
  const room = await liveStatus({ roomId: '1' });
  assert.equal(room.roomId, '5440');
  assert.equal(room.title, 'Unknown');
});

test('liveStatus maps live_status 0 and 2 to offline, falls back to keyframe', async () => {
  for (const code of [0, 2]) {
    fakeHost([roomInit, roomInfo({ live_status: code, user_cover: '', online: 'x' }), anchor]);
    const room = await liveStatus({ roomId: '5' });
    assert.equal(room.status, 'offline', `live_status ${code}`);
    assert.equal(room.online, null);
    assert.equal(room.artwork[2].url, 'https://i0.hdslb.com/bfs/live/k.jpg');
  }
});

test('D10: liveStatus throws on any failure, never returns offline', async () => {
  const failures = [
    ['room_init business error', [{ body: { code: 60004, message: '直播间不存在' } }], 'NotFound'],
    ['room_init no room_id', [ok({})], 'ParseError'],
    ['room_init risk control', [{ body: { code: -352, message: '' } }], 'RateLimited'],
    ['get_info http 500', [roomInit, { status: 500, body: '' }], 'NetworkError'],
    ['get_info http 412', [roomInit, { status: 412, body: '' }], 'RateLimited'],
    ['get_info not json', [roomInit, { body: 'oops' }], 'ParseError'],
    ['get_info code != 0', [roomInit, { body: { code: 1, message: 'x' } }], 'UnexpectedError'],
    ['get_info no data', [roomInit, { body: { code: 0, data: null } }], 'ParseError'],
    ['get_info no title', [roomInit, roomInfo({ title: undefined }), anchor], 'ParseError'],
    ['get_info title not a string', [roomInit, roomInfo({ title: 5 }), anchor], 'ParseError'],
    ['get_info live_status as a string', [roomInit, roomInfo({ live_status: '1' }), anchor], 'ParseError'],
    ['get_info data is an empty array', [roomInit, ok([])], 'ParseError'],
    ['room_init data is an empty array', [ok([])], 'ParseError'],
    ['get_info live_status missing', [roomInit, roomInfo({ live_status: undefined }), anchor], 'ParseError'],
    ['get_info live_status unknown', [roomInit, roomInfo({ live_status: 9 }), anchor], 'ParseError'],
  ];
  for (const [name, responses, fmpError] of failures) {
    fakeHost(responses);
    await assert.rejects(liveStatus({ roomId: '5' }), (e) => {
      assert.equal(e.fmpError, fmpError, `${name}: ${JSON.stringify(e)}`);
      return true;
    });
  }
});

test('liveStatus returns the room without hostName when the anchor lookup fails', async () => {
  const failures = [
    { body: { code: -352, message: '' } },
    { status: 500, body: '' },
    { body: 'oops' },
    ok({ info: {} }),
    ok({}),
    Object.assign(new Error('down'), { fmpError: 'NetworkError' }),
  ];
  for (const failure of failures) {
    fakeHost([roomInit, roomInfo(), failure]);
    const room = await liveStatus({ roomId: '5' });
    assert.equal(room.hostName, null);
    assert.equal(room.title, '直播標題');
    assert.equal(room.status, 'live');
  }
});

test('liveStatus propagates transport errors and rejects bad room ids without a request', async () => {
  const boom = { fmpError: 'NetworkError', message: 'down' };
  fakeHost([boom instanceof Error ? boom : Object.assign(new Error('down'), boom)]);
  await rejects(liveStatus({ roomId: '5' }), 'NetworkError');

  const requests = fakeHost([]);
  await rejects(liveStatus({ roomId: '' }), 'NotFound');
  await rejects(liveStatus({ roomId: 'abc' }), 'NotFound');
  await rejects(liveStatus({ roomId: '12/../3' }), 'NotFound');
  assert.equal(requests.length, 0);
});

// ---------------------------------------------------------------- resolveLive

const playUrl = (durl) => ok({ current_quality: 4, durl });
const formats = [{ container: 'flv', codec: 'aac' }];

test('resolveLive asks playUrl with qn=80 and takes the first durl', async () => {
  const requests = fakeHost([
    roomInit,
    playUrl([
      {
        url: 'https://cn-gdsz.mcdn.bilivideo.cn/live-bvc/1/live_1.flv?deadline=1893456000&sign=x',
        backup_url: ['https://c.bilivideo.com/live-bvc/2/live_2.flv', 'https://evil.example.com/x.flv'],
      },
      { url: 'https://other.bilivideo.com/second.flv' },
    ]),
  ]);
  const stream = await resolveLive({ roomId: '5', formats });
  assert.equal(requests[1].auth, 'userPreference');
  const url = new URL(requests[1].url);
  assert.equal(url.pathname, '/room/v1/Room/playUrl');
  assert.equal(url.searchParams.get('cid'), '21452505');
  assert.equal(url.searchParams.get('qn'), '80');
  assert.equal(url.searchParams.get('platform'), 'web');
  assert.deepEqual(
    stream.candidates.map((c) => c.url),
    [
      'https://cn-gdsz.mcdn.bilivideo.cn/live-bvc/1/live_1.flv?deadline=1893456000&sign=x',
      'https://c.bilivideo.com/live-bvc/2/live_2.flv',
    ],
  );
  assert.equal(stream.candidates[0].expiresAt, 1893456000000);
  assert.equal(stream.candidates[1].expiresAt, null);
  assert.equal(stream.candidates[0].headers.Referer, 'https://live.bilibili.com/');
  assert.ok(stream.candidates[0].headers['User-Agent']);
  assert.equal(stream.candidates[0].headers.Cookie, undefined);
});

test('resolveLive throws when there is no usable stream', async () => {
  fakeHost([roomInit, playUrl([])]);
  await rejects(resolveLive({ roomId: '5', formats }), 'NotFound');
  fakeHost([roomInit, ok({})]);
  await rejects(resolveLive({ roomId: '5', formats }), 'NotFound');
  fakeHost([roomInit, playUrl([{ url: '' }])]);
  await rejects(resolveLive({ roomId: '5', formats }), 'NotFound');
  // 全部網域都不在 allowedHosts：不回空候選。
  fakeHost([roomInit, playUrl([{ url: 'https://evil.example.com/a.flv' }])]);
  await rejects(resolveLive({ roomId: '5', formats }), 'Unavailable');
  fakeHost([roomInit, { body: { code: -352, message: '' } }]);
  await rejects(resolveLive({ roomId: '5', formats }), 'RateLimited');
  fakeHost([{ body: { code: 60004, message: '' } }]);
  await rejects(resolveLive({ roomId: '5', formats }), 'NotFound');
});
