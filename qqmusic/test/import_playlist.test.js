// importPlaylist（假的宿主 API，不連網）：網址辨識、請求與簽名、解析、分頁與完整性、錯誤對應。
// 回應形狀照 2026-10-21 匿名實測的官方歌單（見 fixtures/importPlaylist 與 README），其餘是手寫的變體。
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import { importPlaylist, playlistFromUrl } from '../src/plugin.js';
import { signOf } from '../src/sign.js';

const ID = '9780162922';
const md5 = (text) => createHash('md5').update(text, 'utf8').digest('hex');

// ------------------------------------------------------------------ 假宿主

let requests;
let reply; // (req, n) => {status?, url?, body}
beforeEach(() => {
  requests = [];
  reply = () => ({ body: pageBody(songs(3)) });
  globalThis.fmp = {
    log: { debug() {}, info() {}, warn() {} },
    crypto: { md5 },
    http: {
      async request(req) {
        requests.push(req);
        const next = reply(req, requests.length);
        const body = next.body;
        return { status: 200, headers: {}, url: req.url, ...next, body: typeof body === 'string' ? body : JSON.stringify(body) };
      },
    },
  };
});

const isError = (kind) => (e) => e.fmpError === kind;
const bodyOf = (req) => JSON.parse(req.body);

const song = (n, extra = {}) => ({
  id: 1000 + n,
  mid: `mid${n}`,
  name: `song ${n}`,
  interval: 200 + n,
  singer: [{ id: 1, mid: 's1', name: 'a' }, { id: 2, mid: 's2', name: 'b' }],
  album: { name: 'album', mid: 'am' },
  ...extra,
});
const songs = (count, from = 1) => Array.from({ length: count }, (_, i) => song(from + i));
const pageBody = (list, { songnum = list.length, dirinfo = {}, data = {}, code = 0, reqCode = 0 } = {}) => ({
  code,
  req_0: {
    code: reqCode,
    data: {
      code: 0,
      dirinfo: { id: Number(ID), picurl: 'https://music-file.y.qq.com/songlist/u/x/a.jpg?imageView2/4/w/600/h/600', title: ' 0921·生日快乐 ', desc: '官方歌單', songnum, host_nick: 'QQ音乐', creator: { nick: 'QQ音乐' }, ...dirinfo },
      songlist: list,
      total_song_num: songnum,
      hasmore: 0,
      ...data,
    },
  },
});

// ------------------------------------------------------------------ playlistFromUrl

test('playlistFromUrl recognises the QQ playlist url forms', async () => {
  const forms = [
    'https://y.qq.com/n/ryqq/playlist/8407701300',
    'https://y.qq.com/n/ryqq_v2/playlist/8407701300',
    'https://y.qq.com/n/yqq/playlist/8407701300.html',
    'y.qq.com/n/ryqq/playlist/8407701300',
    'http://y.qq.com/n/ryqq/playlist/8407701300?ADTAG=x',
    ' https://y.qq.com/n/ryqq/playlist/8407701300#top ',
    'https://i.y.qq.com/n2/m/share/details/taoge.html?id=8407701300',
    'https://i.y.qq.com/n2/m/share/details/taoge.html?ADTAG=a&id=8407701300&source=b',
    'https://i2.y.qq.com/n3/other/pages/details/playlist.html?appversion=1&id=8407701300&ADTAG=wxfshare&appshare=iphone_wx',
  ];
  for (const url of forms) {
    assert.deepEqual(await playlistFromUrl({ url }), { playlistId: '8407701300' }, url);
  }
  assert.equal(requests.length, 0, 'no request for a full url');
});

test('playlistFromUrl returns null for urls that are not a QQ playlist', async () => {
  const others = [
    '',
    '   ',
    'not a url',
    'ftp://y.qq.com/n/ryqq/playlist/8407701300',
    'https://music.163.com/#/playlist?id=19723756',
    'https://evil.example/y.qq.com/n/ryqq/playlist/8407701300',
    'https://y.qq.com.evil.example/n/ryqq/playlist/8407701300',
    'https://user@y.qq.com/n/ryqq/playlist/8407701300',
    'https://y.qq.com/n/ryqq/songDetail/003abc',
    'https://y.qq.com/n/ryqq/playlist/abc',
    'https://y.qq.com/n/ryqq/playlist/',
    'https://y.qq.com/n/ryqq/album/8407701300?id=1',
    'https://i.y.qq.com/n2/m/share/details/taoge.html?id=abc',
    'https://i.y.qq.com/n2/m/share/details/taoge.html',
    'https://i.y.qq.com/n2/m/share/details/toplist.html?id=26',
    'https://i2.y.qq.com/n3/other/pages/details/album.html?id=8407701300',
    'https://i2.y.qq.com/n3/other/pages/playlist.html?id=8407701300',
    'https://i2.y.qq.com/n3/other/pages/details/playlist.html',
    'https://c7.y.qq.com/base/fcgi-bin/u?__=AbCd',
  ];
  for (const url of others) assert.equal(await playlistFromUrl({ url }), null, url);
  assert.equal(await playlistFromUrl({}), null);
  assert.equal(await playlistFromUrl(undefined), null);
  assert.equal(requests.length, 0);
});

test('a short url is followed once and recognised on the final url', async () => {
  reply = () => ({ url: 'https://i.y.qq.com/n2/m/share/details/taoge.html?id=8407701300&x=1', body: '<html></html>' });
  assert.deepEqual(await playlistFromUrl({ url: 'https://c.y.qq.com/base/fcgi-bin/u?__=AbCd' }), { playlistId: '8407701300' });
  assert.equal(requests.length, 1);
  assert.equal(requests[0].method, 'GET');
  assert.equal(requests[0].url, 'https://c.y.qq.com/base/fcgi-bin/u?__=AbCd');
  assert.equal(requests[0].auth, 'never');

  reply = () => ({ url: 'https://y.qq.com/n/ryqq/playlist/8407701300', body: '' });
  assert.deepEqual(await playlistFromUrl({ url: 'https://url.cn/5abcde' }), { playlistId: '8407701300' });

  // 現在 App 分享出的短網址。
  reply = () => ({ url: 'https://i2.y.qq.com/n3/other/pages/details/playlist.html?id=8407701300&appshare=android_qq', body: '' });
  assert.deepEqual(await playlistFromUrl({ url: 'https://c6.y.qq.com/base/fcgi-bin/u?__=AbCd' }), { playlistId: '8407701300' });
  assert.equal(requests.at(-1).url, 'https://c6.y.qq.com/base/fcgi-bin/u?__=AbCd');
});

test('a short url that lands outside a QQ playlist is null; a dead one is NotFound', async () => {
  reply = () => ({ url: 'https://y.qq.com/n/ryqq/index', body: '' });
  assert.equal(await playlistFromUrl({ url: 'https://url.cn/5abcde' }), null);
  reply = () => ({ url: 'https://elsewhere.example/n/ryqq/playlist/8407701300', body: '' });
  assert.equal(await playlistFromUrl({ url: 'https://url.cn/5abcde' }), null);
  reply = () => ({ status: 404, body: '' });
  await assert.rejects(playlistFromUrl({ url: 'https://url.cn/5abcde' }), isError('NotFound'));
  reply = () => ({ status: 503, body: '' });
  await assert.rejects(playlistFromUrl({ url: 'https://url.cn/5abcde' }), isError('NetworkError'));
});

// ------------------------------------------------------------------ importPlaylist：請求

test('the request is signed over its own body, anonymous, and asks for 1000 songs', async () => {
  await importPlaylist({ playlistId: ID });
  assert.equal(requests.length, 1);
  const req = requests[0];
  assert.equal(req.method, 'POST');
  assert.equal(req.auth, 'never');
  assert.equal(req.idempotent, true);
  const url = new URL(req.url);
  assert.equal(`${url.origin}${url.pathname}`, 'https://u6.y.qq.com/cgi-bin/musics.fcg');
  assert.deepEqual([...url.searchParams.keys()], ['sign']);
  assert.equal(url.searchParams.get('sign'), signOf(req.body, md5));
  assert.equal(req.headers.Referer, 'https://y.qq.com/');
  assert.match(req.headers['User-Agent'], /Android 10/);
  const body = bodyOf(req);
  assert.deepEqual(body.req_0, {
    module: 'music.srfDissInfo.aiDissInfo',
    method: 'uniform_get_Dissinfo',
    param: { disstid: 9780162922, enc_host_uin: '', tag: 1, userinfo: 1, song_begin: 0, song_num: 1000 },
  });
  assert.deepEqual(body.comm, { g_tk: 5381, uin: 0, format: 'json', platform: 'android', ct: 24, cv: 0 });
  assert.equal(req.headers.Cookie, undefined);
});

// ------------------------------------------------------------------ importPlaylist：解析

test('maps the playlist and the tracks; sourceId is the song mid', async () => {
  reply = () => ({ body: pageBody(songs(3)) });
  const page = await importPlaylist({ playlistId: ID });
  assert.deepEqual(page.playlist, {
    title: '0921·生日快乐',
    description: '官方歌單',
    artwork: [{ url: 'https://music-file.y.qq.com/songlist/u/x/a.jpg?imageView2/4/w/600/h/600' }],
    ownerName: 'QQ音乐',
  });
  assert.equal(page.cursor, null);
  assert.equal(page.total, 3);
  assert.deepEqual(page.items[0], { track: { sourceId: 'mid1', title: 'song 1', uploader: 'a / b', durationMs: 201000 } });
  assert.deepEqual(page.items.map((i) => i.track.sourceId), ['mid1', 'mid2', 'mid3']);
});

test('singers are joined with " / ", blanks dropped; no singers means no uploader', async () => {
  reply = () => ({
    body: pageBody([
      song(1, { singer: [{ name: ' x ' }, { name: '' }, { id: 3 }, null, { name: 'y' }, { name: 'z' }] }),
      song(2, { singer: [] }),
      song(3, { singer: undefined }),
    ]),
  });
  const { items } = await importPlaylist({ playlistId: ID });
  assert.equal(items[0].track.uploader, 'x / y / z');
  assert.equal('uploader' in items[1].track, false);
  assert.equal('uploader' in items[2].track, false);
});

test('duration is interval seconds in milliseconds; a missing or invalid one is omitted', async () => {
  reply = () => ({ body: pageBody([song(1, { interval: 0 }), song(2, { interval: undefined }), song(3, { interval: -5 }), song(4, { interval: '12' })]) });
  const { items } = await importPlaylist({ playlistId: ID });
  assert.equal(items[0].track.durationMs, 0);
  for (const i of [1, 2, 3]) assert.equal('durationMs' in items[i].track, false);
});

test('songs without a usable mid or title are skipped, so the count falls short of total', async () => {
  reply = () => ({ body: pageBody([song(1), song(2, { mid: '' }), song(3, { mid: undefined }), song(4, { mid: 'a:b' }), song(5, { name: ' ' }), null, 'x', song(6)]) });
  const page = await importPlaylist({ playlistId: ID });
  assert.deepEqual(page.items.map((i) => i.track.sourceId), ['mid1', 'mid6']);
  assert.equal(page.total, 8);
  assert.equal(page.cursor, null);
});

test('an empty playlist is a complete, empty page', async () => {
  reply = () => ({ body: pageBody([], { songnum: 0 }) });
  const page = await importPlaylist({ playlistId: ID });
  assert.deepEqual(page.items, []);
  assert.equal(page.total, 0);
  assert.equal(page.cursor, null);
});

test('description, cover and owner are left out when blank or not usable', async () => {
  reply = () => ({ body: pageBody(songs(1), { dirinfo: { desc: '  ', picurl: 'https://elsewhere.example/a.jpg', creator: undefined, host_nick: '' } }) });
  assert.deepEqual((await importPlaylist({ playlistId: ID })).playlist, { title: '0921·生日快乐' });
});

test('cover: http is upgraded to https; hosts outside y.qq.com and empty ones are dropped', async () => {
  const cover = async (picurl) => {
    reply = () => ({ body: pageBody(songs(1), { dirinfo: { picurl } }) });
    return (await importPlaylist({ playlistId: ID })).playlist.artwork;
  };
  assert.deepEqual(await cover('http://y.qq.com/a.jpg'), [{ url: 'https://y.qq.com/a.jpg' }]);
  for (const bad of ['', undefined, 'ftp://y.qq.com/a.jpg', 'https://evil.example/y.qq.com/a.jpg', 'https://y.qq.com.evil.example/a.jpg']) {
    assert.equal(await cover(bad), undefined, String(bad));
  }
});

// ------------------------------------------------------------------ importPlaylist：分頁與完整性

// 假伺服器：照 song_begin 切片，每頁最多 cap 首（匿名且沒有 ct/cv 時實測 cap 是 30）。
function pagedServer(all, cap) {
  return (req) => {
    const { song_begin: begin, song_num: num } = bodyOf(req).req_0.param;
    const slice = all.slice(begin, begin + Math.min(num, cap));
    return { body: pageBody(slice, { songnum: all.length }) };
  };
}

async function walk(all, cap) {
  reply = pagedServer(all, cap);
  const items = [];
  let cursor;
  let total;
  let pages = 0;
  do {
    const page = await importPlaylist({ playlistId: ID, cursor });
    items.push(...page.items);
    cursor = page.cursor;
    total = page.total;
    pages += 1;
    assert.ok(pages < 100, 'cursor must advance');
  } while (cursor);
  return { items, total, pages };
}

test('a server that caps pages is walked to the end by the received count', async () => {
  const all = songs(95);
  const { items, total, pages } = await walk(all, 30);
  assert.equal(pages, 4);
  assert.equal(items.length, 95);
  assert.equal(total, 95);
  assert.deepEqual(items.map((i) => i.track.sourceId), all.map((s) => s.mid));
  assert.deepEqual(requests.map((r) => bodyOf(r).req_0.param.song_begin), [0, 30, 60, 90]);
  assert.ok(requests.every((r) => bodyOf(r).req_0.param.song_num === 1000));
});

test('a server that honours 1000 gives everything in one page without a cursor', async () => {
  const { items, total, pages } = await walk(songs(581), 1000);
  assert.equal(pages, 1);
  assert.equal(items.length, 581);
  assert.equal(total, 581);
});

test('the cursor is the received count; an exact multiple boundary ends cleanly', async () => {
  reply = pagedServer(songs(60), 30);
  const first = await importPlaylist({ playlistId: ID });
  assert.equal(first.cursor, 'v1:30');
  const second = await importPlaylist({ playlistId: ID, cursor: first.cursor });
  assert.equal(second.cursor, null);
  assert.equal(second.items[0].track.sourceId, 'mid31');
});

test('an empty page before the end stops the walk and leaves the count short of total (incomplete)', async () => {
  const all = songs(100);
  reply = (req) => {
    const begin = bodyOf(req).req_0.param.song_begin;
    return { body: pageBody(begin === 0 ? all.slice(0, 30) : [], { songnum: 100 }) };
  };
  const first = await importPlaylist({ playlistId: ID });
  assert.equal(first.cursor, 'v1:30');
  const second = await importPlaylist({ playlistId: ID, cursor: first.cursor });
  assert.equal(second.cursor, null, 'no endless loop');
  assert.equal(second.items.length, 0);
  assert.equal(second.total, 100);
  assert.ok(first.items.length + second.items.length < second.total);
});

test('a failed page throws instead of ending the walk', async () => {
  const all = songs(90);
  reply = (req, n) => (n === 2 ? { status: 502, body: '' } : pagedServer(all, 30)(req));
  const first = await importPlaylist({ playlistId: ID });
  assert.equal(first.cursor, 'v1:30');
  await assert.rejects(importPlaylist({ playlistId: ID, cursor: first.cursor }), isError('NetworkError'));
});

test('invalid playlistId and cursor are ParseError and send nothing', async () => {
  for (const playlistId of [undefined, null, 5, '', 'abc', '0', '012', '12.5', '-3', '99999999999999999999']) {
    await assert.rejects(importPlaylist({ playlistId }), isError('ParseError'), String(playlistId));
  }
  for (const cursor of ['x', 'v1:', 'v1:0', 'v1:-1', 'v1:30:0', 'v2:30', '30', 30, 'v1:99999999']) {
    await assert.rejects(importPlaylist({ playlistId: ID, cursor }), isError('ParseError'), String(cursor));
  }
  await assert.rejects(importPlaylist(undefined), isError('ParseError'));
  assert.equal(requests.length, 0);
});

// ------------------------------------------------------------------ importPlaylist：錯誤對應

test('HTTP errors: 5xx is NetworkError, other non-200 is UnexpectedError', async () => {
  reply = () => ({ status: 503, body: '' });
  await assert.rejects(importPlaylist({ playlistId: ID }), isError('NetworkError'));
  reply = () => ({ status: 403, body: '' });
  await assert.rejects(importPlaylist({ playlistId: ID }), isError('UnexpectedError'));
});

test('a rejected sign (code 2000 at top and req_0) is UnexpectedError, not an empty playlist', async () => {
  reply = () => ({ body: { code: 2000, ts: 1, req_0: { code: 2000 } } });
  await assert.rejects(importPlaylist({ playlistId: ID }), isError('UnexpectedError'));
  reply = () => ({ body: { code: 0, req_0: { code: 2000 } } });
  await assert.rejects(importPlaylist({ playlistId: ID }), isError('UnexpectedError'));
  reply = () => ({ body: { code: 0 } });
  await assert.rejects(importPlaylist({ playlistId: ID }), isError('UnexpectedError'));
});

test('a playlist that does not exist (data code -100006, empty shell) is NotFound', async () => {
  const shell = {
    code: 0,
    req_0: { code: 0, data: { code: -100006, msg: 'get diss info from tmem error', dirinfo: { id: 12345, title: '', songnum: 0 }, songlist: [] } },
  };
  reply = () => ({ body: shell });
  await assert.rejects(importPlaylist({ playlistId: '12345' }), isError('NotFound'));
  // 只有空殼、data.code 不同也一樣不是一張空歌單。
  shell.req_0.data.code = 0;
  await assert.rejects(importPlaylist({ playlistId: '12345' }), isError('NotFound'));
});

test('an unknown data code is UnexpectedError', async () => {
  reply = () => ({ body: pageBody(songs(1), { data: { code: -1, msg: 'x' } }) });
  await assert.rejects(importPlaylist({ playlistId: ID }), isError('UnexpectedError'));
});

test('malformed responses are ParseError', async () => {
  const cases = [
    'not json',
    '[]',
    'null',
    { code: 0, req_0: { code: 0 } },
    pageBody(songs(1), { data: { songlist: undefined } }),
    pageBody(songs(1), { data: { songlist: 'x' } }),
    pageBody(songs(1), { dirinfo: { title: undefined } }),
    pageBody(songs(1), { dirinfo: { title: '  ' } }),
    pageBody(songs(1), { dirinfo: { songnum: '3' } }),
    pageBody(songs(1), { dirinfo: { songnum: -1 } }),
    pageBody(songs(1), { data: { dirinfo: null } }),
  ];
  for (const body of cases) {
    reply = () => ({ body });
    await assert.rejects(importPlaylist({ playlistId: ID }), isError('ParseError'), JSON.stringify(body).slice(0, 80));
  }
});
