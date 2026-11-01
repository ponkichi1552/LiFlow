export const OFFICIAL_DOMAINS_BY_MANUFACTURER = Object.freeze({
  dyson: ['dyson.co.jp'],
  ダイソン: ['dyson.co.jp'],
  panasonic: ['panasonic.jp'],
  パナソニック: ['panasonic.jp'],
  hitachi: ['kadenfan.hitachi.co.jp'],
  日立: ['kadenfan.hitachi.co.jp'],
  sharp: ['jp.sharp'],
  シャープ: ['jp.sharp'],
});

export function officialDomainsForManufacturer(manufacturer) {
  if (typeof manufacturer !== 'string') return [];
  const key = manufacturer.normalize('NFKC').trim().toLocaleLowerCase('en-US');
  return Object.hasOwn(OFFICIAL_DOMAINS_BY_MANUFACTURER, key) ? OFFICIAL_DOMAINS_BY_MANUFACTURER[key] : [];
}

export function isAllowedOfficialUrl(value, allowedDomains) {
  if (typeof value !== 'string' || value.length > 2048) return false;
  let url;
  try {
    url = new URL(value);
  } catch {
    return false;
  }

  if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443')) return false;
  const hostname = url.hostname.toLocaleLowerCase('en-US').replace(/\.$/, '');
  return allowedDomains.some((domain) => {
    const normalizedDomain = domain.toLocaleLowerCase('en-US').replace(/\.$/, '');
    return hostname === normalizedDomain || hostname.endsWith('.' + normalizedDomain);
  });
}

export function isBackedByOfficialSearchResult(value, sourceUrls, allowedDomains) {
  if (!isAllowedOfficialUrl(value, allowedDomains)) return false;
  const candidateKey = urlKey(value);
  return sourceUrls.some((sourceUrl) =>
    isAllowedOfficialUrl(sourceUrl, allowedDomains) && urlKey(sourceUrl) === candidateKey,
  );
}

function urlKey(value) {
  const url = new URL(value);
  const path = url.pathname.replace(/\/+$/, '') || '/';
  return url.origin.toLocaleLowerCase('en-US') + path + url.search;
}
