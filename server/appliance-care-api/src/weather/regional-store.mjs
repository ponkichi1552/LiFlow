import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
const data = JSON.parse(readFileSync(new URL('./municipalities-data.json', import.meta.url), 'utf8'));
const HOUR = 3_600_000; const DAY = 24 * HOUR;
export const WEATHER_CACHE_SCHEMA = 1;
const regions = new Map(data.regions.map(row => [row[0], Object.freeze({ id: row[0], latitude: row[6], longitude: row[7] })]));
export function weatherRegion(id) { return regions.get(id) ?? null; }
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export function weatherRegionKey(region) { return hash([WEATHER_CACHE_SCHEMA, region.id, region.latitude, region.longitude]); }
export function nextNormalWeatherCheck(key, now) {
  const offset = parseInt(key.slice(0, 8), 16) % HOUR - HOUR / 2;
  return now + DAY + offset;
}
export const weatherCacheRevision = cache => hash([cache.forecast, cache.checkedAt, cache.fetchedAt, cache.expiresAt, cache.lastModified]);
function activeBudget(saved, stamp) {
  return { ...saved, starts: (saved?.starts ?? []).filter(value => value > stamp - 1000),
    leases: Object.fromEntries(Object.entries(saved?.leases ?? {}).filter(([, value]) => value.until > stamp)) };
}
function budgetReady(global, stamp) {
  return !global.halted && (global.notBefore ?? 0) <= stamp && global.starts.length < 2 && Object.keys(global.leases).length < 4;
}

/** The atomic port is shared by the real Firestore adapter and isolated tests.
 * No in-memory fallback is installed in the production runtime. */
export function createRegionalWeatherStore({ read, readControl, atomic, due, now = Date.now, token = randomUUID }) {
  return {
    async reference(id) {
      const region = weatherRegion(id); if (!region) return null;
      const key = weatherRegionKey(region); const stamp = now();
      const prior = await read(key);
      if (prior && stamp >= prior.lastReferencedAt && stamp - prior.lastReferencedAt < HOUR) return prior;
      return atomic(key, current => {
        if (current && stamp >= current.lastReferencedAt && stamp - current.lastReferencedAt < HOUR) return { result: current };
        if (!current) current = { schemaVersion: WEATHER_CACHE_SCHEMA, region, key, lastReferencedAt: stamp,
          nextAttemptAt: stamp, retryCount: 0, status: 'queued', cache: null, lease: null };
        else current = { ...current, lastReferencedAt: stamp,
          ...(current.status === 'inactive' ? { status: 'queued', nextAttemptAt: stamp } : {}) };
        return { region: current, result: current };
      });
    },
    async claim() {
      const stamp = now();
      const candidates = await due(stamp); if (!candidates.length) return null;
      // Read-only rejection avoids 32 identical contended transactions when
      // the application-wide gate is closed. Actual admission is still atomic.
      if (readControl && !budgetReady(activeBudget(await readControl(), stamp), stamp)) return null;
      for (const key of candidates) {
        const leaseToken = token();
        const claim = await atomic(key, (current, savedGlobal) => {
          if (!current || current.nextAttemptAt === null || current.nextAttemptAt > stamp || current.lease?.until > stamp) return { result: null };
          if (stamp < current.lastReferencedAt || stamp - current.lastReferencedAt >= 7 * DAY) return {
            region: { ...current, status: 'inactive', nextAttemptAt: null, lease: null }, result: null };
          const global = activeBudget(savedGlobal, stamp);
          if (!budgetReady(global, stamp)) return { result: null };
          const lease = { token: leaseToken, until: stamp + 60_000 };
          global.starts.push(stamp); global.leases[key] = lease;
          const region = { ...current, status: 'fetching', lease };
          return { region, global, result: { ...region, leaseToken } };
        }, true);
        if (claim) return claim;
      }
      return null;
    },
    async finish(claim, outcome) {
      const stamp = now();
      return atomic(claim.key, (current, savedGlobal) => {
        if (current?.lease?.token !== claim.leaseToken) return { result: false };
        const global = { ...(savedGlobal ?? {}), leases: { ...(savedGlobal?.leases ?? {}) } };
        if (global.leases[claim.key]?.token === claim.leaseToken && !outcome.transportUnsettled) delete global.leases[claim.key];
        const region = { ...current, lease: null };
        if (outcome.cache) {
          region.cache = { ...outcome.cache, revision: weatherCacheRevision(outcome.cache) };
          region.status = 'ready'; region.retryCount = 0;
          region.nextAttemptAt = Math.max(nextNormalWeatherCheck(claim.key, stamp), Date.parse(outcome.cache.expiresAt) || 0);
          region.error = null;
        } else {
          region.error = outcome.code;
          region.retryCount = current.retryCount + 1;
          if (outcome.code === 'met_forbidden') {
            region.status = 'blocked'; region.nextAttemptAt = null; global.halted = true; global.haltReason = 'met_forbidden';
          } else {
            const delays = [5 * 60_000, 30 * 60_000, 2 * HOUR]; const delay = delays[region.retryCount - 1];
            const jitter = (parseInt(hash([claim.key, region.retryCount]).slice(0, 8), 16) % 120_001) - 60_000;
            const retryAt = outcome.retryAt ?? (delay ? stamp + delay + Math.max(-delay / 10, jitter) : nextNormalWeatherCheck(claim.key, stamp));
            region.status = 'retry'; region.nextAttemptAt = Math.max(stamp + 1000, retryAt, Date.parse(region.cache?.expiresAt) || 0);
            if (outcome.code === 'met_rate_limited') global.notBefore = Math.max(global.notBefore ?? 0, region.nextAttemptAt);
          }
        }
        return { region, global, result: true };
      }, true);
    },
    async releaseTransport(claim) {
      await atomic(claim.key, (_region, savedGlobal) => {
        if (savedGlobal?.leases?.[claim.key]?.token !== claim.leaseToken) return { result: false };
        const global = { ...savedGlobal, leases: { ...savedGlobal.leases } }; delete global.leases[claim.key];
        return { global, result: true };
      }, true);
    },
  };
}
export function createFirestoreRegionalWeatherStore({ firestore, now = Date.now }) {
  const collection = firestore.collection('serverWeatherRegionsV1');
  const globalRef = firestore.doc('serverWeatherControlV1/met');
  const store = createRegionalWeatherStore({ now,
    async read(key) { return (await collection.doc(key).get()).data() ?? null; },
    async readControl() { return (await globalRef.get()).data() ?? null; },
    async due(stamp) { return (await collection.where('nextAttemptAt', '>=', 0).where('nextAttemptAt', '<=', stamp).orderBy('nextAttemptAt').limit(32).get()).docs.map(doc => doc.id); },
    atomic(key, update, withGlobal = false) {
      return firestore.runTransaction(async transaction => {
        const ref = collection.doc(key);
        const [region, global] = withGlobal ? await transaction.getAll(ref, globalRef) : [await transaction.get(ref), null];
        const result = update(region.data() ?? null, global?.data() ?? null);
        if (Object.hasOwn(result, 'region')) transaction.set(ref, result.region);
        if (Object.hasOwn(result, 'global') && result.global) transaction.set(globalRef, result.global);
        return result.result;
      });
    },
  });
  return store;
}
