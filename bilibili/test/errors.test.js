// 錯誤對應表的測試。契約測試每個能力只有一條案例（FMP ADR 0015 §決定 4），
// 業務碼的對應在這裡逐一守。credentialsRejected 的判定表在 refresh.test.js。
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { RISK_CONTROL_CODES, businessError } from '../src/errors.js';

const table = [
  [-101, 'AuthRequired', undefined],
  [-111, 'AuthRequired', undefined],
  [-403, 'AuthRequired', undefined],
  [-404, 'NotFound', undefined],
  [62002, 'NotFound', undefined],
  [62004, 'NotFound', undefined],
  [62012, 'NotFound', undefined],
  [60004, 'NotFound', undefined],
  [-10403, 'Unavailable', 'region'],
  [87007, 'Unavailable', 'membership'],
  [87008, 'Unavailable', 'membership'],
  [-503, 'NetworkError', undefined],
  [-999999, 'UnexpectedError', undefined],
  [0, 'UnexpectedError', undefined],
];

for (const [code, fmpError, reason] of table) {
  test(`code ${code} -> ${fmpError}${reason ? `(${reason})` : ''}`, () => {
    const e = businessError(code, 'msg', 'view');
    assert.equal(e.fmpError, fmpError);
    assert.equal(e.reason, reason);
  });
}

test('every risk-control code is RateLimited', () => {
  assert.deepEqual(RISK_CONTROL_CODES, [-352, -412, -509, -799]);
  for (const code of RISK_CONTROL_CODES) {
    const e = businessError(code, '', 'playurl');
    assert.equal(e.fmpError, 'RateLimited', `code ${code}`);
    assert.equal(e.reason, undefined);
  }
});

test('message carries context and code, and a missing message does not throw', () => {
  const e = businessError(-404, '啥都木有', 'view');
  assert.equal(e.message, 'view: code -404 啥都木有');
  for (const message of [undefined, null, '']) {
    const bare = businessError(-404, message, 'view');
    assert.equal(bare.message, 'view: code -404');
  }
  assert.doesNotThrow(() => businessError('not-a-number', undefined, 'nav'));
  assert.equal(businessError('not-a-number', undefined, 'nav').fmpError, 'UnexpectedError');
});
