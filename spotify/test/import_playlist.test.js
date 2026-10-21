// importPlaylist（假的宿主 API，不連網）。
// embed 頁的形狀照 2026-10-21 匿名實測的官方歌單（見 fixtures/importPlaylist 與 README），其餘是手寫的變體。
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { importPlaylist, playlistFromUrl } from '../src/plugin.js';

const ID = '37i9dQZF1DXcBWIGoYBM5M';
const NBSP = '\u00A0';

// ------------------------------------------------------------------ 假宿主

let requests;
let reply; // (req, n) => {status?, url?, body}
beforeEach(() => {
  requests = [];
  reply = () => ({ body: '' });
  globalThis.fmp = {
    log: { debug() {}, info() {}, warn() {} },
    http: {
      async request(req) {
        requests.push(req);
        return { status: 200, headers: {}, url: req.url, ...reply(req, requests.length) };
      },
    },
  };
});

const isError = (kind) => (e) => e.fmpError === kind;

const track = (n, extra = {}) => ({
  uri: `spotify:track:T${String(n).padStart(5, '0')}`,
  uid: '6e4a782b54436844635930',
  title: `song ${n}`,
  subtitle: `artist a,${NBSP}artist b`,
  duration: 200000 + n,
  isPlayable: true,
  entityType: 'track',
  ...extra,
});
const range = (count) => Array.from({ length: count }, (_, i) => track(i + 1));

function embedPage(trackList, entityExtra = {}) {
  const data = {
    props: {
      pageProps: {
        state: {
          data: {
            entity: {
              type: 'playlist',
              name: 'Today’s Top Hits',
              title: 'Today’s Top Hits',
              subtitle: 'Spotify',
              coverArt: { sources: [{ height: null, width: null, url: 'https://i.scdn.co/image/ab67706f0000000230888e59410296f950502d00' }] },
              attributes: [
                { key: 'status', value: 'PUBLISHED' },
                { key: 'episode_description', value: 'The hottest 50.' },
              ],
              trackList,
              ...entityExtra,
            },
          },
          settings: { session: { accessToken: 'redacted', isAnonymous: true } },
        },
      },
    },
  };
  return `<!DOCTYPE html><html><head></head><body><script id="__NEXT_DATA__" type="application/json">${JSON.stringify(data)}</script></body></html>`;
}

// ------------------------------------------------------------------ playlistFromUrl

test('playlistFromUrl: every accepted form of a playlist url', async () => {
  for (const url of [
    `https://open.spotify.com/playlist/${ID}`,
    `https://open.spotify.com/playlist/${ID}?si=abcdef0123456789`,
    `https://open.spotify.com/playlist/${ID}?si=abc&pt=def`,
    `http://open.spotify.com/playlist/${ID}`,
    `open.spotify.com/playlist/${ID}`,
    `  https://open.spotify.com/playlist/${ID}  `,
    `https://OPEN.SPOTIFY.COM/playlist/${ID}`,
    `https://open.spotify.com/intl-zh/playlist/${ID}`,
    `https://open.spotify.com/intl-pt-br/playlist/${ID}?si=abc`,
    `https://open.spotify.com/playlist/${ID}#section`,
  ]) {
    assert.deepEqual(await playlistFromUrl({ url }), { playlistId: ID }, url);
  }
  assert.equal(requests.length, 0, 'recognising a playlist url sends no request');
});

test('playlistFromUrl: urls that are not a Spotify playlist return null without a request', async () => {
  for (const url of [
    '',
    '   ',
    'not a url',
    `https://open.spotify.com/album/${ID}`,
    `https://open.spotify.com/track/${ID}`,
    'https://open.spotify.com/playlist/',
    'https://open.spotify.com/playlist',
    `https://open.spotify.com/intl-zh/album/${ID}`,
    `https://open.spotify.com/user/someone/playlist/${ID}`,
    `https://open.spotify.com/embed/playlist/${ID}`,
    `https://example.com/playlist/${ID}`,
    `https://open.spotify.com.evil.example/playlist/${ID}`,
    `https://user@open.spotify.com/playlist/${ID}`,
    `ftp://open.spotify.com/playlist/${ID}`,
    `spotify:playlist:${ID}`,
    'https://music.163.com/#/playlist?id=19723756',
  ]) {
    assert.equal(await playlistFromUrl({ url }), null, JSON.stringify(url));
  }
  assert.equal(await playlistFromUrl(undefined), null);
  assert.equal(await playlistFromUrl({ url: 5 }), null);
  assert.equal(requests.length, 0);
});

test('playlistFromUrl: a spotify.link short url is resolved with one anonymous GET', async () => {
  reply = () => ({ url: `https://open.spotify.com/playlist/${ID}?si=zzz` });
  assert.deepEqual(await playlistFromUrl({ url: 'https://spotify.link/AbC123xyz' }), { playlistId: ID });
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, 'https://spotify.link/AbC123xyz');
  assert.equal(requests[0].method, 'GET');
  assert.equal(requests[0].auth, 'never');
});

test('playlistFromUrl: a short url that lands elsewhere is null; a dead one is NotFound; a server error is NetworkError', async () => {
  reply = () => ({ url: `https://open.spotify.com/album/${ID}` });
  assert.equal(await playlistFromUrl({ url: 'https://spotify.link/AbC' }), null);
  reply = () => ({ status: 404, url: 'https://spotify.link/AbC' });
  await assert.rejects(playlistFromUrl({ url: 'https://spotify.link/AbC' }), isError('NotFound'));
  reply = () => ({ status: 503, url: 'https://spotify.link/AbC' });
  await assert.rejects(playlistFromUrl({ url: 'https://spotify.link/AbC' }), isError('NetworkError'));
});

// ------------------------------------------------------------------ importPlaylist

test('importPlaylist: playlist data and tracks from the embed page', async () => {
  reply = () => ({ body: embedPage(range(3)) });
  const page = await importPlaylist({ playlistId: ID });
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, `https://open.spotify.com/embed/playlist/${ID}`);
  assert.equal(requests[0].auth, 'never');
  assert.deepEqual(page.playlist, {
    title: 'Today’s Top Hits',
    ownerName: 'Spotify',
    description: 'The hottest 50.',
    artwork: [{ url: 'https://i.scdn.co/image/ab67706f0000000230888e59410296f950502d00' }],
  });
  assert.deepEqual(page.items[0], {
    track: { sourceId: 'T00001', title: 'song 1', uploader: 'artist a / artist b', durationMs: 200001 },
  });
  assert.equal(page.items.length, 3);
  assert.equal(page.cursor, null, 'there is only one page');
  assert.equal(page.truncated, undefined, 'a page below the embed limit is the whole playlist');
  assert.equal(page.total, undefined);
});

test('importPlaylist: sourceId is the track id from the uri, not the internal uid', async () => {
  reply = () => ({ body: embedPage([track(1, { uri: 'spotify:track:3XmwAZpIMNpTJy8faw3ajD' })]) });
  const page = await importPlaylist({ playlistId: ID });
  assert.equal(page.items[0].track.sourceId, '3XmwAZpIMNpTJy8faw3ajD');
});

test('importPlaylist: artists are split on a comma with U+00A0 only and joined with " / "', async () => {
  reply = () =>
    ({
      body: embedPage([
        track(1, { subtitle: `A,${NBSP}B,${NBSP}C` }),
        // 名字本身的逗號後面是一般空白，不是分隔。
        track(2, { subtitle: 'Tyler, The Creator' }),
        track(3, { subtitle: `Tyler, The Creator,${NBSP}Kali Uchis` }),
        track(4, { subtitle: 'Solo' }),
        track(5, { subtitle: '' }),
        track(6, { subtitle: undefined }),
      ]),
    });
  const uploaders = (await importPlaylist({ playlistId: ID })).items.map((i) => i.track.uploader);
  assert.deepEqual(uploaders, [
    'A / B / C',
    'Tyler, The Creator',
    'Tyler, The Creator / Kali Uchis',
    'Solo',
    undefined,
    undefined,
  ]);
});

test('importPlaylist: optional fields are left out when the page has none', async () => {
  reply = () =>
    ({ body: embedPage([track(1, { duration: undefined })], { subtitle: undefined, coverArt: undefined, attributes: undefined }) });
  const page = await importPlaylist({ playlistId: ID });
  assert.deepEqual(page.playlist, { title: 'Today’s Top Hits' });
  assert.deepEqual(Object.keys(page.items[0].track).sort(), ['sourceId', 'title', 'uploader']);
});

test('importPlaylist: cover art outside the allowed hosts is dropped', async () => {
  reply = () =>
    ({
      body: embedPage([], {
        coverArt: { sources: [{ url: 'https://evil.example/x.jpg' }, { url: 'http://i.scdn.co/y.jpg' }, { url: 'https://i.scdn.co/z.jpg', width: 300 }] },
      }),
    });
  assert.deepEqual((await importPlaylist({ playlistId: ID })).playlist.artwork, [{ url: 'https://i.scdn.co/z.jpg', width: 300 }]);
});

test('importPlaylist: items that are not tracks are skipped; the title falls back to entity.title', async () => {
  reply = () =>
    ({
      body: embedPage(
        [track(1), track(2, { uri: 'spotify:episode:abc' }), track(3, { title: '' }), track(4, { uri: undefined }), null, 'x', track(5)],
        { name: undefined },
      ),
    });
  const page = await importPlaylist({ playlistId: ID });
  assert.deepEqual(page.items.map((i) => i.track.sourceId), ['T00001', 'T00005']);
  assert.equal(page.playlist.title, 'Today’s Top Hits');
});

test('importPlaylist: an empty playlist is an empty page, not an error', async () => {
  reply = () => ({ body: embedPage([]) });
  const page = await importPlaylist({ playlistId: ID });
  assert.deepEqual(page.items, []);
  assert.equal(page.cursor, null);
});

// ---- 完整性：embed 頁最多 100 首，沒有總數

test('importPlaylist: 99 tracks is the whole playlist', async () => {
  reply = () => ({ body: embedPage(range(99)) });
  const page = await importPlaylist({ playlistId: ID });
  assert.equal(page.items.length, 99);
  assert.equal(page.cursor, null);
  assert.equal(page.truncated, undefined);
});

test('importPlaylist: exactly 100 tracks may be a truncated list, so the last page says truncated', async () => {
  reply = () => ({ body: embedPage(range(100)) });
  const page = await importPlaylist({ playlistId: ID });
  assert.equal(page.items.length, 100);
  assert.equal(page.cursor, null);
  assert.equal(page.truncated, true);
  assert.equal(page.total, undefined, 'the page has no total, so none is claimed');
});

test('importPlaylist: skipped entries do not hide a truncation (the raw count decides)', async () => {
  reply = () => ({ body: embedPage([...range(98), track(99, { uri: 'spotify:episode:x' }), track(100, { title: '' })]) });
  const page = await importPlaylist({ playlistId: ID });
  assert.equal(page.items.length, 98);
  assert.equal(page.cursor, null);
  assert.equal(page.truncated, true);
});

test('importPlaylist: any cursor (there is no second page) or a bad playlistId is a ParseError and sends no request', async () => {
  await assert.rejects(importPlaylist({ playlistId: ID, cursor: 'embed-limit' }), isError('ParseError'));
  for (const playlistId of [undefined, '', 5, 'a/b', 'a b', '../x', `${ID}?x=1`]) {
    await assert.rejects(importPlaylist({ playlistId }), isError('ParseError'), String(playlistId));
  }
  assert.equal(requests.length, 0);
});

// ---- 錯誤對應

test('importPlaylist: a missing playlist (HTTP 200 with pageProps.status 404, or HTTP 404) is NotFound', async () => {
  const gone = JSON.stringify({ props: { pageProps: { status: 404, title: 'Page not found' } } });
  reply = () => ({ body: `<script id="__NEXT_DATA__" type="application/json">${gone}</script>` });
  await assert.rejects(importPlaylist({ playlistId: ID }), isError('NotFound'));
  reply = () => ({ status: 404, body: '' });
  await assert.rejects(importPlaylist({ playlistId: ID }), isError('NotFound'));
});

test('importPlaylist: HTTP 5xx is NetworkError, other statuses are UnexpectedError', async () => {
  reply = () => ({ status: 502, body: '' });
  await assert.rejects(importPlaylist({ playlistId: ID }), isError('NetworkError'));
  reply = () => ({ status: 403, body: '' });
  await assert.rejects(importPlaylist({ playlistId: ID }), isError('UnexpectedError'));
});

test('importPlaylist: a page that does not look like the embed page is a ParseError', async () => {
  const wrap = (data) => `<script id="__NEXT_DATA__" type="application/json">${JSON.stringify(data)}</script>`;
  const entityOf = (entity) => ({ props: { pageProps: { state: { data: { entity } } } } });
  for (const body of [
    '',
    '<html>no data here</html>',
    '<script id="__NEXT_DATA__" type="application/json">{not json</script>',
    '<script id="__NEXT_DATA__" type="application/json">[1]</script>',
    wrap({ props: {} }),
    wrap(entityOf('x')),
    wrap(entityOf({ name: 'x' })), // no trackList
    wrap(entityOf({ name: 'x', trackList: {} })),
    wrap(entityOf({ trackList: [] })), // no name
    wrap(entityOf({ name: '  ', title: '', trackList: [] })),
  ]) {
    reply = () => ({ body });
    await assert.rejects(importPlaylist({ playlistId: ID }), isError('ParseError'), body.slice(0, 60));
  }
});
