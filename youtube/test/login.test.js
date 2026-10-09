import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { loginVerify, parseAccountMenu } from '../src/login.js';
import { hostRequest } from '../src/host_request.js';

const COOKIES = {
  SAPISID: 'fake-sapisid',
  '__Secure-1PSID': 'fake-1psid',
  '__Secure-3PSID': 'fake-3psid',
  LOGIN_INFO: 'fake-login-info',
};
const SEARCH = 'https://www.youtube.com/youtubei/v1/search';
const menu = (items) => ({
  actions: [{
    openPopupAction: {
      popup: {
        multiPageMenuRenderer: {
          sections: [{
            accountSectionListRenderer: {
              contents: [{ accountItemSectionRenderer: { contents: items.map((accountItem) => ({ accountItem })) } }],
            },
          }],
        },
      },
    },
  }],
});
const reply = (status, body = '', credentialsAttached = false) => ({ status, url: '', headers: {}, body, credentialsAttached });

let requests;
let respond;
beforeEach(() => {
  requests = [];
  respond = () => reply(200, '{}');
  globalThis.fmp = {
    http: { request: async (r) => { requests.push(r); return respond(r); } },
    credentials: { get: async () => ({ cookies: COOKIES }) },
    log: { warn: () => {} },
  };
});

test('parseAccountMenu picks the selected account and filters avatars to allowed hosts', () => {
  const account = parseAccountMenu(menu([
    { accountName: { simpleText: 'Other' }, isSelected: false },
    {
      accountName: { simpleText: 'Fake User' },
      isSelected: true,
      channelHandle: { simpleText: '@fake-user' },
      accountPhoto: {
        thumbnails: [
          { url: 'https://yt4.ggpht.com/fake-photo=s48', width: 48 },
          { url: 'https://evil.example/a.png' },
          { url: 'http://yt4.ggpht.com/insecure' },
        ],
      },
    },
  ]));
  assert.deepEqual(account, {
    userId: '@fake-user',
    displayName: 'Fake User',
    avatar: [{ url: 'https://yt4.ggpht.com/fake-photo=s48', width: 48 }],
  });
});

test('parseAccountMenu prefers a numeric datasync id, falls back to the name, and is null when signed out', () => {
  const withToken = parseAccountMenu(menu([{
    accountName: { runs: [{ text: 'Fake' }, { text: ' User' }] },
    isSelected: true,
    serviceEndpoint: { selectActiveIdentityEndpoint: { supportedTokens: [{ datasyncIdToken: { datasyncIdToken: '123456789012||' } }] } },
  }]));
  assert.equal(withToken.userId, '123456789012');
  assert.equal(withToken.displayName, 'Fake User');
  assert.equal(parseAccountMenu(menu([{ accountName: { simpleText: 'Only Name' } }])).userId, 'Only Name');
  assert.equal(parseAccountMenu({ responseContext: {} }), null);
});

test('loginVerify builds its own Cookie and SAPISIDHASH with auth never', async () => {
  respond = () => reply(200, JSON.stringify(menu([{ accountName: { simpleText: 'Fake User' }, isSelected: true, channelHandle: { simpleText: '@fake-user' } }])));
  const account = await loginVerify({ cookies: COOKIES });
  assert.equal(account.displayName, 'Fake User');
  assert.equal(requests.length, 1);
  const r = requests[0];
  assert.equal(r.auth, 'never');
  assert.equal(r.method, 'POST');
  assert.match(r.url, /^https:\/\/www\.youtube\.com\/youtubei\/v1\/account\/account_menu/);
  assert.match(r.headers.Authorization, /^SAPISIDHASH \d+_[0-9a-f]{40}$/);
  assert.ok(r.headers.Cookie.includes('SAPISID=fake-sapisid') && r.headers.Cookie.includes('LOGIN_INFO=fake-login-info'));
});

test('loginVerify maps 401, a signed-out body and missing cookies to CredentialInvalid', async () => {
  respond = () => reply(401);
  await assert.rejects(loginVerify({ cookies: COOKIES }), { fmpError: 'CredentialInvalid' });
  respond = () => reply(200, '{"responseContext":{}}');
  await assert.rejects(loginVerify({ cookies: COOKIES }), { fmpError: 'CredentialInvalid' });
  requests.length = 0;
  await assert.rejects(
    loginVerify({ cookies: { SAPISID: 'fake-sapisid' } }),
    (e) => e.fmpError === 'CredentialInvalid' && !e.message.includes('fake-'),
  );
  assert.equal(requests.length, 0);
  respond = () => reply(500);
  await assert.rejects(loginVerify({ cookies: COOKIES }), { fmpError: 'UnexpectedError' });
});

test('hostRequest: innertube requests are userPreference with authHeaders; other URLs are not', async () => {
  await hostRequest({ url: SEARCH, method: 'POST', headers: {}, body: '{}', idempotent: true });
  await hostRequest({ url: 'https://www.youtube.com/sw.js_data', method: 'GET', headers: {} });
  assert.equal(requests[0].auth, 'userPreference');
  assert.match(requests[0].authHeaders.Authorization, /^SAPISIDHASH /);
  assert.equal(requests[1].auth, null);
  assert.equal(requests[1].authHeaders, null);
});

test('hostRequest: no credentials means no authHeaders; 401 invalidates only when credentials were attached', async () => {
  globalThis.fmp.credentials.get = async () => null;
  await hostRequest({ url: SEARCH, method: 'POST', headers: {}, body: '{}', idempotent: true });
  assert.equal(requests[0].authHeaders, null);
  respond = () => reply(401, '', true);
  await assert.rejects(hostRequest({ url: SEARCH, method: 'POST', headers: {}, body: '{}', idempotent: true }), { fmpError: 'CredentialInvalid' });
  respond = () => reply(401, '', false);
  const res = await hostRequest({ url: SEARCH, method: 'POST', headers: {}, body: '{}', idempotent: true });
  assert.equal(res.status, 401);
});

test('parseAccountMenu reads the signed-in header (activeAccountHeaderRenderer)', () => {
  const json = {
    actions: [{ openPopupAction: { popup: { multiPageMenuRenderer: { header: { activeAccountHeaderRenderer: {
      accountName: { simpleText: 'Fake User' },
      accountPhoto: { thumbnails: [{ url: 'https://yt3.ggpht.com/fake=s88', width: 88 }] },
      channelHandle: { simpleText: '@fakeuser' },
    } } } } } }],
  };
  const account = parseAccountMenu(json);
  assert.equal(account.displayName, 'Fake User');
  assert.equal(account.userId, '@fakeuser');
  assert.equal(account.avatar.length, 1);
});
