// QR 登入：狀態碼對應、Set-Cookie 解析、verify 對應與請求形狀（假的宿主 API，不連網）。
// cookie 與 token 的值都是 fake-… 開頭的假值。
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { loginQrPoll, loginQrStart, loginVerify, parseSetCookies, qrCredentials, verifyCookie } from '../src/plugin.js';

function fakeHost(responses) {
  const requests = [];
  const queue = [...responses];
  globalThis.fmp = {
    crypto: { md5: () => '' },
    log: { debug() {}, info() {}, warn() {} },
    storage: {
      async get() {
        return null;
      },
      async set() {},
    },
    http: {
      async request(req) {
        requests.push(req);
        const next = queue.shift();
        return {
          headers: {},
          ...next,
          body: typeof next.body === 'string' ? next.body : JSON.stringify(next.body),
        };
      },
    },
  };
  return requests;
}
const ok = (body, headers) => ({ status: 200, body, headers });

async function rejects(promise, fmpError) {
  await assert.rejects(promise, (e) => {
    assert.equal(e.fmpError, fmpError, JSON.stringify(e));
    return true;
  });
}

const setCookies = [
  'SESSDATA=fake-sessdata-0000; Path=/; Expires=Fri, 01 Jan 2027 00:00:00 GMT; HttpOnly; Secure',
  'bili_jct=fake-jct-0000; Path=/; Expires=Fri, 01 Jan 2027 00:00:00 GMT',
  'DedeUserID=1000001; Path=/; Expires=Fri, 01 Jan 2027 00:00:00 GMT',
  'DedeUserID__ckMd5=fake-ckmd5-0000; Path=/; Expires=Fri, 01 Jan 2027 00:00:00 GMT',
  'sid=fake-sid-0000; Path=/',
];

// ---------------------------------------------------------------- 純函式

test('parseSetCookies keeps = in values, drops attributes and empty values', () => {
  assert.deepEqual(parseSetCookies(['a=b=c; Path=/', 'gone=; Max-Age=0', 'junk', 5]), { a: 'b=c' });
  assert.deepEqual(parseSetCookies(undefined), {});
  assert.deepEqual(parseSetCookies(setCookies), {
    SESSDATA: 'fake-sessdata-0000',
    bili_jct: 'fake-jct-0000',
    DedeUserID: '1000001',
    DedeUserID__ckMd5: 'fake-ckmd5-0000',
    sid: 'fake-sid-0000',
  });
});

test('SESSDATA is stored as sent, not URL-decoded', () => {
  assert.deepEqual(parseSetCookies(['SESSDATA=fake%2Csess%2A0000; Path=/']), { SESSDATA: 'fake%2Csess%2A0000' });
});

test('qrCredentials takes the four cookies and refresh_token, ignores other cookies', () => {
  assert.deepEqual(qrCredentials(setCookies, { refresh_token: 'fake-refresh-0000' }), {
    cookies: {
      SESSDATA: 'fake-sessdata-0000',
      bili_jct: 'fake-jct-0000',
      DedeUserID: '1000001',
      DedeUserID__ckMd5: 'fake-ckmd5-0000',
    },
    extra: { refresh_token: 'fake-refresh-0000' },
  });
});

test('qrCredentials allows a missing ckMd5 and an empty refresh_token', () => {
  const credentials = qrCredentials(setCookies.filter((c) => !c.startsWith('DedeUserID__ckMd5')), {
    refresh_token: '',
  });
  assert.deepEqual(Object.keys(credentials.cookies), ['SESSDATA', 'bili_jct', 'DedeUserID']);
  assert.equal(credentials.extra, undefined);
});

test('qrCredentials without a required cookie is a ParseError naming only the cookie names', () => {
  for (const missing of ['SESSDATA', 'bili_jct', 'DedeUserID']) {
    const headers = setCookies.filter((c) => !c.startsWith(`${missing}=`));
    assert.throws(
      () => qrCredentials(headers, { refresh_token: 'fake-refresh-0000' }),
      (e) => e.fmpError === 'ParseError' && e.message.includes(missing) && !/fake-/.test(e.message),
      missing,
    );
  }
  assert.throws(() => qrCredentials(undefined, {}), (e) => e.fmpError === 'ParseError');
});

test('verifyCookie lists the credential cookies only and refuses a missing SESSDATA', () => {
  assert.equal(
    verifyCookie({
      cookies: { SESSDATA: 'fake-sessdata-0000', bili_jct: 'fake-jct-0000', DedeUserID: '1000001', other: 'x' },
    }),
    'SESSDATA=fake-sessdata-0000; bili_jct=fake-jct-0000; DedeUserID=1000001',
  );
  assert.throws(() => verifyCookie({ cookies: { bili_jct: 'x' } }), (e) => e.fmpError === 'CredentialInvalid');
});

// ---------------------------------------------------------------- loginQrStart

test('loginQrStart returns url and qrcode_key; the request has no cookie and auth never', async () => {
  const requests = fakeHost([
    ok({
      code: 0,
      message: '0',
      data: { url: 'https://passport.bilibili.com/h5-app/passport/login/scan?qrcode_key=fake-qr-0000', qrcode_key: 'fake-qr-0000' },
    }),
  ]);
  assert.deepEqual(await loginQrStart(), {
    qrText: 'https://passport.bilibili.com/h5-app/passport/login/scan?qrcode_key=fake-qr-0000',
    token: 'fake-qr-0000',
  });
  const [req] = requests;
  assert.equal(req.url, 'https://passport.bilibili.com/x/passport-login/web/qrcode/generate');
  assert.equal(req.auth, 'never');
  assert.equal(req.headers.Cookie, undefined);
  assert.equal(req.headers.Referer, 'https://www.bilibili.com/');
});

test('loginQrStart errors', async () => {
  fakeHost([ok({ code: -412, message: 'too fast' })]);
  await rejects(loginQrStart(), 'RateLimited');
  fakeHost([ok({ code: 0, data: { url: 'https://x' } })]);
  await rejects(loginQrStart(), 'ParseError');
  fakeHost([{ status: 500, body: '' }]);
  await rejects(loginQrStart(), 'NetworkError');
});

// ---------------------------------------------------------------- loginQrPoll

test('loginQrPoll maps 86101, 86090, 86038 to waiting, scanned, expired', async () => {
  for (const [code, status] of [
    [86101, 'waiting'],
    [86090, 'scanned'],
    [86038, 'expired'],
  ]) {
    fakeHost([ok({ code: 0, data: { code, message: 'x', url: '', refresh_token: '' } })]);
    assert.deepEqual(await loginQrPoll('fake-qr-0000'), { status });
  }
});

test('loginQrPoll sends the token as qrcode_key without a cookie', async () => {
  const requests = fakeHost([ok({ code: 0, data: { code: 86101 } })]);
  await loginQrPoll('fake qr/0000');
  assert.equal(
    requests[0].url,
    'https://passport.bilibili.com/x/passport-login/web/qrcode/poll?qrcode_key=fake%20qr%2F0000',
  );
  assert.equal(requests[0].auth, 'never');
  assert.equal(requests[0].headers.Cookie, undefined);
});

test('loginQrPoll done returns credentials from Set-Cookie and the body refresh_token', async () => {
  fakeHost([
    ok({ code: 0, data: { code: 0, refresh_token: 'fake-refresh-0000', url: 'https://x' } }, { 'set-cookie': setCookies }),
  ]);
  const result = await loginQrPoll('fake-qr-0000');
  assert.equal(result.status, 'done');
  assert.equal(result.credentials.cookies.SESSDATA, 'fake-sessdata-0000');
  assert.equal(result.credentials.extra.refresh_token, 'fake-refresh-0000');
});

test('loginQrPoll done without cookies is a ParseError, not a fake success', async () => {
  fakeHost([ok({ code: 0, data: { code: 0, refresh_token: 'fake-refresh-0000' } })]);
  await rejects(loginQrPoll('fake-qr-0000'), 'ParseError');
});

test('loginQrPoll unknown data.code and top-level failures use the business error mapping', async () => {
  fakeHost([ok({ code: 0, data: { code: 99999, message: 'new' } })]);
  await rejects(loginQrPoll('fake-qr-0000'), 'UnexpectedError');
  fakeHost([ok({ code: -412, message: 'too fast' })]);
  await rejects(loginQrPoll('fake-qr-0000'), 'RateLimited');
});

// ---------------------------------------------------------------- loginVerify

const credentials = {
  cookies: {
    SESSDATA: 'fake-sessdata-0000',
    bili_jct: 'fake-jct-0000',
    DedeUserID: '1000001',
    DedeUserID__ckMd5: 'fake-ckmd5-0000',
  },
};
const navBody = {
  code: 0,
  message: '0',
  data: { isLogin: true, mid: 1000001, uname: '假用戶', face: 'https://i0.hdslb.com/bfs/face/fake.jpg', vip: { status: 1 } },
};

test('loginVerify builds its own Cookie, uses auth never, and maps nav', async () => {
  const requests = fakeHost([ok(navBody)]);
  const account = await loginVerify(credentials);
  assert.equal(account.userId, '1000001');
  assert.equal(account.displayName, '假用戶');
  assert.deepEqual(
    account.avatar.map((a) => a.url),
    [
      'https://i0.hdslb.com/bfs/face/fake.jpg@160w',
      'https://i0.hdslb.com/bfs/face/fake.jpg@480w',
      'https://i0.hdslb.com/bfs/face/fake.jpg',
    ],
  );
  const [req] = requests;
  assert.equal(req.url, 'https://api.bilibili.com/x/web-interface/nav');
  assert.equal(req.auth, 'never');
  assert.equal(
    req.headers.Cookie,
    'SESSDATA=fake-sessdata-0000; bili_jct=fake-jct-0000; DedeUserID=1000001; DedeUserID__ckMd5=fake-ckmd5-0000',
  );
});

test('loginVerify: -101 and -111 are CredentialInvalid', async () => {
  for (const code of [-101, -111]) {
    fakeHost([ok({ code, message: 'x' })]);
    await rejects(loginVerify(credentials), 'CredentialInvalid');
  }
  fakeHost([]);
  await rejects(loginVerify({ cookies: {} }), 'CredentialInvalid');
});

test('loginVerify: other failures keep their usual category', async () => {
  fakeHost([ok({ code: -352, message: 'risk' })]);
  await rejects(loginVerify(credentials), 'RateLimited');
  fakeHost([ok({ code: -799 })]);
  await rejects(loginVerify(credentials), 'RateLimited');
  fakeHost([ok({ code: 12345 })]);
  await rejects(loginVerify(credentials), 'UnexpectedError');
  fakeHost([{ status: 412, body: '' }]);
  await rejects(loginVerify(credentials), 'RateLimited');
  fakeHost([ok('<html>')]);
  await rejects(loginVerify(credentials), 'ParseError');
  fakeHost([ok({ code: 0, data: { isLogin: true, uname: 'x' } })]);
  await rejects(loginVerify(credentials), 'ParseError');
});

test('-111 is AuthRequired in the shared business mapping (a search with bad credentials)', async () => {
  const requests = fakeHost([ok({ code: -111, message: 'csrf' })]);
  const { search } = await import('../src/plugin.js');
  await rejects(search({ keyword: 'x', page: 1 }), 'AuthRequired');
  assert.equal(requests[0].auth, 'userPreference');
});
