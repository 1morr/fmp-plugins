// QR 登入：狀態碼對應、Set-Cookie 解析、verify 對應，以及請求的形狀（假的宿主 API，不連網）。
// cookie 值都是 fake-… 開頭的假值。
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { loginQrPoll, loginQrStart, loginVerify } from '../src/plugin.js';
import { parseCookieString, parseSetCookies, qrCredentials, qrStatusOf, verifyCookie } from '../src/login.js';

function fakeHost(responses) {
  const requests = [];
  const queue = [...responses];
  globalThis.fmp = {
    crypto: { md5: () => '' },
    log: { debug() {}, info() {}, warn() {} },
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

// ---------------------------------------------------------------- 純函式

test('qrStatusOf maps 801/802/800/803 and nothing else', () => {
  assert.equal(qrStatusOf(801), 'waiting');
  assert.equal(qrStatusOf(802), 'scanned');
  assert.equal(qrStatusOf(800), 'expired');
  assert.equal(qrStatusOf(803), 'done');
  assert.equal(qrStatusOf(200), null);
  assert.equal(qrStatusOf(undefined), null);
});

test('parseSetCookies reads several headers, drops attributes, keeps = inside values', () => {
  const jar = parseSetCookies([
    'MUSIC_U=fake-music-u-0000; Max-Age=15552000; Expires=Wed, 01 Jan 2031 00:00:00 GMT; Path=/; HTTPOnly',
    '__csrf=fake-csrf-0000; Path=/; Domain=.music.163.com',
    'NMTID=a=b==; Path=/',
  ]);
  assert.deepEqual(jar, { MUSIC_U: 'fake-music-u-0000', __csrf: 'fake-csrf-0000', NMTID: 'a=b==' });
});

test('parseSetCookies ignores empty values (cookie clearing) and junk', () => {
  assert.deepEqual(parseSetCookies(['MUSIC_U=; Max-Age=0', 'novalue', '=x', 5]), {});
  assert.deepEqual(parseSetCookies(undefined), {});
  assert.deepEqual(parseSetCookies(['MUSIC_U=fake-a', 'MUSIC_U=fake-b']), { MUSIC_U: 'fake-b' });
});

test('parseCookieString skips attributes in any case', () => {
  const jar = parseCookieString(
    'MUSIC_U=fake-music-u-0000;Max-Age=1;Path=/;HttpOnly;__csrf=fake-csrf-0000;Expires=x;SameSite=Lax;Secure',
  );
  assert.deepEqual(jar, { MUSIC_U: 'fake-music-u-0000', __csrf: 'fake-csrf-0000' });
  assert.deepEqual(parseCookieString(undefined), {});
});

test('qrCredentials prefers Set-Cookie and falls back to the body cookie', () => {
  assert.deepEqual(
    qrCredentials(['MUSIC_U=fake-header-0000; Path=/', '__csrf=fake-csrf-0000'], 'MUSIC_U=fake-body-0000'),
    { cookies: { MUSIC_U: 'fake-header-0000', __csrf: 'fake-csrf-0000' } },
  );
  assert.deepEqual(qrCredentials(undefined, 'MUSIC_U=fake-body-0000;__csrf=fake-csrf-0001;Path=/'), {
    cookies: { MUSIC_U: 'fake-body-0000', __csrf: 'fake-csrf-0001' },
  });
  assert.deepEqual(qrCredentials(['MUSIC_U=fake-header-0000'], undefined), {
    cookies: { MUSIC_U: 'fake-header-0000' },
  });
});

test('qrCredentials without MUSIC_U is a ParseError that does not echo values', () => {
  assert.throws(
    () => qrCredentials(['__csrf=fake-csrf-0000'], 'foo=bar'),
    (e) => e.fmpError === 'ParseError' && /MUSIC_U/.test(e.message) && !/fake-csrf/.test(e.message),
  );
});

test('verifyCookie builds the legacy cookie and refuses missing MUSIC_U', () => {
  assert.equal(
    verifyCookie({ cookies: { MUSIC_U: 'fake-music-u-0000', __csrf: 'fake-csrf-0000' } }),
    'MUSIC_U=fake-music-u-0000; __csrf=fake-csrf-0000; os=pc; deviceId=fmp',
  );
  assert.equal(
    verifyCookie({ cookies: { MUSIC_U: 'fake-music-u-0000' } }),
    'MUSIC_U=fake-music-u-0000; os=pc; deviceId=fmp',
  );
  assert.throws(() => verifyCookie({ cookies: {} }), (e) => e.fmpError === 'CredentialInvalid');
  assert.throws(() => verifyCookie({ cookies: { MUSIC_U: '' } }), (e) => e.fmpError === 'CredentialInvalid');
});

// ---------------------------------------------------------------- loginQrStart

test('loginQrStart returns the login URL and the unikey as token', async () => {
  const requests = fakeHost([ok({ code: 200, unikey: 'fake-unikey-0000' })]);
  const result = await loginQrStart();
  assert.deepEqual(result, {
    qrText: 'https://music.163.com/login?codekey=fake-unikey-0000',
    token: 'fake-unikey-0000',
  });
  const [req] = requests;
  assert.equal(req.url, 'https://music.163.com/weapi/login/qrcode/unikey?csrf_token=');
  assert.equal(req.method, 'POST');
  assert.equal(req.auth, 'never');
  assert.equal(req.idempotent, true);
  assert.match(req.headers.Cookie, /^os=pc; osver=.*; appver=2\.7\.1\.198277; channel=netease; __csrf=; MUSIC_U=$/);
  assert.match(req.body, /^params=[^&]+&encSecKey=[0-9a-f]{256}$/);
});

test('loginQrStart errors: business code, missing unikey, HTTP status, bad body', async () => {
  fakeHost([ok({ code: -460, message: 'cheating' })]);
  await rejects(loginQrStart(), 'VerificationRequired');
  fakeHost([ok({ code: 200 })]);
  await rejects(loginQrStart(), 'ParseError');
  fakeHost([{ status: 502, body: '' }]);
  await rejects(loginQrStart(), 'NetworkError');
  fakeHost([ok('not json')]);
  await rejects(loginQrStart(), 'ParseError');
});

// ---------------------------------------------------------------- loginQrPoll

test('loginQrPoll maps the waiting, scanned and expired codes without credentials', async () => {
  for (const [code, status] of [
    [801, 'waiting'],
    [802, 'scanned'],
    [800, 'expired'],
  ]) {
    fakeHost([ok({ code, message: 'x' })]);
    assert.deepEqual(await loginQrPoll('fake-unikey-0000'), { status });
  }
});

test('loginQrPoll encrypts the token each time and does not retry', async () => {
  const requests = fakeHost([ok({ code: 801 }), ok({ code: 801 })]);
  await loginQrPoll('fake-unikey-0000');
  await loginQrPoll('fake-unikey-0000');
  assert.equal(requests[0].url, 'https://music.163.com/weapi/login/qrcode/client/login?csrf_token=');
  assert.equal(requests[0].idempotent, false);
  assert.equal(requests[0].auth, 'never');
  assert.notEqual(requests[0].body, requests[1].body);
});

test('loginQrPoll 803 takes MUSIC_U and __csrf from Set-Cookie', async () => {
  fakeHost([
    ok(
      { code: 803, message: 'ok', cookie: 'MUSIC_U=fake-body-0000' },
      {
        'set-cookie': [
          'MUSIC_U=fake-music-u-0000; Max-Age=15552000; Path=/; HTTPOnly',
          '__csrf=fake-csrf-0000; Max-Age=1296010; Path=/',
        ],
      },
    ),
  ]);
  assert.deepEqual(await loginQrPoll('fake-unikey-0000'), {
    status: 'done',
    credentials: { cookies: { MUSIC_U: 'fake-music-u-0000', __csrf: 'fake-csrf-0000' } },
  });
});

test('loginQrPoll 803 falls back to the body cookie string', async () => {
  fakeHost([ok({ code: 803, cookie: 'MUSIC_U=fake-body-0000;Path=/;HTTPOnly;__csrf=fake-csrf-0001' })]);
  const result = await loginQrPoll('fake-unikey-0000');
  assert.deepEqual(result.credentials, { cookies: { MUSIC_U: 'fake-body-0000', __csrf: 'fake-csrf-0001' } });
});

test('loginQrPoll 803 without any MUSIC_U is a ParseError, not a fake success', async () => {
  fakeHost([ok({ code: 803 })]);
  await rejects(loginQrPoll('fake-unikey-0000'), 'ParseError');
});

test('loginQrPoll unknown codes map like other response codes', async () => {
  fakeHost([ok({ code: -460 })]);
  await rejects(loginQrPoll('fake-unikey-0000'), 'VerificationRequired');
  fakeHost([ok({ code: 500, message: 'boom' })]);
  await rejects(loginQrPoll('fake-unikey-0000'), 'UnexpectedError');
  fakeHost([{ status: 460, body: '' }]);
  await rejects(loginQrPoll('fake-unikey-0000'), 'VerificationRequired');
});

// ---------------------------------------------------------------- loginVerify

const credentials = { cookies: { MUSIC_U: 'fake-music-u-0000', __csrf: 'fake-csrf-0000' } };
const profileBody = {
  code: 200,
  account: { id: 1000001 },
  profile: {
    userId: 1000001,
    nickname: '假用戶',
    avatarUrl: 'http://p1.music.126.net/fake/avatar.jpg?param=50y50',
    vipType: 11,
  },
};

test('loginVerify builds its own Cookie with auth never and maps the profile', async () => {
  const requests = fakeHost([ok(profileBody)]);
  const account = await loginVerify(credentials);
  assert.equal(account.userId, '1000001');
  assert.equal(account.displayName, '假用戶');
  assert.deepEqual(
    account.avatar.map((a) => a.url),
    [
      'https://p1.music.126.net/fake/avatar.jpg?param=120y120',
      'https://p1.music.126.net/fake/avatar.jpg?param=200y200',
      'https://p1.music.126.net/fake/avatar.jpg?param=400y400',
    ],
  );
  const [req] = requests;
  assert.equal(req.url, 'https://music.163.com/api/nuser/account/get');
  assert.equal(req.method, 'GET');
  assert.equal(req.auth, 'never');
  assert.equal(req.headers.Cookie, 'MUSIC_U=fake-music-u-0000; __csrf=fake-csrf-0000; os=pc; deviceId=fmp');
});

test('loginVerify falls back to the POST endpoint when the GET is not 200', async () => {
  const requests = fakeHost([{ status: 404, body: '' }, ok(profileBody)]);
  const account = await loginVerify(credentials);
  assert.equal(account.userId, '1000001');
  assert.equal(requests[1].method, 'POST');
  assert.equal(requests[1].url, 'https://music.163.com/api/w/nuser/account/get');
  assert.equal(requests[1].auth, 'never');
});

test('loginVerify uses account.id when the profile has no userId, and the id as a name fallback', async () => {
  fakeHost([ok({ code: 200, account: { id: 42 }, profile: { nickname: '' } })]);
  assert.deepEqual(await loginVerify(credentials), { userId: '42', displayName: '42' });
});

test('loginVerify: code 301 and a missing profile are CredentialInvalid', async () => {
  fakeHost([ok({ code: 301 })]);
  await rejects(loginVerify(credentials), 'CredentialInvalid');
  fakeHost([ok({ code: 200, profile: null })]);
  await rejects(loginVerify(credentials), 'CredentialInvalid');
  fakeHost([]);
  await rejects(loginVerify({ cookies: {} }), 'CredentialInvalid');
});

test('loginVerify: other failures keep their usual category', async () => {
  fakeHost([ok({ code: -460 })]);
  await rejects(loginVerify(credentials), 'VerificationRequired');
  fakeHost([ok({ code: 500 })]);
  await rejects(loginVerify(credentials), 'UnexpectedError');
  fakeHost([
    { status: 500, body: '' },
    { status: 500, body: '' },
  ]);
  await rejects(loginVerify(credentials), 'NetworkError');
  fakeHost([ok('<html>')]);
  await rejects(loginVerify(credentials), 'ParseError');
  fakeHost([ok({ code: 200, profile: { nickname: 'x' } })]);
  await rejects(loginVerify(credentials), 'ParseError');
});
