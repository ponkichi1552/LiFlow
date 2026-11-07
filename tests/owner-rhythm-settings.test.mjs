import './helpers/typescript-loader.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { createOwnerRhythmSettings } from '../src/features/settings/owner-rhythm-settings.ts';
import { createPrivatePlannerPreferenceStore } from '../src/features/sharing/private-planner/preference-store.ts';
import { privateCalendarSetupFixture } from './helpers/private-calendar-setup.mjs';

const local = { frequencyMode: 'balanced', restDays: [7], heavyDailyLimit: 1, normalDailyLimit: 2 };
const own = { timeZone: 'America/New_York', restDays: [1], loadLimits: { heavyDailyLimit: 3, normalDailyLimit: 4 },
  allowedBands: [{ weekday: 2, startMinute: 600, endMinute: 700 }] };
async function fixture(t, initialized = true) {
  const f = privateCalendarSetupFixture(t); const store = createPrivatePlannerPreferenceStore({ ownerUserId: f.userId, vault: f.vault,
    assertOwner: userId => { assert.equal(userId, f.state.currentUser); }, exclusive: f.exclusive });
  if (initialized) await store.save(0, own);
  const calls = []; let failLocal = false;
  const source = createOwnerRhythmSettings({ store, saved: await store.read(), local, timeZone: 'Asia/Tokyo', saveLocal: async (value, expected) => {
    calls.push({ value, expected }); if (failLocal) throw new Error('local failed');
  } });
  return { f, store, source, calls, failLocal: value => { failLocal = value; } };
}
test('ordinary settings and shared recommendations use the same saved private rhythm while preserving region and legacy bands', async t => {
  const h = await fixture(t); assert.deepEqual(h.source.settings(), { ...local, restDays: [1], heavyDailyLimit: 3, normalDailyLimit: 4 });
  const next = { ...local, restDays: [6], heavyDailyLimit: 2, normalDailyLimit: 5 }; await h.source.save(next);
  const saved = await h.store.read(); assert.deepEqual(saved.restDays, [6]); assert.equal(saved.timeZone, own.timeZone);
  assert.deepEqual(saved.allowedBands, own.allowedBands); assert.deepEqual(h.calls[0], { value: next, expected: local });
  assert.deepEqual(h.source.settings(), next);
});
test('ordinary settings retries a partial durable save without consuming another protected revision', async t => {
  const h = await fixture(t); h.failLocal(true); const next = { ...local, heavyDailyLimit: 4 };
  await assert.rejects(h.source.save(next), /local failed/u); const saved = await h.store.read(); assert.equal(saved.revision, 2);
  h.failLocal(false); await h.source.save(next); assert.equal((await h.store.read()).revision, 2); assert.deepEqual(h.source.settings(), next);
});

test('queued rhythm saves capture the requested value before async waits and keep protected and SQLite values identical', async t => {
  const h = await fixture(t); let start; let release;
  const started = new Promise(resolve => { start = resolve; }); const waiting = new Promise(resolve => { release = resolve; });
  const prepare = h.store.prepareLocalProjection;
  h.store.prepareLocalProjection = async value => { await prepare(value); start(); await waiting; };
  const next = { ...local, restDays: [6], heavyDailyLimit: 4 }; const original = structuredClone(next);
  const saving = h.source.save(next); await started;
  next.restDays.push(2); next.heavyDailyLimit = 9; release(); await saving;
  assert.deepEqual(h.calls[0].value, original, 'a changed caller object must never alter the accepted SQLite publication');
  assert.deepEqual((await h.store.read()).restDays, original.restDays);
  assert.equal((await h.store.read()).loadLimits.heavyDailyLimit, original.heavyDailyLimit);
  const requested = { ...local, restDays: [5], heavyDailyLimit: 2 }; const accepted = structuredClone(requested);
  const queued = h.source.save(requested); requested.restDays.push(1); requested.normalDailyLimit = 19;
  await queued; assert.deepEqual(h.calls[1].value, accepted, 'serialization must retain the value at the original gesture');
});

test('reading rhythm settings returns independent arrays rather than mutable protected baselines', async t => {
  const h = await fixture(t); const first = h.source.settings(); first.restDays.push(5);
  assert.deepEqual(h.source.settings().restDays, [1]);
  assert.deepEqual((await h.store.read()).restDays, [1]);
});
test('a newer rhythm edit after a partial save uses the accepted protected revision and retains the SQLite baseline', async t => {
  const h = await fixture(t); h.failLocal(true); await assert.rejects(h.source.save({ ...local, heavyDailyLimit: 4 }));
  h.failLocal(false); const newer = { ...local, heavyDailyLimit: 5 }; await h.source.save(newer);
  assert.equal((await h.store.read()).revision, 3); assert.equal((await h.store.read()).loadLimits.heavyDailyLimit, 5);
  assert.deepEqual(h.calls[1], { value: { ...local, heavyDailyLimit: 4 }, expected: local }, 'recover the exact pending publication before replacing it');
  assert.deepEqual(h.calls[2], { value: newer, expected: { ...local, heavyDailyLimit: 4 } });
});
test('ordinary settings cannot overwrite a concurrent private edit or a different authenticated account', async t => {
  const h = await fixture(t); await h.store.save(1, { ...own, restDays: [2] });
  await assert.rejects(h.source.save({ ...local, restDays: [3] }), /別の操作/u); assert.equal(h.calls.length, 0);
  assert.deepEqual((await h.store.read()).restDays, [2]); h.f.state.currentUser = 'other'; await assert.rejects(h.source.save(local)); assert.equal(h.calls.length, 0);
});
test('opening ordinary settings does not create a private profile or any permitted time bands', async t => {
  const h = await fixture(t, false); assert.equal(await h.store.read(), null); assert.deepEqual(h.source.settings(), local);
  assert.equal(h.calls.length, 0); await h.source.save({ ...local, heavyDailyLimit: 2 });
  assert.deepEqual((await h.store.read()).allowedBands, []);
});

test('a partial rhythm save resumes after editor recreation without replaying a protected revision or hiding the pending local apply', async t => {
  const h = await fixture(t); const next = { ...local, restDays: [6], heavyDailyLimit: 4 };
  h.failLocal(true); await assert.rejects(h.source.save(next));
  assert.deepEqual((await h.store.readLocalProjection()).value, next);
  let applied;
  const recreated = createOwnerRhythmSettings({ store: h.store, saved: await h.store.read(), local, timeZone: 'UTC',
    saveLocal: async (value, expected) => { assert.deepEqual(expected, local); applied = value; } });
  await recreated.resume(); assert.deepEqual(applied, next); assert.deepEqual(recreated.settings(), next);
  assert.equal((await h.store.read()).revision, 2); assert.equal(await h.store.readLocalProjection(), null);
});

test('a pending rhythm projection cannot overwrite a newer protected edit or cross into another account', async t => {
  const h = await fixture(t); h.failLocal(true); await assert.rejects(h.source.save({ ...local, heavyDailyLimit: 4 }));
  await h.store.save(2, { ...own, restDays: [3] });
  let writes = 0;
  const recreated = createOwnerRhythmSettings({ store: h.store, saved: await h.store.read(), local, timeZone: 'UTC', saveLocal: async () => { writes++; } });
  await assert.rejects(recreated.resume(), /別の操作/); assert.equal(writes, 0); assert.ok(await h.store.readLocalProjection());
  h.f.state.currentUser = 'other'; await assert.rejects(recreated.resume()); assert.equal(writes, 0);
});

test('the real SQLite rhythm compare-and-set rejects a stale partial projection and accepts only its exact already-applied value', async t => {
  const repository = await import('../src/platform/storage/repository.ts');
  const { createDatabase } = await import('./helpers/sqlite.mjs');
  const d = createDatabase(); t.after(() => d.connection.close()); await repository.initializeLocalDatabase(d.database);
  let before = (await repository.loadPlannerSnapshot(d.database, '2026-11-04')).settings;
  const expected = { frequencyMode: before.frequencyMode, restDays: before.restDays, heavyDailyLimit: before.heavyDailyLimit, normalDailyLimit: before.normalDailyLimit };
  const accepted = { ...expected, heavyDailyLimit: 3 }; const stale = { ...expected, heavyDailyLimit: 4 };
  await repository.updatePlannerSettings(d.database, accepted, expected);
  await assert.rejects(repository.updatePlannerSettings(d.database, stale, expected), /別の操作/);
  assert.equal((await repository.loadPlannerSnapshot(d.database, '2026-11-04')).settings.heavyDailyLimit, 3);
  await repository.updatePlannerSettings(d.database, accepted, expected);
  assert.equal((await repository.loadPlannerSnapshot(d.database, '2026-11-04')).settings.heavyDailyLimit, 3);
});

test('a newer rhythm change recovers an already-applied SQLite write whose acknowledgement was lost before replacing its projection',async t=>{
  const h=await fixture(t);let actual=structuredClone(local);let lose=true;
  const source=createOwnerRhythmSettings({store:h.store,saved:await h.store.read(),local,timeZone:'Asia/Tokyo',saveLocal:async(value,expected)=>{
    if(JSON.stringify(actual)!==JSON.stringify(expected)&&JSON.stringify(actual)!==JSON.stringify(value))throw new Error('SQLite compare and set conflict');
    actual=structuredClone(value);if(lose){lose=false;throw new Error('SQLite acknowledgement lost');}
  }});
  const first={...local,heavyDailyLimit:4};await assert.rejects(source.save(first),/acknowledgement lost/);
  const next={...local,heavyDailyLimit:5};await source.save(next);
  assert.deepEqual(actual,next);assert.deepEqual(source.settings(),next);assert.equal(await h.store.readLocalProjection(),null);
  assert.equal((await h.store.read()).loadLimits.heavyDailyLimit,5);
});
