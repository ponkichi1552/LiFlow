import './helpers/typescript-loader.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { privatePlannerSyncFixture, privatePreferenceInput as input } from './helpers/private-planner-sync.mjs';
import { privateCalendarSetupFixture } from './helpers/private-calendar-setup.mjs';
import { createPrivatePlannerPreferenceStore } from '../src/features/sharing/private-planner/preference-store.ts';
import { sealPrivatePreferences, openPrivatePreferences, privatePreferenceCursor, verifyEncryptedPrivatePreferences } from '../src/features/sharing/private-planner/preference-crypto.ts';
import { preferenceValues } from '../src/features/sharing/private-planner/preference-sync-state.ts';
import { sharingTestCrypto as crypto } from './helpers/sharing-crypto.mjs';
import { signSharedDocument } from '../src/features/sharing/crypto.ts';
import { advancePrivateCalendarAuthority } from '../src/features/sharing/private-calendar/authority.ts';
import { createPrivatePreferenceSync } from '../src/features/sharing/private-planner/preference-sync.ts';

test('private preference wire authenticates both approved authors with domain separated encryption and no caller key mutation', async t => {
  const h = await privatePlannerSyncFixture(t); const before = h.key.slice();
  for (const author of [h.author, h.recipient]) {
    const sealed = await sealPrivatePreferences(crypto, { preferences: input(), authority: h.authority, author, accountKey: h.key, parent: null });
    assert.deepEqual(await openPrivatePreferences(crypto, sealed, h.authority, h.key), input()); assert.deepEqual(h.key, before);
    for (const raw of ['Asia/Tokyo', 'allowedBands', h.author.signingSecretKey, Buffer.from(h.key).toString('hex')]) assert.equal(JSON.stringify(sealed).includes(raw), false);
  }
});
test('private preference wire rejects tampering substitution unknown metadata and signed but unauthentic ciphertext', async t => {
  const h = await privatePlannerSyncFixture(t); const sealed = await sealPrivatePreferences(crypto, { preferences: input(), authority: h.authority, author: h.author, accountKey: h.key, parent: null });
  for (const patch of [{ ownerUserId: 'another-owner' }, { suite: 'calendar-cache' }, { authorDeviceId: 'unapproved' }, { revision: 2 },
    { accountGeneration: '0'.repeat(64) }, { rootDigest: '0'.repeat(64) }, { keyVersion: 2 }, { nonce: '0'.repeat(24) }, { accessToken: 'forbidden' }]) {
    await assert.rejects(() => openPrivatePreferences(crypto, { ...sealed, body: { ...sealed.body, ...patch } }, h.authority, h.key));
  }
  const body = { ...sealed.body, encryptedPayload: '0'.repeat(sealed.body.encryptedPayload.length) };
  const forged = { body, signature: signSharedDocument(body, h.author) }; verifyEncryptedPrivatePreferences(forged, h.authority);
  await assert.rejects(() => openPrivatePreferences(crypto, forged, h.authority, h.key));
  await assert.rejects(() => sealPrivatePreferences(crypto, { preferences: { ...input(), googleTaskId: 'forbidden' }, authority: h.authority, author: h.author, accountKey: h.key, parent: null }));
});
test('private preference synchronization transfers both ways using separate protected stores and no group or Calendar payload', async t => {
  const h = await privatePlannerSyncFixture(t); await h.left.store.save(0, input()); assert.equal((await h.left.sync.synchronize()).kind, 'sent');
  assert.equal((await h.right.sync.synchronize()).kind, 'received'); assert.deepEqual(preferenceValues(await h.right.store.read()), input());
  await h.right.store.save(1, { ...input(), restDays: [3] }); await h.right.sync.synchronize(); await h.left.sync.synchronize();
  assert.deepEqual(preferenceValues(await h.left.store.read()), { ...input(), restDays: [3] }); assert.equal(h.wire.writes, 2);
  for (const side of [h.left, h.right]) {
    const sql = side.f.connection.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(row => row.name);
    assert.deepEqual(sql, ['private_calendar_scope']); assert.equal(side.f.connection.prepare('PRAGMA quick_check').get().quick_check, 'ok');
    assert.equal(JSON.stringify(side.f.writes).includes('Asia/Tokyo'), false);
  }
});
test('private preference old local-only storage migrates without a write on read or changes to its public local revision', async t => {
  const f = privateCalendarSetupFixture(t); const key = `private-planner-preferences:${f.userId}`;
  const saved = { schemaVersion: 1, ownerUserId: f.userId, revision: 9, ...input() }; await f.vault.setItem(key, JSON.stringify(saved)); const before = [...f.values];
  const store = createPrivatePlannerPreferenceStore({ ownerUserId: f.userId, vault: f.vault, exclusive: f.exclusive, assertOwner: () => {} });
  assert.deepEqual(await store.read(), saved); assert.deepEqual([...f.values], before); assert.equal((await store.readSyncState()).baseline, null);
  assert.deepEqual(await store.save(9, input()), saved); assert.deepEqual([...f.values], before);
});
test('private preference simultaneous offline edits remain as two protected candidates until explicit resolution and then converge', async t => {
  const h = await privatePlannerSyncFixture(t); await h.left.store.save(0, input()); await h.left.sync.synchronize(); await h.right.sync.synchronize();
  await h.left.store.save(1, { ...input(), restDays: [1] }); await h.right.store.save(1, { ...input(), restDays: [2] }); await h.left.sync.synchronize();
  assert.equal((await h.right.sync.synchronize()).kind, 'conflict'); let view = await h.right.sync.readStatus();
  assert.deepEqual(view.local.restDays, [2]); assert.deepEqual(view.review.preferences.restDays, [1]); assert.equal(h.wire.writes, 2);
  await h.right.sync.resolve(view.local.revision, view.review.cursor, 'local'); await h.right.sync.synchronize(); await h.left.sync.synchronize();
  assert.deepEqual((await h.left.store.read()).restDays, [2]); assert.deepEqual((await h.right.store.read()).restDays, [2]); assert.equal(h.wire.writes, 3);
  await h.left.store.save(3, { ...input(), restDays: [4] }); await h.right.store.save(2, { ...input(), restDays: [5] }); await h.right.sync.synchronize();
  await h.left.sync.synchronize(); view = await h.left.sync.readStatus(); assert.equal(view.kind, 'conflict');
  await h.left.sync.resolve(view.local.revision, view.review.cursor, 'remote'); await h.left.sync.synchronize(); assert.deepEqual((await h.left.store.read()).restDays, [5]); assert.equal(h.wire.writes, 4);
});
test('private preference same concurrent values converge without a redundant write and stale conflict decisions are rejected', async t => {
  const h = await privatePlannerSyncFixture(t); await h.left.store.save(0, input()); await h.right.store.save(0, input());
  await Promise.all([h.left.sync.synchronize(), h.right.sync.synchronize()]); await h.left.sync.synchronize(); await h.right.sync.synchronize(); assert.equal(h.wire.writes, 1);
  await h.left.store.save(1, { ...input(), restDays: [1] }); await h.right.store.save(1, { ...input(), restDays: [2] }); await h.left.sync.synchronize(); await h.right.sync.synchronize();
  const stale = await h.right.sync.readStatus(); await h.left.store.save(2, { ...input(), restDays: [3] }); await h.left.sync.synchronize(); await h.right.sync.synchronize();
  await assert.rejects(() => h.right.sync.resolve(stale.local.revision, stale.review.cursor, 'remote'), /更新/u);
  assert.deepEqual((await h.right.store.read()).restDays, [2]); assert.deepEqual((await h.right.sync.readStatus()).review.preferences.restDays, [3]);
});
test('private preference lost upload reply survives service reconstruction without resealing or increasing the accepted revision', async t => {
  const h = await privatePlannerSyncFixture(t); await h.left.store.save(0, input()); h.wire.lostReply = true;
  await assert.rejects(() => h.left.sync.synchronize(), /lost reply/u); const pending = (await h.left.store.readSyncState()).pending;
  assert.equal(h.wire.writes, 1); assert.ok(pending); const rebuilt = h.service(h.left.f); await rebuilt.sync.synchronize(true);
  assert.equal((await rebuilt.store.readSyncState()).pending, null); assert.equal(h.wire.writes, 1); assert.equal(privatePreferenceCursor(h.wire.current).digest, privatePreferenceCursor(pending.encrypted).digest);
});
test('private preference a newer local edit during an in-flight upload is retained and subsequently sent as a child', async t => {
  const h = await privatePlannerSyncFixture(t); await h.left.store.save(0, input());
  h.wire.beforePublish = async () => { h.wire.beforePublish = null; await h.left.store.save(1, { ...input(), restDays: [3] }); };
  await h.left.sync.synchronize(); let state = await h.left.store.readSyncState(); assert.deepEqual(state.local.restDays, [3]); assert.deepEqual(state.baseline.preferences.restDays, [6, 7]);
  await h.left.sync.synchronize(); await h.right.sync.synchronize(); assert.deepEqual((await h.right.store.read()).restDays, [3]); assert.equal(h.wire.writes, 2);
});
test('private preference rejected uploads retain exact ciphertext and durable backoff across recreation and retry after the boundary', async t => {
  const h = await privatePlannerSyncFixture(t); await h.left.store.save(0, input()); h.wire.beforePublish = async () => { h.wire.unavailable = true; };
  await assert.rejects(() => h.left.sync.synchronize(), /offline/u); let saved = await h.left.store.readSyncState(); const encrypted = structuredClone(saved.pending.encrypted);
  assert.equal(saved.retry.nextAt, h.wire.now + 30_000); h.wire.unavailable = false; h.wire.beforePublish = null;
  const resumed = h.service(h.left.f); assert.equal((await resumed.sync.synchronize()).kind, 'waiting'); h.wire.now += 30_000;
  await resumed.sync.synchronize(); assert.deepEqual(h.wire.current, encrypted); assert.equal(h.wire.writes, 1); assert.equal((await resumed.store.readSyncState()).retry, null);
});
test('private preference signed older heads and missing acknowledged heads never reset the protected baseline', async t => {
  const h = await privatePlannerSyncFixture(t); await h.left.store.save(0, input()); await h.left.sync.synchronize(); const old = structuredClone(h.wire.current);
  await h.left.store.save(1, { ...input(), restDays: [3] }); await h.left.sync.synchronize(); const before = await h.left.store.readSyncState();
  h.wire.current = old; await assert.rejects(() => h.left.sync.synchronize(), /古い/u); assert.deepEqual(await h.left.store.readSyncState(), before);
  h.wire.current = null; await assert.rejects(() => h.left.sync.synchronize(), /失われ/u); assert.deepEqual(await h.left.store.readSyncState(), before);
});
test('private preference authority rotation republishes only a protected baseline and never permits the removed device to publish', async t => {
  const h = await privatePlannerSyncFixture(t); await h.left.store.save(0, input()); await h.left.sync.synchronize(); await h.right.sync.synchronize();
  const old = structuredClone(h.wire.current); const next = advancePrivateCalendarAuthority(h.authority, { mainDeviceId: h.author.deviceId, devices: [h.author], keyVersion: 2 }, h.author);
  await h.left.f.secrets.acceptAuthorityUpdate(h.ownerUserId, next.signed); (await h.left.f.secrets.createCurrentKey(h.ownerUserId, next)).fill(0); h.wire.authority = next;
  await h.right.f.secrets.acceptAuthorityUpdate(h.ownerUserId, next.signed); assert.equal((await h.right.sync.synchronize()).kind, 'unavailable');
  assert.equal((await h.left.sync.synchronize()).kind, 'sent'); assert.equal(h.wire.current.body.keyVersion, 2); assert.equal(h.wire.current.body.parent.digest, privatePreferenceCursor(old).digest);
  assert.deepEqual(preferenceValues(await h.left.store.read()), input()); assert.equal((await h.left.store.read()).revision, 1);
});
test('private preference owner changes and cancelled budgets during reads cannot apply remote plaintext or enqueue another write', async t => {
  const h = await privatePlannerSyncFixture(t); await h.left.store.save(0, input()); await h.left.sync.synchronize();
  h.wire.beforeRead = async () => { h.right.f.state.currentUser = 'another-person'; };
  await assert.rejects(() => h.right.sync.synchronize(), /owner changed/u); h.right.f.state.currentUser = h.ownerUserId; assert.equal(await h.right.store.read(), null);
  let cancelled = false; h.wire.beforeRead = async () => { cancelled = true; };
  await assert.rejects(() => h.right.sync.synchronize(false, () => { if (cancelled) throw new Error('budget expired'); }), /budget expired/u);
  assert.equal(await h.right.store.read(), null); assert.equal(h.wire.writes, 1);
});
test('private preference unapproved local settings never create identity keys approval Google consent or Cloud requests', async t => {
  const f = privateCalendarSetupFixture(t); const store = createPrivatePlannerPreferenceStore({ ownerUserId: f.userId, vault: f.vault, exclusive: f.exclusive, assertOwner: () => {} });
  await store.save(0, input()); let reads = 0;
  const sync = createPrivatePreferenceSync({ ownerUserId: f.userId, store, secrets: f.secrets, crypto, assertOwner: () => {},
    cloud: { read: async () => { reads++; throw new Error('must not request Cloud'); } } });
  assert.equal((await sync.synchronize()).kind, 'unavailable'); assert.equal((await sync.readStatus()).configured, false);
  assert.equal(reads, 0); assert.equal(f.state.generations, 0); assert.equal(await f.secrets.publicState(f.userId), null);
});
test('private preference one hundred requests coalesce and separate runtimes reuse the same protected ciphertext', async t => {
  const h = await privatePlannerSyncFixture(t); await h.left.store.save(0, input());
  const requests = Array.from({ length: 100 }, () => h.left.sync.synchronize()); assert.equal(new Set(requests).size, 1);
  await Promise.all(requests); assert.equal(h.wire.reads, 1); assert.equal(h.wire.writes, 1);
  await h.left.store.save(1, { ...input(), restDays: [2] }); const other = h.service(h.left.f);
  await Promise.all([h.left.sync.synchronize(), other.sync.synchronize()]); assert.equal(h.wire.writes, 2);
  assert.equal((await h.left.store.readSyncState()).pending, null);
});
test('private preference failed initial reads retain durable backoff before encryption and recover after a backward device clock change', async t => {
  const h = await privatePlannerSyncFixture(t); await h.left.store.save(0, input()); h.wire.unavailable = true;
  await assert.rejects(() => h.left.sync.synchronize(), /offline/u); const before = await h.left.store.readSyncState();
  assert.equal(before.pending, null); assert.equal(before.retry.digest, null); assert.equal(before.retry.nextAt, h.wire.now + 30_000);
  h.wire.unavailable = false; const restored = h.service(h.left.f); assert.equal((await restored.sync.synchronize()).kind, 'waiting');
  h.wire.now -= 60_000; assert.equal((await restored.sync.synchronize()).kind, 'sent'); assert.equal(h.wire.writes, 1);
});
test('private preference a delayed encryption result cannot replace a newer local value or enqueue an obsolete envelope', async t => {
  const h = await privatePlannerSyncFixture(t); await h.left.store.save(0, input()); let changed = false;
  const delayed = h.service(h.left.f, { crypto: { ...crypto, async encrypt(...args) {
    if (!changed) { changed = true; await h.left.store.save(1, { ...input(), restDays: [4] }); } return crypto.encrypt(...args);
  } } });
  assert.equal((await delayed.sync.synchronize()).kind, 'changed'); assert.equal(h.wire.writes, 0); assert.equal((await h.left.store.readSyncState()).pending, null);
  await delayed.sync.synchronize(); assert.deepEqual((await openPrivatePreferences(crypto, h.wire.current, h.authority, h.key)).restDays, [4]);
});
test('private preference a successful unchanged read clears fetch backoff without retaining an artificial delivery failure', async t => {
  const h = await privatePlannerSyncFixture(t); await h.left.store.save(0, input()); await h.left.sync.synchronize(); h.wire.unavailable = true;
  await assert.rejects(() => h.left.sync.synchronize(), /offline/u); assert.equal((await h.left.store.readSyncState()).retry.count, 1);
  h.wire.unavailable = false; await h.left.sync.synchronize(true); assert.equal((await h.left.store.readSyncState()).retry, null); assert.equal(h.wire.writes, 1);
});
test('private preference synchronization rejects a foreign bound store before rendering values resolving conflicts or encrypting them', async t => {
  const h = await privatePlannerSyncFixture(t); const foreign = privateCalendarSetupFixture(t, { userId: 'foreign-private-owner' });
  const store = createPrivatePlannerPreferenceStore({ ownerUserId: foreign.userId, vault: foreign.vault, exclusive: foreign.exclusive, assertOwner: () => {} });
  await store.save(0, input()); const wrong = h.service(h.left.f, { store }).sync;
  await assert.rejects(() => wrong.readStatus(), /本人設定の保存先/u); await assert.rejects(() => wrong.synchronize(), /本人設定の保存先/u);
  await assert.rejects(() => wrong.resolve(1, { revision: 1, digest: '0'.repeat(64) }, 'remote'), /本人設定の保存先/u);
  assert.equal(h.wire.reads, 0); assert.equal(h.wire.writes, 0); assert.equal((await store.read()).revision, 1);
});

test('audit100 private preference transport receives the caller budget so late transaction stages cannot begin', async t => {
  const h = await privatePlannerSyncFixture(t); await h.left.store.save(0, input()); let allowed = true; const guards = [];
  const service = h.service(h.left.f, { cloud: { ...h.cloud, async read(authority, guard) {
    guards.push(guard); allowed = false; guard?.(); return h.cloud.read(authority);
  } } });
  await assert.rejects(service.sync.synchronize(false, () => { if (!allowed) throw new Error('expired budget'); }), /expired budget/);
  assert.equal(typeof guards[0], 'function'); assert.equal(h.wire.writes, 0);
});
test('audit100 repeated private preference polls reuse only an exactly authenticated protected baseline', async t => {
  const h = await privatePlannerSyncFixture(t); await h.left.store.save(0, input()); await h.left.sync.synchronize();
  let decryptions = 0; const service = h.service(h.right.f, { crypto: { ...crypto, async decrypt(...args) { decryptions++; return crypto.decrypt(...args); } } });
  await service.sync.synchronize(); assert.equal(decryptions, 1);
  for (let i = 0; i < 20; i++) await service.sync.synchronize();
  assert.equal(decryptions, 1);
  h.wire.current.signature = '0'.repeat(128);
  await assert.rejects(service.sync.synchronize()); assert.equal(decryptions, 1);
});
test('audit100 a manual private preference retry is not swallowed by an automatic backoff read', async t => {
  const h = await privatePlannerSyncFixture(t); await h.left.store.save(0, input()); h.wire.unavailable = true;
  await assert.rejects(h.left.sync.synchronize()); h.wire.unavailable = false;
  const automatic = h.left.sync.synchronize(); const manual = h.left.sync.synchronize(true);
  assert.equal((await automatic).kind, 'waiting'); assert.equal((await manual).kind, 'sent'); assert.equal(h.wire.writes, 1);
});
