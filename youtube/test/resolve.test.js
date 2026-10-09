// resolveStream 整條路徑（YouTube.js 解析在內），宿主以錄好的 fixture 模擬，不連網。
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

// src/ 只能打包後執行（core-js 的目錄匯入 Node 不收），設定同 build.mjs，不寫檔。
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
const { resolveStream } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`);

const fixture = (n) => JSON.parse(readFileSync(new URL(`../fixtures/resolveStream/00${n}.json`, import.meta.url), 'utf8')).response;
const bodyOf = (r) => (r.body !== undefined ? r.body : JSON.stringify(r.jsonBody));
const INPUT = {
  sourceId: 'dQw4w9WgXcQ',
  purpose: 'playback',
  formats: [{ container: 'webm', codec: 'opus' }, { container: 'mp4', codec: 'aac' }],
  quality: 'high',
};

let players;
let playerBody;
beforeEach(() => {
  players = [];
  playerBody = () => bodyOf(fixture(3));
  const store = new Map();
  globalThis.fmp = {
    http: {
      request: async (r) => {
        const reply = (body) => ({ status: 200, url: r.url, headers: {}, body, credentialsAttached: r.auth === 'userPreference' });
        if (r.url.includes('/sw.js_data')) return reply(bodyOf(fixture(1)));
        if (r.url.includes('/youtubei/v1/config')) return reply(bodyOf(fixture(2)));
        if (r.url.includes('/youtubei/v1/player')) {
          players.push({ clientName: JSON.parse(r.body).context.client.clientName, auth: r.auth });
          return reply(playerBody());
        }
        return { status: 404, url: r.url, headers: {}, body: '' };
      },
    },
    storage: { get: async (k) => store.get(k) ?? null, set: async (k, v) => { store.set(k, v); }, delete: async (k) => { store.delete(k); } },
    credentials: { get: async () => ({ cookies: { SAPISID: 'fake-sapisid' } }) },
    log: { debug() {}, info() {}, warn() {}, error() {} },
  };
});

test('resolveStream: signed in, the VISIONOS player request still goes without credentials', async () => {
  const { candidates } = await resolveStream(INPUT);
  assert.ok(candidates.length >= 2);
  assert.deepEqual(players, [{ clientName: 'VISIONOS', auth: null }]);
});

test('resolveStream: playability ERROR on every client is NotFound, not a thrown YouTube.js error', async () => {
  playerBody = () => JSON.stringify({ playabilityStatus: { status: 'ERROR', reason: 'This video is unavailable' } });
  await assert.rejects(resolveStream(INPUT), (e) => {
    assert.equal(e.fmpError, 'NotFound');
    assert.match(e.message, /playability ERROR: This video is unavailable/);
    return true;
  });
  assert.deepEqual(players.map((p) => p.clientName), ['VISIONOS', 'iOS']);
});
