import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { CLIENTS, acceptsCredentials, clientNameOf } from '../src/clients.js';
import { hostRequest } from '../src/host_request.js';

const PLAYER = 'https://www.youtube.com/youtubei/v1/player?prettyPrint=false&alt=json';
const body = (clientName) => JSON.stringify({ videoId: 'x', context: { client: { clientName, clientVersion: '1' } } });

let requests;
let respond;
let warnings;
beforeEach(() => {
  requests = [];
  warnings = [];
  respond = () => ({ status: 200, url: '', headers: {}, body: '{}' });
  globalThis.fmp = {
    http: { request: async (r) => { requests.push(r); return respond(r); } },
    credentials: { get: async () => ({ cookies: { SAPISID: 'fake-sapisid' } }) },
    log: { warn: (message, fields) => { warnings.push({ message, fields }); } },
  };
});

test('every resolveStream client is cookieless, so player requests never carry credentials', () => {
  assert.deepEqual(CLIENTS, ['VISIONOS', 'IOS']);
  // YouTube.js 的 client 鍵 → 請求 body 的 clientName。
  for (const name of ['VISIONOS', 'iOS']) assert.equal(acceptsCredentials(body(name)), false, name);
});

test('acceptsCredentials: cookie clients and bodies without a clientName may carry credentials', () => {
  for (const name of ['ANDROID', 'ANDROID_VR']) assert.equal(acceptsCredentials(body(name)), false, name);
  for (const name of ['WEB', 'WEB_EMBEDDED_PLAYER', 'TVHTML5', 'MWEB']) assert.equal(acceptsCredentials(body(name)), true, name);
  assert.equal(acceptsCredentials('{}'), true);
  assert.equal(acceptsCredentials('not json'), true);
  assert.equal(acceptsCredentials(null), true);
  assert.equal(clientNameOf(body('TVHTML5')), 'TVHTML5');
  assert.equal(clientNameOf(JSON.stringify({ videoId: 'x' })), null);
});

test('hostRequest: a VISIONOS player request goes without credentials; a WEB search with them', async () => {
  await hostRequest({ url: PLAYER, method: 'POST', headers: {}, body: body('VISIONOS'), idempotent: true });
  await hostRequest({ url: 'https://www.youtube.com/youtubei/v1/search', method: 'POST', headers: {}, body: body('WEB'), idempotent: true });
  assert.equal(requests[0].auth, null);
  assert.equal(requests[0].authHeaders, null);
  assert.equal(requests[1].auth, 'userPreference');
  assert.match(requests[1].authHeaders.Authorization, /^SAPISIDHASH /);
});

test('hostRequest logs the Google API error status and message of a failed innertube request, nothing else', async () => {
  respond = () => ({
    status: 400,
    url: '',
    headers: {},
    body: JSON.stringify({ error: { code: 400, message: 'Request contains an invalid argument.', status: 'INVALID_ARGUMENT', errors: [{ reason: 'badRequest' }] } }),
    credentialsAttached: true,
  });
  const res = await hostRequest({ url: PLAYER, method: 'POST', headers: {}, body: body('WEB_EMBEDDED_PLAYER'), idempotent: true });
  assert.equal(res.status, 400);
  assert.deepEqual(warnings, [{
    message: 'innertube error',
    fields: {
      path: '/youtubei/v1/player',
      status: 400,
      clientName: 'WEB_EMBEDDED_PLAYER',
      credentialsAttached: true,
      error: 'INVALID_ARGUMENT',
      message: 'Request contains an invalid argument.',
    },
  }]);
  respond = () => ({ status: 500, url: '', headers: {}, body: '<html>' });
  await hostRequest({ url: PLAYER, method: 'POST', headers: {}, body: body('VISIONOS'), idempotent: true });
  assert.equal(warnings[1].fields.error, null);
  assert.equal(warnings[1].fields.message, null);
});
