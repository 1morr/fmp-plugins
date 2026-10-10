// 錯誤對應表：YouTube 的 playabilityStatus → 結構化錯誤（ADR 0013 §決定 2）。
// 429 與傳輸錯誤由宿主的網路層轉換，這裡不處理。

export function error(fmpError, message, extra) {
  return { fmpError, message, ...extra };
}

/** status 不是 OK 時的錯誤。reason 是 YouTube 給使用者看的文字（英文）。 */
export function playabilityError(status, reason) {
  const text = String(reason || '');
  const detail = `playability ${status}: ${text}`;
  if (/not a bot/i.test(text)) return error('VerificationRequired', detail);
  if (status === 'LOGIN_REQUIRED') {
    if (/age|inappropriate/i.test(text)) return error('Unavailable', detail, { reason: 'age' });
    // 私人影片等：登入後才可能看。
    return error('AuthRequired', detail);
  }
  if (status === 'UNPLAYABLE') {
    if (/country|region|location/i.test(text)) return error('Unavailable', detail, { reason: 'region' });
    if (/copyright/i.test(text)) return error('Unavailable', detail, { reason: 'copyright' });
    if (/member|join this channel/i.test(text)) return error('Unavailable', detail, { reason: 'membership' });
    return error('UnexpectedError', detail);
  }
  if (status === 'ERROR') return error('NotFound', detail);
  return error('UnexpectedError', detail);
}

/**
 * 「憑證無效」判定表（design §6.5）：只在宿主說這次請求真的帶了憑證
 * （HttpResponse.credentialsAttached 為 true）的回應上成立；沒帶憑證的 401 是匿名請求被拒，
 * 不是憑證失效，回 null 交給原本的處理。YouTube 的判定只有 HTTP 401：
 * 403（風控、地區）與 429（宿主轉成 RateLimited）都不算。
 */
export function credentialInvalidError(status, credentialsAttached) {
  if (status === 401 && credentialsAttached === true) {
    return error('CredentialInvalid', 'HTTP 401 on a request with credentials');
  }
  return null;
}
