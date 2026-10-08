// 錯誤對應表的測試。契約測試每個能力只有一條案例（FMP ADR 0015 §決定 4），
// 錯誤的對應在這裡以網易實際給的欄位守。
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { responseCodeError, statusError, streamUnavailableError } from '../src/errors.js';

test('top-level -460 is verification', () => {
  assert.equal(responseCodeError(-460, '網絡太擁擠', 'player').fmpError, 'VerificationRequired');
});

test('top-level 301 needs login, other codes are unexpected', () => {
  assert.equal(responseCodeError(301, '', 'player').fmpError, 'AuthRequired');
  assert.equal(responseCodeError(500, '', 'player').fmpError, 'UnexpectedError');
});

test('HTTP status', () => {
  assert.equal(statusError(460, 'search').fmpError, 'VerificationRequired');
  assert.equal(statusError(462, 'search').fmpError, 'VerificationRequired');
  assert.equal(statusError(503, 'search').fmpError, 'NetworkError');
  assert.equal(statusError(404, 'search').fmpError, 'UnexpectedError');
});

const stream = [
  [{ code: 404, fee: 1 }, 'Unavailable', 'membership'],
  [{ code: 404, fee: 4 }, 'Unavailable', 'membership'],
  [{ code: -110, fee: 0 }, 'Unavailable', 'copyright'],
  [{ code: 404, fee: 8, flag: 256 }, 'Unavailable', 'copyright'],
  [{ code: 301, fee: 0 }, 'AuthRequired', undefined],
  [{ code: 404, fee: 0, flag: 6 }, 'AuthRequired', undefined],
  [{ code: 404, fee: 8 }, 'NotFound', undefined],
  [{ code: 200, fee: 0 }, 'NotFound', undefined],
  [{ code: '404', fee: '1' }, 'Unavailable', 'membership'],
  [{}, 'NotFound', undefined],
];

for (const [item, fmpError, reason] of stream) {
  test(`no url ${JSON.stringify(item)} -> ${fmpError}${reason ? `(${reason})` : ''}`, () => {
    const e = streamUnavailableError(item, 'player');
    assert.equal(e.fmpError, fmpError);
    assert.equal(e.reason, reason);
  });
}

test('flag & 4 alone is not a vip marker', () => {
  assert.notEqual(streamUnavailableError({ code: 404, fee: 0, flag: 4 }, 'player').reason, 'membership');
});
