export const ANALYSIS_TIMEOUT_MS = 10 * 60_000;

/** Portable wire canonicalization. Firestore object-key ordering is not significant. */
export function analysisDeliveryJson(value) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(analysisDeliveryJson).join(',') + ']';
  if (value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + analysisDeliveryJson(value[key])).join(',') + '}';
  }
  throw new Error('Invalid analysis delivery value');
}

export function validAnalysisDelivery(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).length === 3 && /^[a-f0-9]{64}$/u.test(value.token)
    && /^[a-f0-9]{64}$/u.test(value.digest) && Number.isSafeInteger(value.expiresAt) && value.expiresAt > 0);
}
