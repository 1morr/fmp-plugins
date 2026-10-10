// 憑證無效的判定表，以及 loginRefresh 的 5 步流程（假的宿主 API，不連網）。
// cookie 與 token 的值都是 fake-… 開頭的假值。
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { credentialsRejected, loginRefresh, refreshCsrfOf, search } from '../src/plugin.js';

// ---------------------------------------------------------------- 憑證無效的判定

test('credentialsRejected: -101 and -111 count only when credentials were attached', () => {
  for (const code of [-101, -111]) {
    assert.equal(credentialsRejected({ code }, true), true, `attached ${code}`);
    assert.equal(credentialsRejected({ code }, false), false, `anonymous ${code}`);
    assert.equal(credentialsRejected({ code }, undefined), false, `unknown ${code}`);
  }
});

test('credentialsRejected: risk, rate-limit, business and success codes are never invalidity', () => {
  for (const code of [0, -352, -412, -509, -799, -503, -403, -404, 62002, 86095, 12345]) {
    assert.equal(credentialsRejected({ code }, true), false, `code ${code}`);
    assert.equal(credentialsRejected({ code }, false), false, `code ${code}`);
  }
  for (const body of [null, undefined, 'x', 5, [], {}, { code: '-101' }]) {
    assert.equal(credentialsRejected(body, true), false, JSON.stringify(body));
  }
});

function hostReturning(response) {
  globalThis.fmp = {
    crypto: { md5: () => '' },
    log: { debug() {}, info() {}, warn() {} },
    storage: { get: async () => null, set: async () => {} },
    http: { request: async () => ({ headers: {}, ...response }) },
  };
}

test('a search response -101 is CredentialInvalid with credentials attached, AuthRequired without', async () => {
  const body = JSON.stringify({ code: -101, message: 'not logged in' });
  hostReturning({ status: 200, body, credentialsAttached: true });
  await assert.rejects(search({ keyword: 'x', page: 1 }), (e) => e.fmpError === 'CredentialInvalid');
  hostReturning({ status: 200, body, credentialsAttached: false });
  await assert.rejects(search({ keyword: 'x', page: 1 }), (e) => e.fmpError === 'AuthRequired');
});

test('network, rate-limit and risk responses stay what they were even with credentials attached', async () => {
  hostReturning({ status: 200, body: JSON.stringify({ code: -352 }), credentialsAttached: true });
  await assert.rejects(search({ keyword: 'x', page: 1 }), (e) => e.fmpError === 'RateLimited');
  hostReturning({ status: 503, body: '', credentialsAttached: true });
  await assert.rejects(search({ keyword: 'x', page: 1 }), (e) => e.fmpError === 'NetworkError');
});

// ---------------------------------------------------------------- refreshCsrfOf

test('refreshCsrfOf reads the 1-name div and trims it', () => {
  assert.equal(refreshCsrfOf('<html><div id="1-name">fake-csrf-0000</div></html>'), 'fake-csrf-0000');
  assert.equal(refreshCsrfOf('<div  id="1-name" > fake-csrf-0000 </div>'), 'fake-csrf-0000');
  assert.equal(refreshCsrfOf('<div id="1-name"></div>'), null);
  assert.equal(refreshCsrfOf('<html></html>'), null);
  assert.equal(refreshCsrfOf(undefined), null);
});

// ---------------------------------------------------------------- loginRefresh

const OLD = {
  cookies: {
    SESSDATA: 'fake-sessdata-old',
    bili_jct: 'fake-jct-old',
    DedeUserID: '1000001',
    DedeUserID__ckMd5: 'fake-ckmd5-old',
  },
  extra: { refresh_token: 'fake-refresh-old' },
};

const json = (body, headers) => ({ status: 200, headers: headers || {}, body: JSON.stringify(body) });

/** 依網址路由的假宿主：routes 的鍵是網址片段，值是回應或函式。回傳 requests。 */
function routedHost(routes) {
  const requests = [];
  globalThis.fmp = {
    crypto: { md5: () => '' },
    log: { debug() {}, info() {}, warn() {} },
    storage: { get: async () => null, set: async () => {} },
    http: {
      async request(req) {
        requests.push(req);
        for (const [fragment, handler] of Object.entries(routes)) {
          if (req.url.includes(fragment)) return typeof handler === 'function' ? handler(req) : handler;
        }
        throw new Error(`unexpected request ${req.url}`);
      },
    },
  };
  return requests;
}

const INFO = '/cookie/info';
const CORRESPOND = '/correspond/1/';
const REFRESH = '/cookie/refresh';
const CONFIRM = '/confirm/refresh';

const needsRefresh = json({ code: 0, data: { refresh: true, timestamp: 1700000000000 } });
const page = { status: 200, headers: {}, body: '<div id="1-name">fake-refresh-csrf</div>' };
const refreshed = json(
  { code: 0, data: { status: 0, refresh_token: 'fake-refresh-new' } },
  {
    'set-cookie': [
      'SESSDATA=fake-sessdata-new; Path=/; HttpOnly',
      'bili_jct=fake-jct-new; Path=/',
      'DedeUserID=1000001; Path=/',
      'sid=fake-sid; Path=/',
    ],
  },
);
const confirmed = json({ code: 0 });

async function rejects(promise, fmpError) {
  await assert.rejects(promise, (e) => {
    assert.equal(e.fmpError, fmpError, JSON.stringify(e));
    return true;
  });
}

test('loginRefresh returns null when no refresh is needed, after one request', async () => {
  const requests = routedHost({ [INFO]: json({ code: 0, data: { refresh: false, timestamp: 1700000000000 } }) });
  assert.equal(await loginRefresh(OLD), null);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, 'https://passport.bilibili.com/x/passport-login/web/cookie/info');
  assert.equal(requests[0].auth, 'never');
  assert.equal(
    requests[0].headers.Cookie,
    'SESSDATA=fake-sessdata-old; bili_jct=fake-jct-old; DedeUserID=1000001; DedeUserID__ckMd5=fake-ckmd5-old',
  );
});

test('loginRefresh runs the 5 steps and returns the new credentials', async () => {
  const requests = routedHost({
    [INFO]: needsRefresh,
    [CORRESPOND]: page,
    [REFRESH]: refreshed,
    [CONFIRM]: confirmed,
  });
  const result = await loginRefresh(OLD);
  assert.deepEqual(result, {
    cookies: {
      SESSDATA: 'fake-sessdata-new',
      bili_jct: 'fake-jct-new',
      DedeUserID: '1000001',
      DedeUserID__ckMd5: 'fake-ckmd5-old', // 回應沒給的沿用舊值
    },
    extra: { refresh_token: 'fake-refresh-new' },
  });

  assert.equal(requests.length, 4);
  assert.ok(requests.every((r) => r.auth === 'never'));
  const [info, correspond, refresh, confirm] = requests;
  assert.match(correspond.url, /^https:\/\/www\.bilibili\.com\/correspond\/1\/[0-9a-f]{256}$/);
  assert.equal(correspond.headers.Cookie, info.headers.Cookie);

  assert.equal(refresh.method, 'POST');
  assert.equal(refresh.headers['Content-Type'], 'application/x-www-form-urlencoded');
  assert.equal(refresh.headers.Cookie, info.headers.Cookie); // 舊憑證
  assert.equal(
    refresh.body,
    'csrf=fake-jct-old&refresh_csrf=fake-refresh-csrf&source=main_web&refresh_token=fake-refresh-old',
  );

  assert.equal(confirm.method, 'POST');
  assert.equal(confirm.url, 'https://passport.bilibili.com/x/passport-login/web/confirm/refresh');
  // 新 cookie，加舊 refresh_token。
  assert.equal(confirm.body, 'csrf=fake-jct-new&refresh_token=fake-refresh-old');
  assert.match(confirm.headers.Cookie, /^SESSDATA=fake-sessdata-new; bili_jct=fake-jct-new; /);
});

test('credentials the server says are bad throw CredentialInvalid at any step', async () => {
  routedHost({ [INFO]: json({ code: -101, message: 'not logged in' }) });
  await rejects(loginRefresh(OLD), 'CredentialInvalid');
  for (const code of [-101, -111]) {
    routedHost({ [INFO]: needsRefresh, [CORRESPOND]: page, [REFRESH]: json({ code, message: 'bad' }) });
    await rejects(loginRefresh(OLD), 'CredentialInvalid');
  }
});

// 86095 的意義沒對真實端點驗證過，而且走到第 4 步代表第 1 步的 cookie 還被接受：標失效會讓
// 還能用的登入被要求重新登入。保守處理成一般失敗，宿主記 failed、帳號照用；cookie 真的壞了時
// 帶憑證的請求會拿到 -101，再走一次刷新就在第 1 步判定。
test('86095 from the refresh step is not CredentialInvalid', async () => {
  routedHost({ [INFO]: needsRefresh, [CORRESPOND]: page, [REFRESH]: json({ code: 86095, message: 'bad' }) });
  await rejects(loginRefresh(OLD), 'UnexpectedError');
});

test('credentials that cannot be refreshed throw CredentialInvalid without further requests', async () => {
  let requests = routedHost({ [INFO]: needsRefresh });
  await rejects(loginRefresh({ cookies: OLD.cookies }), 'CredentialInvalid'); // 沒有 refresh_token
  assert.equal(requests.length, 1);
  requests = routedHost({});
  await rejects(loginRefresh({ cookies: { bili_jct: 'x' }, extra: OLD.extra }), 'CredentialInvalid'); // 沒有 SESSDATA
  assert.equal(requests.length, 0);
});

test('a refresh that is not needed does not require a refresh_token', async () => {
  routedHost({ [INFO]: json({ code: 0, data: { refresh: false } }) });
  assert.equal(await loginRefresh({ cookies: OLD.cookies }), null);
});

test('network, HTTP, risk and format failures are not CredentialInvalid', async () => {
  const cases = [
    [{ [INFO]: { status: 503, headers: {}, body: '' } }, 'NetworkError'],
    [{ [INFO]: { status: 412, headers: {}, body: '' } }, 'RateLimited'],
    [{ [INFO]: json({ code: -352, message: 'risk' }) }, 'RateLimited'],
    [{ [INFO]: { status: 200, headers: {}, body: '<html>' } }, 'ParseError'],
    [{ [INFO]: json({ code: 0, data: { refresh: true } }) }, 'ParseError'], // 沒有 timestamp
    [{ [INFO]: needsRefresh, [CORRESPOND]: { status: 404, headers: {}, body: '' } }, 'UnexpectedError'],
    [{ [INFO]: needsRefresh, [CORRESPOND]: { status: 200, headers: {}, body: '<html></html>' } }, 'ParseError'],
    [{ [INFO]: needsRefresh, [CORRESPOND]: page, [REFRESH]: json({ code: -412 }) }, 'RateLimited'],
    [{ [INFO]: needsRefresh, [CORRESPOND]: page, [REFRESH]: json({ code: 12345 }) }, 'UnexpectedError'],
    [{ [INFO]: needsRefresh, [CORRESPOND]: page, [REFRESH]: { status: 500, headers: {}, body: '' } }, 'NetworkError'],
    // 200 但沒有新 refresh_token，或沒有 Set-Cookie
    [{ [INFO]: needsRefresh, [CORRESPOND]: page, [REFRESH]: json({ code: 0, data: {} }, refreshed.headers) }, 'ParseError'],
    [{ [INFO]: needsRefresh, [CORRESPOND]: page, [REFRESH]: json({ code: 0, data: { refresh_token: 'fake-refresh-new' } }) }, 'ParseError'],
  ];
  for (const [routes, expected] of cases) {
    routedHost(routes);
    await rejects(loginRefresh(OLD), expected);
  }
});

test('a transport error from the host propagates unchanged', async () => {
  routedHost({
    [INFO]: () => {
      throw { fmpError: 'NetworkError', message: 'offline' };
    },
  });
  await rejects(loginRefresh(OLD), 'NetworkError');
});

// 第 4 步成功後伺服器已發出新憑證、舊 refresh_token 已用掉：confirm 失敗時丟掉新憑證，下次
// 以舊 refresh_token 刷新只會被拒。照舊專案（先存新憑證再 confirm、confirm 失敗不影響），回傳新的。
test('a failed confirm still returns the new credentials', async () => {
  for (const confirm of [
    { status: 502, headers: {}, body: '' },
    () => {
      throw { fmpError: 'NetworkError', message: 'offline' };
    },
  ]) {
    routedHost({ [INFO]: needsRefresh, [CORRESPOND]: page, [REFRESH]: refreshed, [CONFIRM]: confirm });
    const result = await loginRefresh(OLD);
    assert.equal(result.cookies.SESSDATA, 'fake-sessdata-new');
    assert.equal(result.extra.refresh_token, 'fake-refresh-new');
  }
});

test('a non-zero confirm code does not fail the refresh (legacy ignores it)', async () => {
  routedHost({
    [INFO]: needsRefresh,
    [CORRESPOND]: page,
    [REFRESH]: refreshed,
    [CONFIRM]: json({ code: -1, message: 'x' }),
  });
  const result = await loginRefresh(OLD);
  assert.equal(result.extra.refresh_token, 'fake-refresh-new');
});
