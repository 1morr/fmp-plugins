// 錯誤對應表：網易的狀態碼與回應碼 → 結構化錯誤（FMP ADR 0013 §決定 2）。
// 規格是舊專案 netease_source.dart 的 _checkResponse、_classifyStreamUnavailable、_handleDioError。
// 429 與傳輸錯誤由宿主的網路層轉換，這裡不處理。

export function error(fmpError, message, extra) {
  return { fmpError, message, ...extra };
}

function asInt(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.trunc(value);
  if (typeof value === 'string' && /^-?\d+$/.test(value.trim())) return Number(value);
  return null;
}

/** HTTP 狀態碼不是 200。460／462 是風控（舊專案同樣對應 -460）。 */
export function statusError(status, context) {
  const detail = `${context}: HTTP ${status}`;
  if (status === 460 || status === 462) return error('VerificationRequired', detail);
  if (status >= 500) return error('NetworkError', detail);
  return error('UnexpectedError', detail);
}

/**
 * 這個 JSON 回應表示憑證已經失效嗎？只有 [credentialsAttached] 為 true（宿主真的帶了憑證）且
 * 頂層 `code` 是 301（未登入）才算。匿名請求的 301 只是沒登入；-460（風控）、其他碼、
 * 取流項目裡的 `code` 都不是憑證無效（匿名取流的 404、fee 0 也不是）。
 */
export function credentialsRejected(json, credentialsAttached) {
  return credentialsAttached === true && json !== null && typeof json === 'object' && json.code === 301;
}

/** 回應頂層的 `code` 不是 200（或 0）。 */
export function responseCodeError(code, message, context) {
  const detail = `${context}: code ${code} ${message || ''}`.trim();
  if (code === -460) return error('VerificationRequired', detail);
  if (code === 301) return error('AuthRequired', detail);
  return error('UnexpectedError', detail);
}

/**
 * `data[0]` 沒有可用網址時的錯誤。判斷只看 `fee`、`code`、`flag`，不比對訊息文字。
 *
 * - `fee` 1（VIP）、4（數位專輯）：`Unavailable(membership)`。
 * - 版權或地區（`code` -110，或 `flag & 256`）：`Unavailable(copyright)`。
 * - 未登入：`code` 301，或 `code` 404 且 `fee` 0（網易明說不是付費歌曲卻不給網址，匿名請求
 *   就是這樣，登入後可播，舊專案 #87）：`AuthRequired`。
 * - 其他 `code` 404 與空網址：`NotFound`。
 * `flag & 4` 不是 VIP 標記（舊專案實測 139774 是 flag=6 卻匿名可播），不用。
 */
export function streamUnavailableError(item, context) {
  const fee = asInt(item.fee);
  const code = asInt(item.code);
  const flag = asInt(item.flag);
  const detail = `${context}: no url (code ${code}, fee ${fee}, flag ${flag})`;
  if (code === 301) return error('AuthRequired', detail);
  if (fee === 1 || fee === 4) return error('Unavailable', detail, { reason: 'membership' });
  if (code === -110 || (flag !== null && (flag & 256) !== 0)) {
    return error('Unavailable', detail, { reason: 'copyright' });
  }
  if (code === 404 && fee === 0) return error('AuthRequired', detail);
  return error('NotFound', detail);
}
