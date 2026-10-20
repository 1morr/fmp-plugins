// libraryPlaylists：整條路徑（YouTube.js session 在內）宿主以假回應模擬，不連網。
// 回應是手寫的：形狀照舊版 youtube_playlist_service.dart 認的兩種版面（lockupViewModel、gridPlaylistRenderer），
// 「自己的清單」的判斷（deletePlaylistEndpoint）另以 fixtures/libraryRead/003.json（登入帳號的實測，刪減重建）驗證，
// 那份的選單路徑比手寫的深得多。
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { browseRequest } from '../src/playlist.js';

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
const { libraryPlaylists } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`);

const read = (path) => JSON.parse(readFileSync(new URL(path, import.meta.url), 'utf8'));
const fixture = (n) => read(`../fixtures/resolveStream/00${n}.json`).response;
const bodyOf = (r) => (r.body !== undefined ? r.body : JSON.stringify(r.jsonBody));

const OWN_MENU = { menu: { items: [{ serviceEndpoint: { deletePlaylistEndpoint: { sourcePlaylistId: 'x' } } }] } };
const lockup = (id, title, { own = false, count = '12 videos', type = 'LOCKUP_CONTENT_TYPE_PLAYLIST' } = {}) => ({
  lockupViewModel: {
    contentId: id,
    contentType: type,
    contentImage: {
      collectionThumbnailViewModel: {
        primaryThumbnail: {
          thumbnailViewModel: {
            image: { sources: [{ url: `https://i.ytimg.com/vi/${id}/hqdefault.jpg`, width: 336 }, { url: 'https://evil.example.com/x.jpg', width: 1 }] },
            overlays: count === null ? [] : [{ thumbnailOverlayBadgeViewModel: { thumbnailBadges: [{ thumbnailBadgeViewModel: { text: count } }] } }],
          },
        },
      },
    },
    metadata: {
      lockupMetadataViewModel: {
        title: { content: title },
        metadata: { contentMetadataViewModel: { metadataRows: [{ metadataParts: [{ text: { content: 'Playlist' } }] }] } },
        ...(own ? { menuButton: OWN_MENU } : {}),
      },
    },
  },
});
const grid = (id, title, { own = false, count = '7 videos' } = {}) => ({
  gridPlaylistRenderer: {
    playlistId: id,
    title: { runs: [{ text: title }] },
    thumbnail: { thumbnails: [{ url: `https://i.ytimg.com/vi/${id}/default.jpg`, width: 120 }] },
    videoCountShortText: { simpleText: count },
    ...(own ? { menu: OWN_MENU } : {}),
  },
});
const continuation = (token) => ({
  continuationItemRenderer: { continuationEndpoint: { continuationCommand: { token, request: 'CONTINUATION_REQUEST_TYPE_BROWSE' } } },
});
const richGrid = (items) => ({
  contents: {
    twoColumnBrowseResultsRenderer: {
      tabs: [{ tabRenderer: { content: { richGridRenderer: { contents: items.map((c) => (c.continuationItemRenderer ? c : { richItemRenderer: { content: c } })) } } } }],
    },
  },
});
const continuationPage = (items) => ({ onResponseReceivedActions: [{ appendContinuationItemsAction: { continuationItems: items.map((c) => (c.continuationItemRenderer ? c : { richItemRenderer: { content: c } })) } }] });

let browses;
let browseReply;
let credentials;
beforeEach(() => {
  browses = [];
  browseReply = () => ({ status: 200, body: JSON.stringify(richGrid([])) });
  credentials = { cookies: { SAPISID: 'fake-sapisid' } };
  const store = new Map();
  globalThis.fmp = {
    http: {
      request: async (r) => {
        const attached = credentials !== null && (r.auth === 'required' || r.auth === 'userPreference');
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

const isError = (kind) => (e) => e.fmpError === kind;

test('libraryPlaylists: the recorded response marks only the own playlist writable (delete endpoint nested ~20 levels)', async () => {
  const recorded = read('../fixtures/libraryRead/003.json').response;
  browseReply = () => ({ status: recorded.status, body: bodyOf(recorded) });
  const page = await libraryPlaylists({});
  assert.deepEqual(page.playlists.map((p) => [p.playlistId, p.writable, p.trackCount]), [
    ['PLfmpTestFakePlaylistId000000000001', true, 2],
    ['WL', false, 2],
    ['LL', false, 6],
  ]);
});

test('libraryPlaylists: lockup and classic layouts, writable only for the ones with a delete endpoint', async () => {
  browseReply = () => ({
    status: 200,
    body: JSON.stringify(richGrid([
      lockup('PLown00000000000000001', ' My list ', { own: true }),
      lockup('PLsaved000000000000002', 'Saved list'),
      grid('PLgridown000000000000003', 'Grid own', { own: true }),
      grid('PLgridsaved0000000000004', 'Grid saved'),
      lockup('LL', 'Liked videos', { count: '1,234 videos' }),
    ])),
  });
  const page = await libraryPlaylists({});
  assert.equal(page.cursor, null);
  assert.deepEqual(page.playlists.map((p) => [p.playlistId, p.title, p.writable, p.trackCount]), [
    ['PLown00000000000000001', 'My list', true, 12],
    ['PLsaved000000000000002', 'Saved list', false, 12],
    ['PLgridown000000000000003', 'Grid own', true, 7],
    ['PLgridsaved0000000000004', 'Grid saved', false, 7],
    ['LL', 'Liked videos', false, 1234],
  ]);
  assert.deepEqual(page.playlists[0].artwork, [{ url: 'https://i.ytimg.com/vi/PLown00000000000000001/hqdefault.jpg', width: 336 }]);
  assert.deepEqual(page.playlists[2].artwork, [{ url: 'https://i.ytimg.com/vi/PLgridown000000000000003/default.jpg', width: 120 }]);
  assert.equal(browses.length, 1);
  assert.equal(browses[0].body.browseId, 'FEplaylist_aggregation');
  assert.equal(browses[0].body.context.client.clientName, 'WEB');
  assert.equal(browses[0].auth, 'required');
  assert.equal(browses[0].idempotent, true);
  assert.equal(browses[0].headers['x-fmp-call'], undefined, 'the call hint never reaches the host');
});

test('libraryPlaylists: every listed id is one importPlaylist accepts; Mixes and non-playlist lockups are skipped', async () => {
  browseReply = (n) => (n === 1
    ? {
        status: 200,
        body: JSON.stringify(richGrid([
          lockup('RDabcdefghijk', 'My Mix'),
          lockup('dQw4w9WgXcQ', 'A video', { type: 'LOCKUP_CONTENT_TYPE_VIDEO' }),
          lockup('bad id!', 'Bad id'),
          lockup('PLok0000000000000000005', 'Fine'),
        ])),
      }
    : { status: 200, body: JSON.stringify({ contents: {} }) });
  const { playlists } = await libraryPlaylists({});
  assert.deepEqual(playlists.map((p) => p.playlistId), ['PLok0000000000000000005']);
  // 列出來的 id 過得了 importPlaylist 的輸入驗證，Mix 的 id 過不了。
  for (const p of playlists) assert.doesNotThrow(() => browseRequest({ playlistId: p.playlistId }));
  assert.throws(() => browseRequest({ playlistId: 'RDabcdefghijk' }), isError('ParseError'));
});

test('libraryPlaylists: paging follows the continuation token with an opaque cursor', async () => {
  browseReply = (n) => (n === 1
    ? { status: 200, body: JSON.stringify(richGrid([lockup('PLa0000000000000000006', 'A'), continuation('TOKEN-1')])) }
    : { status: 200, body: JSON.stringify(continuationPage([lockup('PLb0000000000000000007', 'B')])) });
  const first = await libraryPlaylists({});
  assert.equal(first.cursor, 'v1:TOKEN-1');
  assert.deepEqual(first.playlists.map((p) => p.playlistId), ['PLa0000000000000000006']);
  const second = await libraryPlaylists({ cursor: first.cursor });
  assert.equal(second.cursor, null);
  assert.deepEqual(second.playlists.map((p) => p.playlistId), ['PLb0000000000000000007']);
  assert.equal(browses[1].body.continuation, 'TOKEN-1');
  assert.equal(browses[1].body.browseId, undefined);
  assert.equal(browses[1].auth, 'required');
});

test('libraryPlaylists: a playlist repeated across layouts is listed once', async () => {
  browseReply = () => ({
    status: 200,
    body: JSON.stringify(richGrid([lockup('PLdup0000000000000000008', 'First', { own: true }), grid('PLdup0000000000000000008', 'Second')])),
  });
  const { playlists } = await libraryPlaylists({});
  assert.equal(playlists.length, 1);
  assert.equal(playlists[0].title, 'First');
});

test('libraryPlaylists: titles and counts are normalised', async () => {
  browseReply = () => ({
    status: 200,
    body: JSON.stringify(richGrid([
      lockup('PLnotitle00000000000009', '   '),
      lockup('PLnocount00000000000010', 'No count', { count: null }),
      lockup('PLtext000000000000000011', 'Odd count', { count: '12K views' }),
      lockup('PLone0000000000000000012', 'One', { count: '1 video' }),
    ])),
  });
  const { playlists } = await libraryPlaylists({});
  assert.deepEqual(playlists.map((p) => [p.playlistId, p.trackCount]), [
    ['PLnocount00000000000010', undefined],
    ['PLtext000000000000000011', undefined],
    ['PLone0000000000000000012', 1],
  ]);
  for (const p of playlists) assert.ok(p.title.length > 0);
});

test('libraryPlaylists: empty list', async () => {
  assert.deepEqual(await libraryPlaylists({}), { playlists: [], cursor: null });
  browseReply = () => ({ status: 200, body: JSON.stringify({ contents: { twoColumnBrowseResultsRenderer: { tabs: [{ tabRenderer: { content: { richGridRenderer: { contents: [] } } } }] } } }) });
  assert.deepEqual(await libraryPlaylists(undefined), { playlists: [], cursor: null });
});

test('libraryPlaylists: malformed cursor is ParseError and sends nothing', async () => {
  for (const cursor of ['', 'v1:', 'TOKEN', 'v2:TOKEN', 7, {}]) {
    await assert.rejects(libraryPlaylists({ cursor }), isError('ParseError'), JSON.stringify(cursor));
  }
  assert.equal(browses.length, 0);
});

test('libraryPlaylists: error mapping', async () => {
  // 回應標明沒登入。
  browseReply = () => ({ status: 200, body: JSON.stringify({ responseContext: { mainAppWebResponseContext: { loggedOut: true } } }) });
  await assert.rejects(libraryPlaylists({}), isError('AuthRequired'));
  // 已登入的回應 loggedOut 為 false：照常解析。
  browseReply = () => ({ status: 200, body: JSON.stringify({ responseContext: { mainAppWebResponseContext: { loggedOut: false } }, ...richGrid([lockup('PLin00000000000000000013', 'In')]) }) });
  assert.equal((await libraryPlaylists({})).playlists.length, 1);
  // 帶了憑證的 401 是憑證失效（hostRequest 的判定表）；403 與其他 4xx／5xx 往外丟。
  browseReply = () => ({ status: 401, body: '{}' });
  await assert.rejects(libraryPlaylists({}), isError('CredentialInvalid'));
  browseReply = () => ({ status: 403, body: '{}' });
  await assert.rejects(libraryPlaylists({}));
  // 沒帶憑證的 401／403：未登入。
  credentials = null;
  browseReply = () => ({ status: 403, body: '{}' });
  await assert.rejects(libraryPlaylists({}), isError('AuthRequired'));
  browseReply = () => ({ status: 401, body: '{}' });
  await assert.rejects(libraryPlaylists({}), isError('AuthRequired'));
  credentials = { cookies: { SAPISID: 'fake-sapisid' } };
  // 形狀不對。
  browseReply = () => ({ status: 200, body: JSON.stringify([]) });
  await assert.rejects(libraryPlaylists({}), isError('ParseError'));
  browseReply = () => ({ status: 200, body: JSON.stringify({ contents: {} }) });
  await assert.rejects(libraryPlaylists({ cursor: 'v1:TOKEN' }), isError('ParseError'), 'a continuation response needs its items');
});
