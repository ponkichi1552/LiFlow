/** Fixed windows stay ordered by expiry so steady requests never scan every identity. */
export function createFixedWindowRateLimit({ limit, maximumKeys = 10_000, windowMs = 60_000, now = Date.now }) {
  if (![limit, maximumKeys, windowMs].every(value => Number.isSafeInteger(value) && value > 0)) throw new Error('Invalid rate limit');
  const windows = new Map(); let clock = -Infinity;
  return key => {
    const time = now(); if (!Number.isFinite(time)) return false;
    // A wall-clock correction must not move newly inserted expiries ahead of older entries.
    clock = Math.max(clock, time);
    for (const [identity, entry] of windows) {
      if (entry.until > clock) break;
      windows.delete(identity);
    }
    const existing = windows.get(key);
    if (existing) {
      if (existing.count >= limit) return false;
      existing.count++; return true;
    }
    if (windows.size >= maximumKeys) return false;
    windows.set(key, { until: clock + windowMs, count: 1 }); return true;
  };
}
