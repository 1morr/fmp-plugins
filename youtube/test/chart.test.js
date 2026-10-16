// charts：parser 直接測；整條 chart 路徑（YouTube.js session 在內）宿主以假回應模擬，不連網。
// test/data/chart-new-this-week.json 是 fixtures/charts/003.json（2026-10-16 插件匿名 browse "New This Week" 歌單的錄製，
// 觀看次數那一格是 "235K"、"14M"，不帶 "views"）刪減到只剩插件讀的欄位的前 8 首（原本 25 首，順序不是觀看次數的順序）。
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { chartList as listOf, chartRequest, parseChartResponse, viewCountOf } from '../src/chart.js';

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
const { chartList, chart } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`);

const read = (path) => JSON.parse(readFileSync(new URL(path, import.meta.url), 'utf8'));
const fixture = (n) => read(`../fixtures/resolveStream/00${n}.json`).response;
const bodyOf = (r) => (r.body !== undefined ? r.body : JSON.stringify(r.jsonBody));
const recorded = read('./data/chart-new-this-week.json');

const lockup = (id, views, duration = '3:00') => ({
  lockupViewModel: {
    contentId: id,
    contentType: 'LOCKUP_CONTENT_TYPE_VIDEO',
    contentImage: {
      thumbnailViewModel: {
        image: { sources: [{ url: `https://i.ytimg.com/vi/${id}/hqdefault.jpg`, width: 168 }] },
        overlays: [{ thumbnailBottomOverlayViewModel: { badges: [{ thumbnailBadgeViewModel: { text: duration } }] } }],
      },
    },
    metadata: {
      lockupMetadataViewModel: {
        title: { content: `title ${id}` },
        metadata: {
          contentMetadataViewModel: {
            metadataRows: [
              { metadataParts: [{ text: { content: `artist ${id}` } }] },
              { metadataParts: [...(views === null ? [] : [{ text: { content: views } }]), { text: { content: '6 days ago' } }] },
            ],
          },
        },
      },
    },
  },
});
const pageOf = (items) => ({
  contents: { twoColumnBrowseResultsRenderer: { tabs: [{ tabRenderer: { content: { sectionListRenderer: { contents: [{ itemSectionRenderer: { contents: items } }] } } } }] } },
});
const ids = (tracks) => tracks.map((t) => t.sourceId);

test('chartList: one fixed chart', () => {
  assert.deepEqual(listOf(), { charts: [{ chartId: 'new-this-week', title: '本週新歌' }] });
  assert.deepEqual(chartList(), listOf());
});

test('viewCountOf: suffixes, commas, unknown text', () => {
  assert.equal(viewCountOf('14M views'), 14_000_000);
  assert.equal(viewCountOf('2.2M views'), 2_200_000);
  assert.equal(viewCountOf('235K views'), 235_000);
  assert.equal(viewCountOf('1.2B views'), 1_200_000_000);
  assert.equal(viewCountOf('1,234 views'), 1234);
  assert.equal(viewCountOf('1 view'), 1);
  assert.equal(viewCountOf('No views'), 0);
  // 舊版 _parseViewCountText 先去掉單位再 trim，數字與單位之間有空白也認；小寫單位也認。
  assert.equal(viewCountOf('1.5 M views'), 1_500_000);
  assert.equal(viewCountOf('1.5 M'), 1_500_000);
  assert.equal(viewCountOf('3k'), 3000);
  assert.equal(viewCountOf(''), 0);
  assert.equal(viewCountOf(null), 0);
});

test('parseChartResponse: recorded response is sorted by view count, descending', () => {
  const tracks = parseChartResponse(recorded);
  // 錄到的順序與次數：QKNc 235K、AVu5 1.2M、ibLg 257K、rtXW 700K、3juu 14M、p0-p 994K、0U-d 664K、fYaF 2.5M。
  assert.deepEqual(ids(tracks), ['3juuih0WdH8', 'fYaF00OZ69U', 'AVu5p2DMIf8', 'p0-pdE1GmUA', 'rtXWUOMXHRI', '0U-dWoBc4rE', 'ibLgtCXxTfw', 'QKNcOVr6okA']);
  const first = tracks[0];
  assert.ok(first.title.length > 0);
  assert.equal(first.uploader, 'Anuel AA');
  assert.equal(first.durationMs, 290_000);
  assert.ok(first.artwork.length > 0 && first.artwork.every((a) => a.url.startsWith('https://i.ytimg.com/')));
});

test('parseChartResponse: the views cell is found with or without the word "views"; dates and the channel row are not mistaken for it', () => {
  const row = (parts) => ({ metadataParts: parts.map((content) => ({ text: { content } })) });
  const withRows = (id, rows) => {
    const entry = lockup(id, null);
    entry.lockupViewModel.metadata.lockupMetadataViewModel.metadata.contentMetadataViewModel.metadataRows = rows;
    return entry;
  };
  const tracks = parseChartResponse(pageOf([
    withRows('aaaaaaaaaaa', [row(['21']), row(['3K', '7d ago'])]),
    withRows('bbbbbbbbbbb', [row(['2NE1']), row(['1.5M views', '7 days ago'])]),
    withRows('ccccccccccc', [row(['10']), row(['No views', '1d ago'])]),
    withRows('ddddddddddd', [row(['9999999']), row(['7d ago'])]),
  ]));
  assert.deepEqual(ids(tracks), ['bbbbbbbbbbb', 'aaaaaaaaaaa', 'ccccccccccc', 'ddddddddddd']);
});

test('parseChartResponse: a views cell with a space before the unit is read, not taken as 0', () => {
  const tracks = parseChartResponse(pageOf([lockup('aaaaaaaaaaa', '900K'), lockup('bbbbbbbbbbb', '1.5 M')]));
  assert.deepEqual(ids(tracks), ['bbbbbbbbbbb', 'aaaaaaaaaaa']);
});

test('parseChartResponse: metadata rows or parts that are not arrays count as unknown views, not an error', () => {
  const broken = (id, rows) => {
    const entry = lockup(id, null);
    entry.lockupViewModel.metadata.lockupMetadataViewModel.metadata.contentMetadataViewModel.metadataRows = rows;
    return entry;
  };
  const tracks = parseChartResponse(pageOf([
    broken('aaaaaaaaaaa', {}),
    broken('bbbbbbbbbbb', [{ metadataParts: [] }, { metadataParts: { text: { content: '5K' } } }]),
    lockup('ccccccccccc', '1K'),
  ]));
  assert.deepEqual(ids(tracks), ['ccccccccccc', 'aaaaaaaaaaa', 'bbbbbbbbbbb']);
});

test('parseChartResponse: ties keep playlist order; unreadable counts go last; unplayable entries are skipped', () => {
  const tracks = parseChartResponse(pageOf([
    lockup('aaaaaaaaaaa', null),
    lockup('bbbbbbbbbbb', '5K views'),
    lockup('ccccccccccc', '5K views'),
    lockup('ddddddddddd', '9M views'),
    lockup('eeeeeeeeeee', '1M views', 'LIVE'),
    { lockupViewModel: { contentId: 'fffffffffff', contentType: 'LOCKUP_CONTENT_TYPE_PLAYLIST' } },
    { continuationItemViewModel: {} },
  ]));
  assert.deepEqual(ids(tracks), ['ddddddddddd', 'bbbbbbbbbbb', 'ccccccccccc', 'aaaaaaaaaaa']);
});

test('parseChartResponse: old playlistVideoRenderer layout', () => {
  const renderer = (id, views) => ({
    playlistVideoRenderer: { videoId: id, title: { runs: [{ text: id }] }, lengthSeconds: '200', videoInfo: { runs: [{ text: views }, { text: ' • ' }, { text: '1 week ago' }] } },
  });
  const tracks = parseChartResponse(pageOf([{ playlistVideoListRenderer: { contents: [renderer('low', '1K views'), renderer('high', '3M views')] } }]));
  assert.deepEqual(ids(tracks), ['high', 'low']);
});

test('parseChartResponse: no items or nothing playable is a ParseError', () => {
  for (const data of [null, {}, { contents: {} }, pageOf([]), pageOf([lockup('aaaaaaaaaaa', '1K views', 'LIVE')])]) {
    assert.throws(() => parseChartResponse(data), (e) => e.fmpError === 'ParseError');
  }
});

test('chartRequest: only the known chartId', () => {
  assert.deepEqual(chartRequest({ chartId: 'new-this-week' }), { browseId: 'VLOLPPnm121Qlcoo7kKykmswKG0IepmDUVpag' });
  assert.throws(() => chartRequest({ chartId: 'nope' }), (e) => e.fmpError === 'NotFound');
  for (const input of [undefined, {}, { chartId: '' }, { chartId: 5 }]) {
    assert.throws(() => chartRequest(input), (e) => e.fmpError === 'ParseError');
  }
});

let browses;
let browseReply;
beforeEach(() => {
  browses = [];
  browseReply = () => ({ status: 200, body: JSON.stringify(recorded) });
  const store = new Map();
  globalThis.fmp = {
    http: {
      request: async (r) => {
        const reply = (body, status = 200) => ({ status, url: r.url, headers: {}, body, credentialsAttached: false });
        if (r.url.includes('/sw.js_data')) return reply(bodyOf(fixture(1)));
        if (r.url.includes('/youtubei/v1/config')) return reply(bodyOf(fixture(2)));
        if (r.url.includes('/youtubei/v1/browse')) {
          browses.push({ body: JSON.parse(r.body), idempotent: r.idempotent, auth: r.auth, headers: r.headers });
          const { status, body } = browseReply();
          return reply(body, status);
        }
        return { status: 404, url: r.url, headers: {}, body: '' };
      },
    },
    storage: { get: async (k) => store.get(k) ?? null, set: async (k, v) => { store.set(k, v); }, delete: async (k) => { store.delete(k); } },
    credentials: { get: async () => null },
    log: { debug() {}, info() {}, warn() {}, error() {} },
  };
});

test('chart: one anonymous browse of the playlist, userPreference, hint header not sent', async () => {
  const { tracks } = await chart({ chartId: 'new-this-week' });
  assert.equal(tracks.length, 8);
  assert.equal(tracks[0].sourceId, '3juuih0WdH8');
  assert.equal(browses.length, 1);
  assert.equal(browses[0].body.browseId, 'VLOLPPnm121Qlcoo7kKykmswKG0IepmDUVpag');
  assert.equal(browses[0].auth, 'userPreference');
  assert.equal(browses[0].headers['x-fmp-call'], undefined);
});

test('chart: HTTP errors surface, unknown chartId does not hit the network', async () => {
  browseReply = () => ({ status: 500, body: '{"error":{"message":"boom"}}' });
  // YouTube.js 的例外原樣往外（宿主轉成 UnexpectedError），不是解析空回應得到的 ParseError。
  await assert.rejects(chart({ chartId: 'new-this-week' }), /status code 500/);
  const before = browses.length;
  await assert.rejects(chart({ chartId: 'nope' }), (e) => e.fmpError === 'NotFound');
  assert.equal(browses.length, before);
});

test('chart: errors the host network layer raises (rate limit, transport) pass through unchanged', async () => {
  for (const kind of ['RateLimited', 'NetworkError']) {
    browseReply = () => { throw Object.assign(new Error(kind), { fmpError: kind }); };
    await assert.rejects(chart({ chartId: 'new-this-week' }), (e) => e.fmpError === kind, kind);
  }
});
