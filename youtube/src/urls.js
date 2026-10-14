// 網址的網域檢查：宿主只收 allowedHosts 內的封面與串流網址，search、resolveStream、mix 共用同一個判斷。

function hostOf(url) {
  const match = /^https:\/\/([^/?#:]+)(?::\d+)?(?:[/?#]|$)/i.exec(String(url));
  return match ? match[1].toLowerCase() : null;
}

/** `https` 且網域是 domains 之一（含子網域）。 */
export function isAllowedHttps(url, domains) {
  const host = hostOf(url);
  return host !== null && domains.some((d) => host === d || host.endsWith(`.${d}`));
}
