// resolveStream 以假的宿主 API 跑：試聽片段（`freeTrialInfo`）只在登入後的回應出現，
// 契約的匿名 fixture 錄不到，這裡以手寫的回應守 `previewOnly` 與取流的 header。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import { resolveStream } from '../src/plugin.js';

function fakeHost(item) {
  const requests = [];
  globalThis.fmp = {
    crypto: { md5: (text) => createHash('md5').update(text).digest('hex') },
    log: { debug() {}, info() {}, warn() {} },
    http: {
      async request(req) {
        requests.push(req);
        return { status: 200, headers: {}, body: JSON.stringify({ code: 200, data: [item] }) };
      },
    },
  };
  return requests;
}

const request = { sourceId: '19292984', formats: [{ container: 'mp3', codec: 'mp3' }], quality: 'high' };
const playable = { id: 19292984, code: 200, fee: 1, br: 128000, type: 'mp3', expi: 1200, url: 'http://m701.music.126.net/a/b.mp3' };

test('a response with freeTrialInfo is previewOnly', async () => {
  fakeHost({ ...playable, freeTrialInfo: { start: 0, end: 30 } });
  const result = await resolveStream(request);
  assert.equal(result.previewOnly, true);
  assert.equal(result.candidates[0].url, 'https://m701.music.126.net/a/b.mp3');
});

test('a full song is not previewOnly', async () => {
  fakeHost({ ...playable, freeTrialInfo: null });
  const result = await resolveStream(request);
  assert.equal(result.previewOnly, undefined);
});

test('the stream request carries X-Real-IP and is idempotent', async () => {
  const requests = fakeHost({ ...playable, freeTrialInfo: null });
  await resolveStream(request);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].headers['X-Real-IP'], '118.88.88.88');
  assert.equal(requests[0].idempotent, true);
});
