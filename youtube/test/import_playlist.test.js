// importPlaylist：整條路徑（YouTube.js session 在內）宿主以假回應模擬，不連網。
// 第一頁用 fixtures/importPlaylist/003.json（2026-10-15 匿名 WEB browse 的真實回應，刪減過），
// 第二頁用 test/data/playlist-page2.json（同一張歌單的續取回應，同樣刪減）；其餘是手寫的變體。
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { playlistFromUrl as parseUrl, browseRequest } from '../src/playlist.js';

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
const { playlistFromUrl, importPlaylist } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`);

const read = (path) => JSON.parse(readFileSync(new URL(path, import.meta.url), 'utf8'));
const fixture = (n) => read(`../fixtures/resolveStream/00${n}.json`).response;
const bodyOf = (r) => (r.body !== undefined ? r.body : JSON.stringify(r.jsonBody));
const page1 = read('../fixtures/importPlaylist/003.json').response.jsonBody;
// 錄下的續取 token 在 fixture 裡遮成 ***（FMP 的遮蔽名單）；換成一個看得出來的假值，驗它原樣送進續取請求。
// 不放真的：續取頁是假回應，真 token 沒有用處。
const P1_TOKEN = 'P1-CONTINUATION-TOKEN%3D%3D';
{
  const items = page1.contents.twoColumnBrowseResultsRenderer.tabs[0].tabRenderer.content.sectionListRenderer.contents[0].itemSectionRenderer.contents;
  const command = items[items.length - 1].continuationItemViewModel.continuationCommand.innertubeCommand.continuationCommand;
  assert.equal(command.token, '***');
  command.token = P1_TOKEN;
}
const page2 = read('./data/playlist-page2.json');
const PLAYLIST_ID = 'PLjxrf2q8roU23XGwz3Km7sQZFTdB996iG';

const lockup = (id, badge, extra = {}) => ({
  lockupViewModel: {
    contentId: id,
    contentType: 'LOCKUP_CONTENT_TYPE_VIDEO',
    contentImage: {
      thumbnailViewModel: {
        image: { sources: [{ url: `https://i.ytimg.com/vi/${id}/hqdefault.jpg`, width: 168 }, { url: 'https://evil.example.com/x.jpg', width: 1 }] },
        overlays: badge === null ? [] : [{ thumbnailBottomOverlayViewModel: { badges: [{ thumbnailBadgeViewModel: { text: badge } }] } }],
      },
    },
    metadata: {
      lockupMetadataViewModel: {
        title: { content: `title ${id}` },
        metadata: { contentMetadataViewModel: { metadataRows: [{ metadataParts: [{ text: { content: `uploader ${id}` } }] }] } },
      },
    },
    ...extra,
  },
});
const continuationItem = (token) => ({
  continuationItemViewModel: { continuationCommand: { innertubeCommand: { continuationCommand: { token, request: 'CONTINUATION_REQUEST_TYPE_BROWSE' } } } },
});
const pageOf = (items, { title = 'My list' } = {}) => ({
  contents: { twoColumnBrowseResultsRenderer: { tabs: [{ tabRenderer: { content: { sectionListRenderer: { contents: [{ itemSectionRenderer: { contents: items } }] } } } }] } },
  header: { pageHeaderRenderer: { pageTitle: title } },
});
const alertOnly = (text) => ({ alerts: [{ alertRenderer: { type: 'ERROR', text: { runs: [{ text }] } } }] });

let browses;
let browseReply;
let credentials;
let preferenceOn;
beforeEach(() => {
  browses = [];
  browseReply = () => ({ status: 200, body: JSON.stringify(page1) });
  credentials = null;
  preferenceOn = true;
  const store = new Map();
  globalThis.fmp = {
    http: {
      request: async (r) => {
        // 宿主只在已登入且（required，或 userPreference 且開關開著）時帶憑證。
        const attached = credentials !== null && (r.auth === 'required' || (r.auth === 'userPreference' && preferenceOn));
        const reply = (body, status = 200) => ({ status, url: r.url, headers: {}, body, credentialsAttached: attached });
        if (r.url.includes('/sw.js_data')) return reply(bodyOf(fixture(1)));
        if (r.url.includes('/youtubei/v1/config')) return reply(bodyOf(fixture(2)));
        if (r.url.includes('/youtubei/v1/browse')) {
          browses.push({ body: JSON.parse(r.body), idempotent: r.idempotent, auth: r.auth, headers: r.headers, attached });
          const { status, body } = browseReply(browses.length);
          return reply(body, status);
        }
        return { status: 404, url: r.url, headers: {}, body: '' };
      },
    },
    storage: { get: async (k) => store.get(k) ?? null, set: async (k, v) => { store.set(k, v); }, delete: async (k) => { store.delete(k); } },
    credentials: { get: async () => credentials },
    log: { debug() {}, info() {}, warn() {}, error() {} },
  };
});

// ------------------------------------------------------------------ playlistFromUrl

test('playlistFromUrl: playlist urls in every accepted form', () => {
  for (const url of [
    `https://www.youtube.com/playlist?list=${PLAYLIST_ID}`,
    `https://youtube.com/playlist?list=${PLAYLIST_ID}&si=abc`,
    `https://m.youtube.com/playlist?list=${PLAYLIST_ID}`,
    `https://music.youtube.com/playlist?list=${PLAYLIST_ID}`,
    `https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=${PLAYLIST_ID}&index=3`,
    `https://youtu.be/dQw4w9WgXcQ?list=${PLAYLIST_ID}`,
    `www.youtube.com/playlist?list=${PLAYLIST_ID}`,
    `  http://www.youtube.com./playlist?list=${PLAYLIST_ID}  `,
  ]) {
    assert.deepEqual(parseUrl({ url }), { playlistId: PLAYLIST_ID }, url);
  }
  // 入口函式與模組函式一致，且不發請求。
  assert.deepEqual(playlistFromUrl({ url: `https://www.youtube.com/playlist?list=${PLAYLIST_ID}` }), { playlistId: PLAYLIST_ID });
  assert.equal(browses.length, 0);
});

test('playlistFromUrl: Mix urls and the mix: shorthand give a mixSeed', () => {
  assert.deepEqual(parseUrl({ url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=RDdQw4w9WgXcQ' }), { mixSeed: { sourceId: 'dQw4w9WgXcQ' } });
  // 沒有 v：種子取 RD 後面的。
  assert.deepEqual(parseUrl({ url: 'https://www.youtube.com/playlist?list=RDdQw4w9WgXcQ' }), { mixSeed: { sourceId: 'dQw4w9WgXcQ' } });
  // v 優先於 list 裡的。
  assert.deepEqual(parseUrl({ url: 'https://www.youtube.com/watch?v=abcdefghijk&list=RDdQw4w9WgXcQ' }), { mixSeed: { sourceId: 'abcdefghijk' } });
  assert.deepEqual(parseUrl({ url: 'mix:dQw4w9WgXcQ' }), { mixSeed: { sourceId: 'dQw4w9WgXcQ' } });
  assert.deepEqual(parseUrl({ url: '  MIX: dQw4w9WgXcQ ' }), { mixSeed: { sourceId: 'dQw4w9WgXcQ' } });
  // 種子至多 64 字、只收 [A-Za-z0-9_-]。
  assert.deepEqual(parseUrl({ url: `mix:${'a'.repeat(64)}` }), { mixSeed: { sourceId: 'a'.repeat(64) } });
  assert.equal(parseUrl({ url: `mix:${'a'.repeat(65)}` }), null);
  assert.equal(parseUrl({ url: 'mix:' }), null);
  assert.equal(parseUrl({ url: 'mix:bad id' }), null);
  assert.equal(parseUrl({ url: 'https://www.youtube.com/playlist?list=RD' }), null);
});

test('playlistFromUrl: anything else is null', () => {
  for (const url of [
    '',
    'not a url',
    'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
    'https://www.youtube.com/playlist',
    'https://www.youtube.com/playlist?list=',
    `https://evil.example.com/playlist?list=${PLAYLIST_ID}`,
    `https://youtube.com.evil.example/playlist?list=${PLAYLIST_ID}`,
    `https://attacker.example/?u=youtube.com&list=${PLAYLIST_ID}`,
    `ftp://www.youtube.com/playlist?list=${PLAYLIST_ID}`,
    'https://www.youtube.com/playlist?list=bad id!',
    `https://www.youtube.com/playlist?list=${'a'.repeat(101)}`,
  ]) {
    assert.equal(parseUrl({ url }), null, url);
  }
  assert.equal(parseUrl({}), null);
  assert.equal(parseUrl(undefined), null);
});

// ------------------------------------------------------------------ importPlaylist

test('importPlaylist: first page of the recorded playlist', async () => {
  const page = await importPlaylist({ playlistId: PLAYLIST_ID });
  assert.equal(page.items.length, 100);
  assert.deepEqual(page.items[0].track, {
    sourceId: 'lPWrd08swlw',
    title: 'SliverSemantics (Widget of the Week)',
    uploader: 'Flutter',
    durationMs: 110000,
    artwork: page1.contents.twoColumnBrowseResultsRenderer.tabs[0].tabRenderer.content.sectionListRenderer.contents[0].itemSectionRenderer.contents[0]
      .lockupViewModel.contentImage.thumbnailViewModel.image.sources.map((s) => ({ url: s.url, width: s.width })),
  });
  for (const item of page.items) {
    assert.deepEqual(Object.keys(item), ['track'], 'YouTube gives neither remoteItemId nor unavailable');
    assert.ok(item.track.sourceId && item.track.title && item.track.uploader && item.track.durationMs > 0 && item.track.artwork.length > 0);
  }
  assert.equal(page.playlist.title, 'Flutter Widget of the Week');
  assert.match(page.playlist.description, /^Fighting the good fight/);
  assert.equal(page.playlist.ownerName, 'Flutter');
  assert.deepEqual(page.playlist.artwork, page.items[0].track.artwork);
  assert.equal('writable' in page.playlist, false);
  assert.equal('total' in page, false);
  assert.match(page.cursor, /^v1:/);
  assert.equal(browses.length, 1);
  assert.equal(browses[0].body.browseId, `VL${PLAYLIST_ID}`);
  assert.equal(browses[0].body.context.client.clientName, 'WEB');
  assert.equal(browses[0].idempotent, true);
  assert.equal(browses[0].auth, 'userPreference');
  assert.equal(browses[0].headers['x-fmp-call'], undefined, 'the call hint never reaches the host');
});

test('importPlaylist: continuation reads the next token and ends with cursor null', async () => {
  const first = await importPlaylist({ playlistId: PLAYLIST_ID });
  browseReply = () => ({ status: 200, body: JSON.stringify(page2) });
  const second = await importPlaylist({ playlistId: PLAYLIST_ID, cursor: first.cursor });
  assert.equal(second.items.length, 81);
  assert.equal(second.cursor, null);
  assert.deepEqual(second.playlist, first.playlist, 'every page carries the playlist');
  assert.equal(browses[1].body.continuation, P1_TOKEN);
  assert.equal(browses[1].body.browseId, undefined);
  assert.equal(browses[1].auth, 'userPreference');
  // 兩頁合起來 181 部，影片 id 沒有重複（這張歌單沒有重複影片）。
  const ids = new Set([...first.items, ...second.items].map((i) => i.track.sourceId));
  assert.equal(ids.size, 181);
});

test('importPlaylist: an empty playlist is an empty page with cursor null', async () => {
  browseReply = () => ({ status: 200, body: JSON.stringify(pageOf([])) });
  const page = await importPlaylist({ playlistId: PLAYLIST_ID });
  assert.deepEqual(page.items, []);
  assert.equal(page.cursor, null);
  assert.equal(page.playlist.title, 'My list');
});

test('importPlaylist: items without a duration badge, or with a non-duration badge, are skipped', async () => {
  browseReply = () => ({
    status: 200,
    body: JSON.stringify(pageOf([
      lockup('okokokokok1', '3:33'),
      lockup('livelivelive', 'LIVE'),
      lockup('shortsshort1', 'SHORTS'),
      lockup('nobadgenobad', null),
      lockup('okokokokok2', '1:02:03'),
      lockup('notavideo123', '4:00', { contentType: 'LOCKUP_CONTENT_TYPE_PLAYLIST' }),
      { lockupViewModel: { contentType: 'LOCKUP_CONTENT_TYPE_VIDEO' } },
      continuationItem('TOKEN'),
    ])),
  });
  const page = await importPlaylist({ playlistId: PLAYLIST_ID });
  assert.deepEqual(page.items.map((i) => [i.track.sourceId, i.track.durationMs]), [['okokokokok1', 213000], ['okokokokok2', 3723000]]);
  // 縮圖只留 ytimg.com。
  assert.deepEqual(page.items[0].track.artwork, [{ url: 'https://i.ytimg.com/vi/okokokokok1/hqdefault.jpg', width: 168 }]);
  assert.match(page.cursor, /:TOKEN$/);
});

test('importPlaylist: the continuation after the item section is not the next page', async () => {
  const page = pageOf([lockup('okokokokok1', '3:33')]);
  page.contents.twoColumnBrowseResultsRenderer.tabs[0].tabRenderer.content.sectionListRenderer.contents.push(continuationItem('DECOY'));
  browseReply = () => ({ status: 200, body: JSON.stringify(page) });
  assert.equal((await importPlaylist({ playlistId: PLAYLIST_ID })).cursor, null);
});

test('importPlaylist: the same video twice stays two items', async () => {
  browseReply = () => ({ status: 200, body: JSON.stringify(pageOf([lockup('okokokokok1', '3:33'), lockup('okokokokok1', '3:33')])) });
  const page = await importPlaylist({ playlistId: PLAYLIST_ID });
  assert.equal(page.items.length, 2);
});

test('importPlaylist: playlistVideoRenderer items are recognised too, setVideoId is ignored', async () => {
  const renderer = (id, extra = {}) => ({
    playlistVideoRenderer: {
      videoId: id,
      setVideoId: `SET${id}`,
      title: { runs: [{ text: `title ${id}` }] },
      shortBylineText: { runs: [{ text: `uploader ${id}` }] },
      lengthText: { simpleText: '3:33' },
      lengthSeconds: '213',
      isPlayable: true,
      thumbnail: { thumbnails: [{ url: `https://i.ytimg.com/vi/${id}/default.jpg`, width: 120 }] },
      ...extra,
    },
  });
  browseReply = () => ({
    status: 200,
    body: JSON.stringify(pageOf([
      renderer('okokokokok1'),
      renderer('privateprivate', { isPlayable: false, lengthText: undefined, lengthSeconds: undefined }),
      renderer('livelivelive', { lengthText: undefined, lengthSeconds: undefined }),
    ])),
  });
  const page = await importPlaylist({ playlistId: PLAYLIST_ID });
  assert.deepEqual(page.items, [{
    track: {
      sourceId: 'okokokokok1',
      title: 'title okokokokok1',
      uploader: 'uploader okokokokok1',
      durationMs: 213000,
      artwork: [{ url: 'https://i.ytimg.com/vi/okokokokok1/default.jpg', width: 120 }],
    },
  }]);
});

test('importPlaylist: a response of the wrong shape is ParseError', async () => {
  browseReply = () => ({ status: 200, body: JSON.stringify(pageOf([lockup('okokokokok1', '3:33')], { title: '' })) });
  await assert.rejects(importPlaylist({ playlistId: PLAYLIST_ID }), (e) => e.fmpError === 'ParseError');
  // 續取的回應沒有項目。
  browseReply = () => ({ status: 200, body: JSON.stringify(page1) });
  const first = await importPlaylist({ playlistId: PLAYLIST_ID });
  browseReply = () => ({ status: 200, body: JSON.stringify({ responseContext: {} }) });
  await assert.rejects(importPlaylist({ playlistId: PLAYLIST_ID, cursor: first.cursor }), (e) => e.fmpError === 'ParseError');
});

test('importPlaylist: invalid input is ParseError and sends no request', async () => {
  for (const input of [
    { playlistId: '' },
    { playlistId: 'bad id' },
    { playlistId: 'RDdQw4w9WgXcQ' },
    { playlistId: PLAYLIST_ID, cursor: '' },
    { playlistId: PLAYLIST_ID, cursor: 'token' },
    { playlistId: PLAYLIST_ID, cursor: 'v1:%7B:token' },
    { playlistId: PLAYLIST_ID, cursor: 'v1:%7B%7D:token' },
    { playlistId: PLAYLIST_ID, cursor: `v1:${encodeURIComponent(JSON.stringify({ p: { title: '' }, r: false }))}:token` },
    { playlistId: PLAYLIST_ID, cursor: `v1:${encodeURIComponent(JSON.stringify({ p: { title: 7 }, r: false }))}:token` },
    { playlistId: PLAYLIST_ID, cursor: `v1:${encodeURIComponent(JSON.stringify({ p: { title: 'x' } }))}:` },
    {},
  ]) {
    await assert.rejects(importPlaylist(input), (e) => e.fmpError === 'ParseError', JSON.stringify(input));
  }
  assert.throws(() => browseRequest({ playlistId: PLAYLIST_ID, cursor: 7 }), (e) => e.fmpError === 'ParseError');
  assert.equal(browses.length, 0);
});

test('importPlaylist: a cursor gives back only the playlist fields the plugin put in it', async () => {
  browseReply = () => ({ status: 200, body: JSON.stringify(page2) });
  const p = { title: 'T', description: 'D', ownerName: 'O', writable: true, total: 3, artwork: [{ url: 'https://evil.example.com/a.jpg', width: 1 }] };
  const page = await importPlaylist({ playlistId: PLAYLIST_ID, cursor: `v1:${encodeURIComponent(JSON.stringify({ p, r: 'yes' }))}:tok` });
  assert.deepEqual(page.playlist, { title: 'T', description: 'D', ownerName: 'O' });
  assert.equal(browses[0].auth, 'userPreference', 'only r === true asks for required');
});

// ------------------------------------------------------------------ 錯誤與私人歌單

const gone = (text) => () => ({ status: 200, body: JSON.stringify(text ? alertOnly(text) : { responseContext: {} }) });
const isError = (kind) => (e) => e.fmpError === kind;

test('importPlaylist: a missing playlist is NotFound, with or without an alert', async () => {
  browseReply = gone('The playlist does not exist.');
  await assert.rejects(importPlaylist({ playlistId: PLAYLIST_ID }), isError('NotFound'));
  browseReply = gone(null);
  await assert.rejects(importPlaylist({ playlistId: PLAYLIST_ID }), isError('NotFound'));
  assert.equal(browses.length, 2, 'nobody is signed in: no resend');
});

test('importPlaylist: private and not signed in is AuthRequired', async () => {
  browseReply = gone('This playlist is private.');
  await assert.rejects(importPlaylist({ playlistId: PLAYLIST_ID }), isError('AuthRequired'));
  browseReply = () => ({ status: 403, body: JSON.stringify({ error: { status: 'PERMISSION_DENIED', message: 'denied' } }) });
  await assert.rejects(importPlaylist({ playlistId: PLAYLIST_ID }), isError('AuthRequired'));
  assert.equal(browses.length, 2);
});

test('private playlist, signed in but the preference is off: resent once with required', async () => {
  credentials = { cookies: { SAPISID: 'fake-sapisid' } };
  preferenceOn = false;
  browseReply = (n) => (n === 1 ? gone('This playlist is private.')() : { status: 200, body: JSON.stringify(page1) });
  const page = await importPlaylist({ playlistId: PLAYLIST_ID });
  assert.equal(page.items.length, 100);
  assert.deepEqual(browses.map((b) => [b.auth, b.attached]), [['userPreference', false], ['required', true]]);
  assert.deepEqual(browses[1].body, browses[0].body);
  assert.equal(browses[1].headers['x-fmp-call'], undefined);
  // 這一頁靠 required 讀到，下一頁也以 required 送。
  browseReply = () => ({ status: 200, body: JSON.stringify(page2) });
  await importPlaylist({ playlistId: PLAYLIST_ID, cursor: page.cursor });
  assert.equal(browses[2].auth, 'required');
});

test('private playlist, HTTP 403 without credentials: resent once with required', async () => {
  credentials = { cookies: { SAPISID: 'fake-sapisid' } };
  preferenceOn = false;
  browseReply = (n) => (n === 1 ? { status: 403, body: JSON.stringify({ error: { status: 'PERMISSION_DENIED' } }) } : { status: 200, body: JSON.stringify(page1) });
  const page = await importPlaylist({ playlistId: PLAYLIST_ID });
  assert.equal(page.items.length, 100);
  assert.deepEqual(browses.map((b) => b.auth), ['userPreference', 'required']);
});

test('private playlist denied again after the resend is NotFound, not resent a second time', async () => {
  credentials = { cookies: { SAPISID: 'fake-sapisid' } };
  preferenceOn = false;
  browseReply = gone('This playlist is private.');
  await assert.rejects(importPlaylist({ playlistId: PLAYLIST_ID }), isError('NotFound'));
  assert.deepEqual(browses.map((b) => b.auth), ['userPreference', 'required']);
});

test('denied although credentials were attached: NotFound, not resent', async () => {
  credentials = { cookies: { SAPISID: 'fake-sapisid' } };
  preferenceOn = true;
  browseReply = gone('This playlist is private.');
  await assert.rejects(importPlaylist({ playlistId: PLAYLIST_ID }), isError('NotFound'));
  assert.equal(browses.length, 1);
  assert.equal(browses[0].attached, true);
});

test('not signed in at all: denied is not resent', async () => {
  credentials = null;
  browseReply = gone('This playlist is private.');
  await assert.rejects(importPlaylist({ playlistId: PLAYLIST_ID }), isError('AuthRequired'));
  assert.equal(browses.length, 1);
});

test('a continuation page denied without credentials is resent once with required too', async () => {
  credentials = { cookies: { SAPISID: 'fake-sapisid' } };
  preferenceOn = false;
  const first = await importPlaylist({ playlistId: PLAYLIST_ID });
  browseReply = (n) => (n === 2 ? { status: 403, body: '{}' } : { status: 200, body: JSON.stringify(page2) });
  const second = await importPlaylist({ playlistId: PLAYLIST_ID, cursor: first.cursor });
  assert.equal(second.items.length, 81);
  assert.deepEqual(browses.map((b) => b.auth), ['userPreference', 'userPreference', 'required']);
});

test('HTTP 401 on the required resend is CredentialInvalid, not NotFound', async () => {
  credentials = { cookies: { SAPISID: 'fake-sapisid' } };
  preferenceOn = false;
  browseReply = (n) => (n === 1 ? gone('This playlist is private.')() : { status: 401, body: '{}' });
  await assert.rejects(importPlaylist({ playlistId: PLAYLIST_ID }), isError('CredentialInvalid'));
  assert.deepEqual(browses.map((b) => b.auth), ['userPreference', 'required']);
});

test('other HTTP errors reject as YouTube.js does and are not resent', async () => {
  credentials = { cookies: { SAPISID: 'fake-sapisid' } };
  preferenceOn = false;
  browseReply = () => ({ status: 500, body: JSON.stringify({ error: { status: 'INTERNAL' } }) });
  await assert.rejects(importPlaylist({ playlistId: PLAYLIST_ID }), /status code 500/);
  assert.equal(browses.length, 1);
});
