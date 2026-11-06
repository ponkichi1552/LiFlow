import assert from 'node:assert/strict';
import { before, beforeEach, after, test } from 'node:test';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { initializeTestEnvironment, assertFails } from '@firebase/rules-unit-testing';
import { doc, getDocFromServer, setDoc } from 'firebase/firestore';
import { createFirestoreRegionalWeatherStore, weatherRegion, weatherRegionKey } from '../server/appliance-care-api/src/weather/regional-store.mjs';
import { createMetWeatherService } from '../server/appliance-care-api/src/weather/met-service.mjs';
import { parseMetForecast } from '../server/appliance-care-api/src/weather/forecast.mjs';
if (!/^127\.0\.0\.1:\d+$/u.test(process.env.FIRESTORE_EMULATOR_HOST ?? '')) throw new Error('Isolated local Firestore emulator required');
const serverRequire = createRequire(new URL('../server/appliance-care-api/package.json', import.meta.url));
const { initializeApp, deleteApp } = serverRequire('firebase-admin/app');
const { getFirestore } = serverRequire('firebase-admin/firestore');
const projectId = 'demo-liflow-sharing'; let env; let app; let firestore;
const now = Date.parse('2026-11-05T03:00:00Z'); const id = 'jp-municipal.13104';
const makeCache = stamp => ({ fetchedAt: new Date(stamp).toISOString(), checkedAt: new Date(stamp).toISOString(), expiresAt: null, lastModified: null,
  body: { synthetic: 'public weather' }, forecast: parseMetForecast({ properties: { meta: { updated_at: new Date(stamp).toISOString() },
    timeseries: [{ time: new Date(stamp).toISOString(), data: { next_1_hours: { summary: { symbol_code: 'clearsky_day' }, details: { precipitation_amount: 0 } } } }] } }) });
before(async () => {
  env = await initializeTestEnvironment({ projectId, firestore: { rules: readFileSync(new URL('../firestore.rules', import.meta.url), 'utf8') } });
  app = initializeApp({ projectId }, 'met-regional-cache-integration'); firestore = getFirestore(app);
});
beforeEach(async () => env.clearFirestore());
after(async () => { await firestore?.terminate(); if (app) await deleteApp(app); await env?.cleanup(); });
test('real Firestore coalesces a first regional weather reference across clients and preserves the cache across worker restart', async () => {
  let stamp = now; const stores = Array.from({ length: 4 }, () => createFirestoreRegionalWeatherStore({ firestore, now: () => stamp }));
  await Promise.all(Array.from({ length: 32 }, (_, index) => stores[index % stores.length].reference(id)));
  assert.equal((await firestore.collection('serverWeatherRegionsV1').get()).size, 1);
  const claims = (await Promise.all(stores.map(store => store.claim()))).filter(Boolean); assert.equal(claims.length, 1);
  assert.equal(await stores[2].finish(claims[0], { cache: makeCache(stamp) }), true);
  stamp += 1000;
  const restarted = createFirestoreRegionalWeatherStore({ firestore, now: () => stamp }); const value = await restarted.reference(id);
  assert.equal(value.cache.forecast.intervals[0].precipitationMm, 0); assert.equal(value.cache.body.synthetic, 'public weather');
  assert.equal(await restarted.claim(), null); assert.equal((await firestore.doc('serverWeatherControlV1/met').get()).data().leases[value.key], undefined);
});
test('real Firestore enforces one global two-starts-per-second four-lease budget for independent weather workers', async () => {
  let stamp = now; const stores = Array.from({ length: 8 }, () => createFirestoreRegionalWeatherStore({ firestore, now: () => stamp }));
  for (const key of ['13101', '13102', '13103', '13104', '13105', '13106']) await stores[0].reference(`jp-municipal.${key}`);
  const first = (await Promise.all(stores.map(store => store.claim()))).filter(Boolean); assert.equal(first.length, 2);
  stamp += 1000; const next = (await Promise.all(stores.map(store => store.claim()))).filter(Boolean); assert.equal(next.length, 2);
  stamp += 1000; assert.ok((await Promise.all(stores.map(store => store.claim()))).every(value => value === null));
  assert.equal(Object.keys((await firestore.doc('serverWeatherControlV1/met').get()).data().leases).length, 4);
  await Promise.all([...first, ...next].map((claim, index) => stores[index].finish(claim, { code: 'met_unavailable' })));
  const control = (await firestore.doc('serverWeatherControlV1/met').get()).data(); assert.equal(Object.keys(control.leases).length, 0);
  const later = await stores[0].claim(); assert.ok(later); assert.ok([...first, ...next].every(claim => claim.key !== later.key));
});
test('real Firestore rejects stale weather worker results after lease takeover and suspends unreferenced regions without starving new work', async () => {
  let stamp = now; const a = createFirestoreRegionalWeatherStore({ firestore, now: () => stamp }); const b = createFirestoreRegionalWeatherStore({ firestore, now: () => stamp });
  await a.reference(id); const old = await a.claim(); stamp += 61_000; const fresh = await b.claim(); assert.ok(fresh); assert.notEqual(fresh.leaseToken, old.leaseToken);
  assert.equal(await b.finish(fresh, { cache: makeCache(stamp) }), true); assert.equal(await a.finish(old, { cache: makeCache(now) }), false);
  assert.equal((await a.reference(id)).cache.fetchedAt, new Date(stamp).toISOString());
  stamp += 8 * 86400_000; assert.equal(await a.claim(), null);
  assert.equal((await firestore.doc(`serverWeatherRegionsV1/${weatherRegionKey(weatherRegion(id))}`).get()).data().status, 'inactive');
  await a.reference('jp-municipal.13101'); assert.equal((await a.claim()).region.id, 'jp-municipal.13101');
});
test('weather service cannot leak or alter its server-only cache or global budget through any mobile Firebase authentication', async () => {
  const store = createFirestoreRegionalWeatherStore({ firestore, now: () => now }); await store.reference(id);
  const claim = await store.claim(); await store.finish(claim, { cache: makeCache(now) });
  for (const user of [null, 'member-a', 'member-b']) {
    const db = user ? env.authenticatedContext(user).firestore() : env.unauthenticatedContext().firestore();
    for (const path of [`serverWeatherRegionsV1/${claim.key}`, 'serverWeatherControlV1/met']) {
      await assertFails(getDocFromServer(doc(db, path))); await assertFails(setDoc(doc(db, path), { nextAttemptAt: 0, halted: false }));
    }
  }
  const service = createMetWeatherService({ store, now: () => now, userAgent: 'LiFlow/unit-test https://weather.liflow.app/contact', fetcher: async () => { throw new Error('No external request in Cloud tests'); } });
  const payload = (await service.read(id)).value; assert.equal(payload.regionId, id); assert.equal(payload.body, undefined); assert.equal(payload.leaseToken, undefined);
  assert.equal(payload.nextAttemptAt, undefined); assert.equal(payload.forecast.intervals[0].precipitationMm, 0);
});
