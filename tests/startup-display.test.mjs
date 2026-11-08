import './helpers/typescript-loader.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { sharingTestCrypto as crypto } from './helpers/sharing-crypto.mjs';
import { createStartupDisplayCache } from '../src/features/planner/startup-display.ts';
import { createRestoringSessionGate, restoringDisplaySession } from '../src/features/planner/restoring-session.ts';
import { sharedDocumentDigest } from '../src/features/sharing/crypto.ts';

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
test('startup display refuses an authenticated pre-backlog plan instead of queueing a completion against its obsolete round target', async () => {
  const f = await fixture(); const scope = sharedDocumentDigest({ version: 1, userId: f.record.userId, groupId: f.record.groupId,
    historyRetention: null, generation: f.record.localGeneration, status: f.record.status, anchor: f.record.anchor, archive: f.record.rosterArchive });
  const nonce = await crypto.randomBytes(12);
  const legacy = { ...f.model, privateOverlay: undefined };
  const plaintext = new TextEncoder().encode(JSON.stringify({ savedAt: f.dependencies.now().getTime(), model: legacy }));
  const ciphertext = await crypto.encrypt(f.key, nonce, plaintext, new TextEncoder().encode(scope));
  const raw = JSON.stringify({ version: 1, scope, encoding: 'base64', nonce: Buffer.from(nonce).toString('base64'), ciphertext: Buffer.from(ciphertext).toString('base64') });
  f.values.set('owner:house', raw);
  assert.equal(await f.cache.read(f.record), undefined); assert.equal(f.values.get('owner:house'), raw, 'rejecting an old presentation never edits source data');
  await f.cache.write(f.record, f.model); assert.deepEqual(await f.cache.read(f.record), f.model);
});
test('compact encrypted display bytes retain older hex caches and reject malformed encodings without changing saved content', async () => {
  const f = await fixture(); await f.cache.write(f.record, f.model);
  const { toByteArray } = await import('base64-js'); const envelope = JSON.parse(f.values.get('owner:house'));
  assert.equal(envelope.encoding, 'base64');
  const original = JSON.stringify(f.model);
  const legacy = { ...envelope, nonce: Buffer.from(toByteArray(envelope.nonce)).toString('hex'), ciphertext: Buffer.from(toByteArray(envelope.ciphertext)).toString('hex') };
  delete legacy.encoding; f.values.set('owner:house', JSON.stringify(legacy)); assert.deepEqual(await f.cache.read(f.record), f.model);
  for (const patch of [{ encoding: 'unknown' }, { ciphertext: '*' }, { ciphertext: '====' }, { nonce: 'a'.repeat(100) }]) {
    f.values.set('owner:house', JSON.stringify({ ...envelope, ...patch })); assert.equal(await f.cache.read(f.record), undefined);
  }
  assert.equal(JSON.stringify(f.model), original);
});
test('native startup restoration passes validated base64 to the platform without decoding the full ciphertext on JavaScript', async () => {
  const f = await fixture(); await f.cache.write(f.record, f.model);
  const envelope = JSON.parse(f.values.get('owner:house')); const calls = [];
  const cache = createStartupDisplayCache({ ...f.dependencies,
    crypto: { ...crypto, decrypt: () => { throw new Error('Full JavaScript conversion should not be needed'); } },
    decryptBase64: async (key, nonce, ciphertext, aad) => {
      calls.push([nonce, ciphertext]);
      return crypto.decrypt(key, new Uint8Array(Buffer.from(nonce, 'base64')), new Uint8Array(Buffer.from(ciphertext, 'base64')), aad);
    },
  });
  assert.deepEqual(await cache.read(f.record), f.model);
  assert.deepEqual(calls, [[envelope.nonce, envelope.ciphertext]]);
  for (const patch of [{ nonce: 'AA==' }, { nonce: '*'.repeat(16) }, { ciphertext: 'AAAA' }, { ciphertext: 'a'.repeat(2800000) }, { encoding: 'unsupported' }]) {
    f.values.set('owner:house', JSON.stringify({ ...envelope, ...patch }));
    assert.equal(await cache.read(f.record), undefined);
  }
  assert.equal(calls.length, 1, 'invalid encodings and oversized data must be rejected before native work');
  f.values.set('owner:house', JSON.stringify({ ...envelope, ciphertext: `${envelope.ciphertext.startsWith('A') ? 'B' : 'A'}${envelope.ciphertext.slice(1)}` }));
  assert.equal(await cache.read(f.record), undefined, 'a well-formed but modified ciphertext still fails authentication');
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
test('saved presentation cannot restore or rewrite deleted shared audit history under a newer retention boundary', async () => {
  const f = await fixture(); await f.cache.write(f.record, f.model);
  const historyRetention = { cutoff: '2026-09-30', throughSequence: 12, digest: 'a'.repeat(64) };
  const record = { ...f.record, historyRetention }; assert.equal(await f.cache.read(record), undefined);
  const original = f.values.get('owner:house'); await f.cache.write(record, f.model); assert.equal(f.values.get('owner:house'), original);
  const model = { ...f.model, plan: { ...f.model.plan, historyRetention }, legacyHistory: [] };
  await f.cache.write(record, model); assert.deepEqual(await f.cache.read(record), model);
  const valid = f.values.get('owner:house'); await f.cache.write(record, { ...model, legacyHistory: [{ performer: 'old-private-history' }] });
  assert.equal(f.values.get('owner:house'), valid);
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
