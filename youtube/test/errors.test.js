// 錯誤對應表的測試。契約測試每個能力只有一條案例（FMP ADR 0015 §決定 4），
// 錯誤的對應在這裡以 YouTube 實際給的 playabilityStatus 文字守。
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { playabilityError } from '../src/errors.js';

const cases = [
  ['LOGIN_REQUIRED', 'Sign in to confirm you’re not a bot', 'VerificationRequired', undefined],
  ['UNPLAYABLE', 'Sign in to confirm you’re not a bot', 'VerificationRequired', undefined],
  ['LOGIN_REQUIRED', 'Sign in to confirm your age', 'Unavailable', 'age'],
  ['LOGIN_REQUIRED', 'This video may be inappropriate for some users.', 'Unavailable', 'age'],
  ['LOGIN_REQUIRED', 'This video is private', 'AuthRequired', undefined],
  ['UNPLAYABLE', 'The uploader has not made this video available in your country', 'Unavailable', 'region'],
  ['UNPLAYABLE', 'This video contains content from SME, who has blocked it on copyright grounds', 'Unavailable', 'copyright'],
  ['UNPLAYABLE', 'Join this channel to get access to members-only content like this video', 'Unavailable', 'membership'],
  ['UNPLAYABLE', 'Playback on other websites has been disabled by the video owner', 'UnexpectedError', undefined],
  ['ERROR', 'Video unavailable', 'NotFound', undefined],
  ['CONTENT_CHECK_REQUIRED', '', 'UnexpectedError', undefined],
];

for (const [status, reason, fmpError, expectedReason] of cases) {
  test(`${status}: ${reason || '(empty)'} -> ${fmpError}${expectedReason ? `(${expectedReason})` : ''}`, () => {
    const e = playabilityError(status, reason);
    assert.equal(e.fmpError, fmpError);
    assert.equal(e.reason, expectedReason);
    assert.match(e.message, new RegExp(`^playability ${status}`));
  });
}

import { credentialInvalidError } from '../src/errors.js';

test('credentialInvalidError: only a 401 on a request that carried credentials', () => {
  assert.equal(credentialInvalidError(401, true).fmpError, 'CredentialInvalid');
  // 沒帶憑證的 401 是匿名請求被拒，不判定。
  assert.equal(credentialInvalidError(401, false), null);
  assert.equal(credentialInvalidError(401, undefined), null);
  // 403（風控、地區）與 429（宿主轉成 RateLimited）維持原樣，帶不帶憑證都一樣。
  for (const status of [200, 403, 429, 500]) {
    assert.equal(credentialInvalidError(status, true), null, String(status));
    assert.equal(credentialInvalidError(status, false), null, String(status));
  }
});
