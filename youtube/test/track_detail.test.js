// trackDetail：整條路徑（YouTube.js session 在內）宿主以假回應模擬，不連網。
// /next 的回應用 fixtures/mix/003.json 錄下的真實 WEB 回應（形狀相同），加手寫的變體。
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { parseTrackDetail } from '../src/track_detail.js';

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
const { trackDetail } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`);

const fixture = (n) => JSON.parse(readFileSync(new URL(`../fixtures/resolveStream/00${n}.json`, import.meta.url), 'utf8')).response;
const bodyOf = (r) => (r.body !== undefined ? r.body : JSON.stringify(r.jsonBody));
const recorded = JSON.parse(readFileSync(new URL('../fixtures/mix/003.json', import.meta.url), 'utf8')).response;
const recordedJson = () => JSON.parse(bodyOf(recorded));

// 手寫的最小 /next：primary 與 secondary 兩個 renderer。
const nextResponse = ({ primary = {}, secondary = {} } = {}) => ({
  contents: {
    twoColumnWatchNextResults: {
      results: { results: { contents: [{ ticketShelfRenderer: {} }, { videoPrimaryInfoRenderer: primary }, { videoSecondaryInfoRenderer: secondary }] } },
    },
  },
});
const likeButtons = (entity) => ({ menuRenderer: { topLevelButtons: [{ segmentedLikeDislikeButtonViewModel: { likeCountEntity: entity } }] } });

let nexts;
let nextReply;
beforeEach(() => {
  nexts = [];
  nextReply = () => ({ status: 200, body: bodyOf(recorded) });
  const store = new Map();
  globalThis.fmp = {
    http: {
      request: async (r) => {
        const reply = (body, status = 200) => ({ status, url: r.url, headers: {}, body, credentialsAttached: r.auth === 'userPreference' });
        if (r.url.includes('/sw.js_data')) return reply(bodyOf(fixture(1)));
        if (r.url.includes('/youtubei/v1/config')) return reply(bodyOf(fixture(2)));
        if (r.url.includes('/youtubei/v1/next')) {
          nexts.push({ body: JSON.parse(r.body), idempotent: r.idempotent, auth: r.auth });
          const { status, body } = nextReply();
          return reply(body, status);
        }
        return { status: 404, url: r.url, headers: {}, body: '' };
      },
    },
    storage: { get: async (k) => store.get(k) ?? null, set: async (k, v) => { store.set(k, v); }, delete: async (k) => { store.delete(k); } },
    credentials: { get: async () => ({ cookies: { SAPISID: 'fake-sapisid' } }) },
    log: { debug() {}, info() {}, warn() {}, error() {} },
  };
});

test('trackDetail: maps the recorded WEB /next response with one request', async () => {
  const detail = await trackDetail({ sourceId: 'dQw4w9WgXcQ' });
  assert.match(detail.description, /^The official video for/);
  assert.equal(detail.publishedAt, Date.UTC(2009, 9, 25, 12));
  assert.deepEqual(detail.stats, [{ kind: 'view', count: 1826485567 }, { kind: 'like', count: 19488851 }]);
  assert.ok(detail.uploaderAvatar.length >= 1);
  assert.ok(detail.uploaderAvatar.every((a) => a.url.startsWith('https://yt3.ggpht.com/') && a.width > 0));
  assert.deepEqual(Object.keys(detail).sort(), ['description', 'publishedAt', 'stats', 'uploaderAvatar']);
  assert.equal(nexts.length, 1);
  assert.equal(nexts[0].body.videoId, 'dQw4w9WgXcQ');
  assert.equal(nexts[0].body.playlistId, undefined);
  assert.equal(nexts[0].body.context.client.clientName, 'WEB');
});

test('trackDetail: the request is idempotent and tagged userPreference like search', async () => {
  await trackDetail({ sourceId: 'dQw4w9WgXcQ' });
  assert.equal(nexts[0].idempotent, true);
  assert.equal(nexts[0].auth, 'userPreference');
});

test('trackDetail: invalid input is ParseError and sends no request', async () => {
  for (const sourceId of ['bad id', '', undefined, 12345678901, 'RDdQw4w9WgXcQ']) {
    await assert.rejects(trackDetail({ sourceId }), (e) => e.fmpError === 'ParseError');
  }
  assert.equal(nexts.length, 0);
});

test('trackDetail: a cid is ignored (YouTube has no parts)', async () => {
  await trackDetail({ sourceId: 'dQw4w9WgXcQ', cid: 5 });
  assert.equal(nexts[0].body.cid, undefined);
});

test('trackDetail: an HTTP 4xx rejects like search does (YouTube.js throws, the host maps it)', async () => {
  nextReply = () => ({ status: 400, body: JSON.stringify({ error: { status: 'INVALID_ARGUMENT', message: 'bad' } }) });
  await assert.rejects(trackDetail({ sourceId: 'dQw4w9WgXcQ' }), /status code 400/);
});

test('trackDetail: a response without contents is ParseError, one without video info is NotFound', async () => {
  nextReply = () => ({ status: 200, body: JSON.stringify({ responseContext: {} }) });
  await assert.rejects(trackDetail({ sourceId: 'dQw4w9WgXcQ' }), (e) => e.fmpError === 'ParseError');
  nextReply = () => ({ status: 200, body: JSON.stringify({ contents: {} }) });
  await assert.rejects(trackDetail({ sourceId: 'dQw4w9WgXcQ' }), (e) => e.fmpError === 'NotFound');
});

test('parseTrackDetail: omits what the response does not provide', () => {
  assert.deepEqual(parseTrackDetail(nextResponse()), {});
});

test('parseTrackDetail: hidden likes and unreadable counts are omitted, never 0', () => {
  const hidden = nextResponse({
    primary: {
      viewCount: { videoViewCountRenderer: { viewCount: { simpleText: 'No views' } } },
      videoActions: likeButtons({ likeCountIfIndifferentNumber: 'NaN', expandedLikeCountIfIndifferent: { content: '19M' } }),
    },
  });
  assert.equal(parseTrackDetail(hidden).stats, undefined);
});

test('parseTrackDetail: falls back to the displayed full counts', () => {
  const data = nextResponse({
    primary: {
      viewCount: { videoViewCountRenderer: { viewCount: { simpleText: '1,234 views' } } },
      videoActions: likeButtons({ expandedLikeCountIfIndifferent: { content: '5,678' } }),
    },
  });
  assert.deepEqual(parseTrackDetail(data).stats, [{ kind: 'view', count: 1234 }, { kind: 'like', count: 5678 }]);
  const one = nextResponse({ primary: { viewCount: { videoViewCountRenderer: { viewCount: { simpleText: '1 view' } } } } });
  assert.deepEqual(parseTrackDetail(one).stats, [{ kind: 'view', count: 1 }]);
});

test('parseTrackDetail: date forms, and impossible or foreign dates give no publishedAt', () => {
  const at = (text) => parseTrackDetail(nextResponse({ primary: { dateText: { simpleText: text } } })).publishedAt;
  assert.equal(at('Premiered Jan 1, 2020'), Date.UTC(2020, 0, 1, 12));
  assert.equal(at('Streamed live on Dec 31, 2019'), Date.UTC(2019, 11, 31, 12));
  assert.equal(at('Started streaming 3 hours ago'), undefined);
  assert.equal(at('25 Oct 2009'), undefined);
  assert.equal(at('Feb 31, 2020'), undefined);
  assert.equal(at('2009年10月25日'), undefined);
  assert.equal(at('16y ago'), undefined);
});

test('parseTrackDetail: the date is noon UTC so every offset from UTC-12 to UTC+11 shows the same day', () => {
  const ms = parseTrackDetail(nextResponse({ primary: { dateText: { simpleText: 'Oct 25, 2009' } } })).publishedAt;
  for (const offsetHours of [-12, -8, 0, 8, 11]) {
    assert.equal(new Date(ms + offsetHours * 3600 * 1000).getUTCDate(), 25, `UTC${offsetHours}`);
  }
  const runs = nextResponse({ primary: { dateText: { runs: [{ text: 'Premiered ' }, { text: 'Oct 25, 2009' }] } } });
  assert.equal(parseTrackDetail(runs).publishedAt, ms);
});

test('parseTrackDetail: a live stream has no view stat (watching now is not views)', () => {
  const live = nextResponse({
    primary: {
      viewCount: { videoViewCountRenderer: { isLive: true, originalViewCount: '0', viewCount: { runs: [{ text: '1,234' }, { text: ' watching now' }] } } },
    },
  });
  assert.equal(parseTrackDetail(live).stats, undefined);
});

test('parseTrackDetail: a liked video counts the liked total the user sees', () => {
  const entity = {
    likeCountIfLikedNumber: '11', likeCountIfIndifferentNumber: '10',
    expandedLikeCountIfLiked: { content: '11' }, expandedLikeCountIfIndifferent: { content: '10' },
  };
  const withStatus = (likeStatus, e = entity) => {
    const actions = likeButtons(e);
    actions.menuRenderer.topLevelButtons[0].segmentedLikeDislikeButtonViewModel.likeButtonViewModel = {
      likeButtonViewModel: { likeStatusEntity: { likeStatus } },
    };
    return parseTrackDetail(nextResponse({ primary: { videoActions: actions } })).stats;
  };
  assert.deepEqual(withStatus('LIKE'), [{ kind: 'like', count: 11 }]);
  assert.deepEqual(withStatus('INDIFFERENT'), [{ kind: 'like', count: 10 }]);
  assert.deepEqual(withStatus('DISLIKE'), [{ kind: 'like', count: 10 }]);
  assert.deepEqual(withStatus('LIKE', { expandedLikeCountIfLiked: { content: '1,001' } }), [{ kind: 'like', count: 1001 }]);
});

test('parseTrackDetail: description falls back to runs; blank is omitted; avatars outside allowed hosts are dropped', () => {
  const runs = nextResponse({ secondary: { description: { runs: [{ text: 'a ' }, { text: 'b' }] } } });
  assert.equal(parseTrackDetail(runs).description, 'a b');
  const blank = nextResponse({ secondary: { attributedDescription: { content: '  \n' } } });
  assert.equal(parseTrackDetail(blank).description, undefined);
  const avatars = nextResponse({
    secondary: {
      owner: { videoOwnerRenderer: { thumbnail: { thumbnails: [
        { url: 'https://yt3.ggpht.com/a=s48', width: 48 },
        { url: 'https://evil.example.com/a', width: 88 },
        { url: 'http://yt3.ggpht.com/insecure', width: 88 },
      ] } } },
    },
  });
  assert.deepEqual(parseTrackDetail(avatars).uploaderAvatar, [{ url: 'https://yt3.ggpht.com/a=s48', width: 48 }]);
});

test('parseTrackDetail: counts are non-negative integers', () => {
  const detail = parseTrackDetail(recordedJson());
  for (const s of detail.stats) assert.ok(Number.isInteger(s.count) && s.count >= 0);
});
