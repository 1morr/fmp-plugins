// libraryPlaylists（假的宿主 API，不連網）：先 account/get 取 uid，再打 linux forward 的 user/playlist。
// 回應是手寫的（假 id、假標題、假 uid），欄位照舊專案 netease_playlist_service.dart 讀的那些。
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createDecipheriv } from 'node:crypto';

import { libraryPlaylists } from '../src/plugin.js';

const UID = '90001';

let requests;
let listReply; // (req, n) => {status?, body, credentialsAttached?}
let accountReply;
let credentials;
beforeEach(() => {
  requests = [];
  credentials = { cookies: { MUSIC_U: 'fake-music-u', __csrf: 'fake-csrf' } };
  accountReply = () => ({ body: { code: 200, profile: { userId: Number(UID), nickname: 'fake-user' } } });
  listReply = () => ({ body: { code: 200, more: false, playlist: [] } });
  globalThis.fmp = {
    log: { debug() {}, info() {}, warn() {} },
    credentials: { get: async () => credentials },
    http: {
      async request(req) {
        const attached = credentials !== null && req.auth === 'required';
        requests.push({ ...req, attached });
        const next = req.url.includes('/nuser/account/get') ? accountReply(req) : listReply(req, requests.length);
        const body = next.body;
        return { status: 200, headers: {}, url: req.url, credentialsAttached: attached, ...next, body: typeof body === 'string' ? body : JSON.stringify(body) };
      },
    },
  };
});

const isError = (kind) => (e) => e.fmpError === kind;
const isList = (req) => req.url.endsWith('/api/linux/forward');
const listRequests = () => requests.filter(isList);
/** eparams（AES-128-ECB，金鑰是舊專案的 _linuxApiKey）→ 解開後的 JSON，獨立於插件的實作。 */
const payloadOf = (req) => {
  const eparams = new URLSearchParams(req.body).get('eparams');
  const decipher = createDecipheriv('aes-128-ecb', Buffer.from('rFgB&h#%2?^eDg:Q'), null);
  return JSON.parse(Buffer.concat([decipher.update(Buffer.from(eparams, 'hex')), decipher.final()]).toString('utf8'));
};

const item = (id, extra = {}) => ({
  id,
  name: `playlist ${id}`,
  trackCount: 5,
  coverImgUrl: `http://p1.music.126.net/${id}/c.jpg`,
  creator: { userId: Number(UID), nickname: 'fake-user' },
  subscribed: false,
  ...extra,
});
const OTHER = { userId: 80002, nickname: 'someone else' };

test('libraryPlaylists: created playlists are writable, subscribed ones are not', async () => {
  listReply = () => ({
    body: {
      code: 200,
      more: false,
      playlist: [item(1001), item(1002, { creator: OTHER, subscribed: true, trackCount: 0 }), item(1003, { creator: { userId: UID } })],
    },
  });
  const page = await libraryPlaylists({});
  assert.equal(page.cursor, null);
  assert.deepEqual(page.playlists.map((p) => [p.playlistId, p.writable]), [['1001', true], ['1002', false], ['1003', true]]);
  assert.equal(page.playlists[0].title, 'playlist 1001');
  assert.equal(page.playlists[0].trackCount, 5);
  assert.equal(page.playlists[1].trackCount, 0);
  assert.deepEqual(page.playlists[0].artwork.map((a) => a.width), [120, 200, 400]);
  assert.ok(page.playlists[0].artwork[0].url.startsWith('https://p1.music.126.net/1001/c.jpg?param='));
  // playlistId 是 importPlaylist 收的字串 id。
  for (const p of page.playlists) assert.match(p.playlistId, /^[1-9]\d{0,17}$/);
});

test('libraryPlaylists: resolves the uid first, then sends the legacy linux forward request', async () => {
  listReply = () => ({ body: { code: 200, more: false, playlist: [item(1001)] } });
  await libraryPlaylists({});
  assert.equal(requests.length, 2);
  assert.ok(requests[0].url.endsWith('/api/nuser/account/get'));
  // uid 的查詢交給宿主注入憑證（網路紀錄記得到 credentials），不像 loginVerify 自己組 Cookie。
  assert.equal(requests[0].auth, 'required');
  assert.equal(requests[0].headers.Cookie, undefined);
  const req = requests[1];
  assert.equal(req.url, 'https://music.163.com/api/linux/forward');
  assert.equal(req.method, 'POST');
  assert.equal(req.auth, 'required');
  assert.match(req.headers['User-Agent'], /Linux x86_64/);
  assert.equal(req.headers['X-Real-IP'], undefined, 'no mainland address header');
  assert.deepEqual(payloadOf(req), {
    method: 'POST',
    url: 'https://music.163.com/api/user/playlist',
    params: { uid: UID, limit: 1000, offset: 0 },
  });
});

test('libraryPlaylists: paging follows `more` with an offset cursor', async () => {
  listReply = (req) =>
    payloadOf(req).params.offset === 0
      ? { body: { code: 200, more: true, playlist: [item(2001), item(2002)] } }
      : { body: { code: 200, more: false, playlist: [item(2003)] } };
  const first = await libraryPlaylists({});
  assert.equal(first.cursor, 'v1:2');
  const second = await libraryPlaylists({ cursor: first.cursor });
  assert.equal(second.cursor, null);
  assert.deepEqual(second.playlists.map((p) => p.playlistId), ['2003']);
  assert.equal(payloadOf(listRequests()[1]).params.offset, 2);
});

test('libraryPlaylists: more with an empty page ends the listing', async () => {
  listReply = () => ({ body: { code: 200, more: true, playlist: [] } });
  assert.deepEqual(await libraryPlaylists({}), { playlists: [], cursor: null });
});

test('libraryPlaylists: empty list', async () => {
  assert.deepEqual(await libraryPlaylists({}), { playlists: [], cursor: null });
  assert.deepEqual(await libraryPlaylists(undefined), { playlists: [], cursor: null });
});

test('libraryPlaylists: junk entries, duplicates, blank titles and bad counts are normalised', async () => {
  listReply = () => ({
    body: {
      code: 200,
      more: false,
      playlist: [
        item(3001, { name: '  padded  ' }),
        item(3001, { name: 'duplicate' }),
        item(3002, { name: '  ' }),
        item(3003, { trackCount: -1, coverImgUrl: 'https://evil.example.com/x.jpg' }),
        item(3004, { trackCount: 2.5, creator: null }),
        { name: 'no id' },
        { id: 0, name: 'zero id' },
        null,
        'junk',
      ],
    },
  });
  const { playlists } = await libraryPlaylists({});
  assert.deepEqual(playlists.map((p) => p.playlistId), ['3001', '3002', '3003', '3004']);
  assert.equal(playlists[0].title, 'padded');
  assert.equal(playlists[1].title, '3002', 'a blank name falls back to a non-empty title');
  assert.equal('trackCount' in playlists[2], false);
  assert.equal('artwork' in playlists[2], false);
  assert.equal('trackCount' in playlists[3], false);
  assert.equal(playlists[3].writable, false, 'no creator means not provably the account owner');
});

test('libraryPlaylists: malformed cursor is ParseError and sends nothing', async () => {
  for (const cursor of ['', 'v1:', 'v1:0', 'v1:-1', 'v1:2:0', '2', 7, {}]) {
    await assert.rejects(libraryPlaylists({ cursor }), isError('ParseError'), JSON.stringify(cursor));
  }
  assert.equal(requests.length, 0);
});

test('libraryPlaylists: no credentials is AuthRequired and sends nothing', async () => {
  credentials = null;
  await assert.rejects(libraryPlaylists({}), isError('AuthRequired'));
  assert.equal(requests.length, 0);
});

test('libraryPlaylists: error mapping', async () => {
  // 帶了憑證的 301 是憑證失效（既有的判定表）。
  listReply = () => ({ body: { code: 301, message: '需要登录' } });
  await assert.rejects(libraryPlaylists({}), isError('CredentialInvalid'));
  // 沒帶憑證的 301：未登入。
  listReply = () => ({ body: { code: 301, message: '需要登录' }, credentialsAttached: false });
  await assert.rejects(libraryPlaylists({}), isError('AuthRequired'));
  listReply = () => ({ body: { code: -460, message: '' } });
  await assert.rejects(libraryPlaylists({}), isError('VerificationRequired'));
  listReply = () => ({ body: { code: 500, message: 'x' } });
  await assert.rejects(libraryPlaylists({}), isError('UnexpectedError'));
  listReply = () => ({ status: 460, body: '' });
  await assert.rejects(libraryPlaylists({}), isError('VerificationRequired'));
  listReply = () => ({ status: 502, body: '' });
  await assert.rejects(libraryPlaylists({}), isError('NetworkError'));
  listReply = () => ({ body: 'not json' });
  await assert.rejects(libraryPlaylists({}), isError('ParseError'));
  listReply = () => ({ body: { code: 200, more: false } });
  await assert.rejects(libraryPlaylists({}), isError('ParseError'), 'no playlist list');
  // uid 解不出來：account/get 失敗就整個失敗，不送第二個請求。
  accountReply = () => ({ body: { code: 301 } });
  requests = [];
  await assert.rejects(libraryPlaylists({}), isError('CredentialInvalid'));
  assert.equal(listRequests().length, 0);
  accountReply = () => ({ body: { code: 200, profile: {} } });
  await assert.rejects(libraryPlaylists({}), isError('ParseError'));
});
