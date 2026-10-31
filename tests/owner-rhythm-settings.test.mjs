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
test('a newer rhythm edit after a partial save uses the accepted protected revision and retains the SQLite baseline', async t => {
  const h = await fixture(t); h.failLocal(true); await assert.rejects(h.source.save({ ...local, heavyDailyLimit: 4 }));
  h.failLocal(false); const newer = { ...local, heavyDailyLimit: 5 }; await h.source.save(newer);
  assert.equal((await h.store.read()).revision, 3); assert.equal((await h.store.read()).loadLimits.heavyDailyLimit, 5);
  assert.deepEqual(h.calls[1], { value: newer, expected: local });
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
