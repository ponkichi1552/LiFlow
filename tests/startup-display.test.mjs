import './helpers/typescript-loader.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { sharingTestCrypto as crypto } from './helpers/sharing-crypto.mjs';
import { createStartupDisplayCache } from '../src/features/planner/startup-display.ts';
import { createRestoringSessionGate, restoringDisplaySession } from '../src/features/planner/restoring-session.ts';

async function fixture() {
  let now = new Date('2026-10-31T10:00:00Z'); const values = new Map(); const key = await crypto.randomBytes(32);
  const record = { userId: 'owner', groupId: 'house', status: 'active', anchor: { groupId: 'house' }, rosterArchive: [], localGeneration: 'first' };
  const model = { viewerUserId: 'owner', plan: { groupId: 'house', timeZone: 'Asia/Tokyo', range: { asOfDate: '2026-10-31' } },
    privateOverlay: { status: 'ready', ownerUserId: 'owner', timeZone: 'Asia/Tokyo', today: '2026-10-31', byDate: new Map([['2026-10-31', [{ key: 'private', completed: true }]]]), counts: new Map([['2026-10-31', 0]]) } };
  const dependencies = { crypto, now: () => now, key: async () => key,
    read: async (user, group) => values.get(`${user}:${group}`) ?? null,
    write: async (user, group, value) => values.set(`${user}:${group}`, value) };
  return { record, model, values, key, cache: createStartupDisplayCache(dependencies), dependencies, setNow: value => { now = new Date(value); } };
}
test('a restarted home restores authenticated encrypted presentation including personal maps without storing planner plaintext', async () => {
  const f = await fixture(); await f.cache.write(f.record, f.model);
  const raw = f.values.get('owner:house'); assert.equal(raw.includes('private'), false); assert.equal(raw.includes('completed'), false);
  const restored = await createStartupDisplayCache(f.dependencies).read(f.record);
  assert.deepEqual(restored, f.model); assert.ok(restored.privateOverlay.byDate instanceof Map);
  assert.equal(restored.privateOverlay.counts.get('2026-10-31'), 0);
});
test('saved home rejects changed ciphertext keys account membership generation or signed roster before display', async () => {
  const f = await fixture(); await f.cache.write(f.record, f.model); const raw = f.values.get('owner:house');
  const bad = JSON.parse(raw); bad.ciphertext = `${bad.ciphertext.startsWith('00') ? 'ff' : '00'}${bad.ciphertext.slice(2)}`;
  f.values.set('owner:house', JSON.stringify(bad)); assert.equal(await f.cache.read(f.record), undefined); f.values.set('owner:house', raw);
  const wrongKey = createStartupDisplayCache({ ...f.dependencies, key: async () => new Uint8Array(32) });
  assert.equal(await wrongKey.read(f.record), undefined);
  for (const change of [{ userId: 'other' }, { groupId: 'another' }, { localGeneration: 'rejoin' }, { status: 'removed' }, { status: 'left' }, { rosterArchive: [{ changed: true }] }]) {
    assert.equal(await f.cache.read({ ...f.record, ...change }), undefined);
  }
  const foreign = { ...f.model, privateOverlay: { ...f.model.privateOverlay, ownerUserId: 'another' } };
  const before = f.values.get('owner:house'); await f.cache.write(f.record, foreign); assert.equal(f.values.get('owner:house'), before);
});
test('saved home falls back to a fresh authenticated read on missing keys future dates expiry midnight and incomplete data', async () => {
  const f = await fixture(); assert.equal(await f.cache.read(f.record), undefined); await f.cache.write(f.record, f.model);
  const missingKey = createStartupDisplayCache({ ...f.dependencies, key: async () => null }); assert.equal(await missingKey.read(f.record), undefined);
  for (const value of ['2026-10-31T09:59:00Z', '2026-10-31T15:00:00Z', '2026-11-02T10:00:00Z']) { f.setNow(value); assert.equal(await f.cache.read(f.record), undefined); }
  f.setNow('2026-10-31T10:00:00Z'); f.values.set('owner:house', '{'); assert.equal(await f.cache.read(f.record), undefined);
});
test('saved home expires at the personal midnight even while the shared household is still on the same date', async () => {
  const f = await fixture(); const model = { ...f.model, plan: { ...f.model.plan, timeZone: 'UTC' } };
  await f.cache.write(f.record, model); assert.ok(await f.cache.read(f.record));
  f.setNow('2026-10-31T15:00:00Z'); assert.equal(await f.cache.read(f.record), undefined);
});
test('pressing a restored card cannot edit until the current authenticated session is bound and revoked sessions reject pending actions', async () => {
  const f = await fixture(); const gate = createRestoringSessionGate(); const calls = [];
  const display = restoringDisplaySession(f.model, gate.get);
  const action = display.controller.actions.claim('occurrence', 'subject');
  await Promise.resolve(); assert.deepEqual(calls, []);
  const live = { controller: { actions: { claim: async (...args) => { calls.push(args); return 'committed'; } } } };
  gate.bind(async () => live); assert.equal(await action, 'committed'); assert.deepEqual(calls, [['occurrence', 'subject']]);
  gate.close(); await assert.rejects(display.controller.actions.claim('other'), /変わりました/); assert.equal(calls.length, 1);
  const old = createRestoringSessionGate(); const pending = old.get(); old.close(); await assert.rejects(pending, /変わりました/);
  old.bind(async () => live); await assert.rejects(old.get(), /変わりました/);
});
test('a failed restoration rejects queued changes and can recover through a newly verified session without fabricating a successful write', async () => {
  const gate = createRestoringSessionGate(); const pending = gate.get(); gate.fail(new Error('signature rejected'));
  await assert.rejects(pending, /signature rejected/); await assert.rejects(gate.get(), /signature rejected/);
  const live = {}; gate.bind(async () => live); assert.equal(await gate.get(), live);
});
