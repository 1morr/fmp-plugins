// 錯誤對應表：B 站業務碼 → 結構化錯誤；規格是舊專案 BilibiliApiException。
// 契約每能力只有一條案例（FMP ADR 0015 §決定 4），對應在 test/errors.test.js 守。

// 風控碼：一律限流，由上層退避（舊專案 BilibiliApiException.riskControlCodes）。
export const RISK_CONTROL_CODES = [-352, -412, -509, -799];

export function error(fmpError, message, extra) {
  return { fmpError, message, ...extra };
}

/** 業務錯誤碼 → 結構化錯誤。 */
export function businessError(code, message, context) {
  const detail = `${context}: code ${code} ${message || ''}`.trim();
  if (RISK_CONTROL_CODES.includes(code)) return error('RateLimited', detail);
  switch (code) {
    case -101: // 未登入
    case -111: // csrf 驗證失敗（憑證的 bili_jct 與 SESSDATA 對不上）
    case -403: // 權限不足
      return error('AuthRequired', detail);
    case -404: // 啥都木有
    case 62002: // 稿件不可見
    case 62004: // 稿件審核中
    case 62012: // 僅 UP 主自己可見
    case 60004: // 直播間不存在（room_init）
      return error('NotFound', detail);
    case -10403: // 地區限制
      return error('Unavailable', detail, { reason: 'region' });
    case 87007: // 充電專屬
    case 87008:
      return error('Unavailable', detail, { reason: 'membership' });
    case -503: // 服務調用超時
      return error('NetworkError', detail);
    default:
      return error('UnexpectedError', detail);
  }
}

/** 憑證無效的業務碼（舊專案 bilibili_auth_interceptor.dart 的 _isAuthError）。 */
export const CREDENTIAL_INVALID_CODES = [-101, -111];

/**
 * 這個 JSON 回應表示憑證已經失效嗎？只有 [credentialsAttached] 為 true（宿主真的帶了憑證）且
 * 頂層 `code` 是 -101（未登入）或 -111（csrf 驗證失敗）才算。匿名請求的 -101 只是沒登入
 * （例如 nav 取 WBI key），風控碼、限流與網路錯誤也都不是憑證無效。匯出只為了單元測試。
 */
export function credentialsRejected(json, credentialsAttached) {
  return (
    credentialsAttached === true &&
    json !== null &&
    typeof json === 'object' &&
    CREDENTIAL_INVALID_CODES.includes(json.code)
  );
}
