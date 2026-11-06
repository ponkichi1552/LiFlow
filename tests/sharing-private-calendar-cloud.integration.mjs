import './helpers/typescript-loader.mjs';
import assert from 'node:assert/strict';
import { after, before, beforeEach, test } from 'node:test';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { initializeTestEnvironment } from '@firebase/rules-unit-testing';
import { collection, deleteDoc, doc, getDocFromServer, getDocsFromServer, serverTimestamp, setDoc, updateDoc, writeBatch } from 'firebase/firestore';
import { sharingTestCrypto as crypto } from './helpers/sharing-crypto.mjs';
import { createDeviceIdentity, sharedDocumentDigest } from '../src/features/sharing/crypto.ts';
import { canonicalJson } from '../src/features/sharing/operations.ts';
import { advancePrivateCalendarAuthority, createPrivateCalendarRoot, verifyPrivateCalendarAuthorityUpdate, verifyPrivateCalendarRoot } from '../src/features/sharing/private-calendar/authority.ts';
import { createPrivateCalendarAccountKey, unwrapPrivateCalendarKey, wrapPrivateCalendarKey } from '../src/features/sharing/private-calendar/key-envelope.ts';
import { createPrivateCalendarCloud } from '../src/platform/sharing/private-calendar-cloud.ts';
import { openPrivateCalendarCache, sealPrivateCalendarCache } from '../src/features/sharing/private-calendar/cache-crypto.ts';
import { privateCalendarSetupFixture } from './helpers/private-calendar-setup.mjs';
import { createPrivateCalendarAuthoritySync } from '../src/features/sharing/private-calendar/authority-sync.ts';
import { createPrivateCalendarKeyDelivery } from '../src/features/sharing/private-calendar/key-delivery.ts';
import { createPrivateCalendarPairingController } from '../src/features/sharing/private-calendar/pairing-controller.ts';
import { privateCalendarPairingReference } from '../src/features/sharing/private-calendar/pairing.ts';
import { createPrivateCalendarDeviceSession } from '../src/features/sharing/private-calendar/device-session.ts';
import { createPrivateCalendarSourceController, privateCalendarSourceBinding } from '../src/features/sharing/private-calendar/source-controller.ts';
import { createPrivateCalendarSourceStorage } from '../src/platform/storage/private-calendar-source.ts';
import { privateCalendarRuntimeFixture } from './helpers/private-calendar-runtime.mjs';
import { loadNativeModule } from './helpers/native-module.mjs';
import * as firestoreSdk from 'firebase/firestore';
const { createPrivateCalendarCapture } = await import('../src/features/sharing/private-calendar/calendar-capture.ts');
const { createCalendarQueryRange } = await import('../src/features/google-sync/calendar-availability.ts');

if (!process.env.FIRESTORE_EMULATOR_HOST) throw new Error('Use the local Firestore emulator only.');
let env;
before(async () => { env = await initializeTestEnvironment({ projectId: 'demo-liflow-sharing', firestore: { rules: readFileSync(new URL('../firestore.rules', import.meta.url), 'utf8') } }); });
beforeEach(async () => { await env.clearFirestore(); });
after(async () => { await env?.cleanup(); });
const userId = 'calendar-owner';
function client(uid, changeAtCall = 0, gateway = crypto) {
  const firestore = env.authenticatedContext(uid).firestore(); let current = uid; let calls = 0;
  return { firestore, cloud: createPrivateCalendarCloud(firestore, uid, () => { if (++calls === changeAtCall) current = 'another-user'; return current; }, gateway),
    switch: value => { current = value; }, calls: () => calls };
}
async function clientSwitchingAfterCommit(uid) {
  const firestore = env.authenticatedContext(uid).firestore(); let current = uid;
  const filename = 'src/platform/sharing/private-calendar-cloud.ts'; const sourceUrl = new URL(`../${filename}`, import.meta.url);
  const imports = [...new Set([...readFileSync(sourceUrl, 'utf8').matchAll(/from '([^']+)'/g)].map(match => match[1]))];
  const mocks = Object.fromEntries(await Promise.all(imports.filter(name => name !== 'firebase/firestore')
    .map(async name => [name, await import(new URL(name, sourceUrl))])));
  mocks['firebase/firestore'] = { ...firestoreSdk, async runTransaction(...args) {
    const result = await firestoreSdk.runTransaction(...args); current = 'another-user'; return result;
  } };
  const factory = loadNativeModule(filename, mocks).createPrivateCalendarCloud;
  return { firestore, cloud: factory(firestore, uid, () => current, crypto) };
}
async function fixture() {
  const main = await createDeviceIdentity(crypto); const other = await createDeviceIdentity(crypto);
  const root = await createPrivateCalendarRoot(crypto, userId, main); const left = client(userId);
  assert.equal((await left.cloud.createRoot(root)).created, true);
  return { main, other, root, left, right: client(userId), ref: doc(left.firestore, 'privateCalendars', userId) };
}
async function joined() {
  const h = await fixture(); const authority = advancePrivateCalendarAuthority(h.root, { mainDeviceId: h.main.deviceId, devices: [h.main, h.other], keyVersion: 1 }, h.main);
  await h.left.cloud.commitAuthority(h.root, authority); return { ...h, authority };
}

test('private Calendar foreground watch emits the server-confirmed initial head and later changes and detaches cleanly', async () => {
  const h = await fixture(); let changes = 0; let failure = false;
  const stop = h.left.cloud.watch(() => { changes++; }, () => { failure = true; });
  async function observed(count) { const end = Date.now() + 5000; while (changes < count && !failure && Date.now() < end) await new Promise(resolve => setTimeout(resolve, 10)); assert.equal(failure, false); assert.ok(changes >= count, 'Expected a server-confirmed snapshot'); }
  try {
    await observed(1);
    const next = advancePrivateCalendarAuthority(h.root, { mainDeviceId: h.main.deviceId, devices: [h.main], keyVersion: 1 }, h.main, { purpose: 'calendarSourceChange' });
    const prior = changes; await h.left.cloud.commitAuthority(h.root, next); await observed(prior + 1);
    stop(); const stoppedCount = changes;
    const last = advancePrivateCalendarAuthority(next, { mainDeviceId: h.main.deviceId, devices: [h.main], keyVersion: 1 }, h.main, { purpose: 'calendarSourceChange' });
    await h.left.cloud.commitAuthority(next, last); await new Promise(resolve => setTimeout(resolve, 50)); assert.equal(changes, stoppedCount);
  } finally { stop(); }
});

test('private Calendar Cloud root creation is fixed and idempotent while other users cannot read any private path or enumerate owners', async () => {
  const h = await fixture(); assert.equal((await h.left.cloud.createRoot(h.root)).created, false);
  const head = await h.right.cloud.readHead(); assert.equal(head.rootDigest, h.root.digest); assert.equal(head.cacheHead, null);
  const raw = (await getDocFromServer(h.ref)).data(); assert.equal(JSON.stringify(raw).includes('signingSecretKey'), false);
  const outsider = client('same-group-owner');
  for (const ref of [doc(outsider.firestore, 'privateCalendars', userId), doc(outsider.firestore, 'privateCalendars', userId, 'authorities', '1')]) await assert.rejects(getDocFromServer(ref), { code: 'permission-denied' });
  await assert.rejects(getDocsFromServer(collection(h.left.firestore, 'privateCalendars')), { code: 'permission-denied' });
  await assert.rejects(getDocFromServer(doc(env.unauthenticatedContext().firestore(), 'privateCalendars', userId)), { code: 'permission-denied' });
  await assert.rejects(deleteDoc(h.ref), { code: 'permission-denied' });
  await assert.rejects(updateDoc(h.ref, { rawBusyIntervals: [] }), { code: 'permission-denied' });
  await assert.rejects(setDoc(doc(h.left.firestore, 'privateCalendars', userId, 'authorities', '1'), { authorityJson: 'replace' }), { code: 'permission-denied' });
});

test('private Calendar simultaneous first-device proposals retain exactly one server root and never replace a losing local proposal', async () => {
  const a = await createDeviceIdentity(crypto); const b = await createDeviceIdentity(crypto);
  const first = await createPrivateCalendarRoot(crypto, userId, a); const second = await createPrivateCalendarRoot(crypto, userId, b);
  const left = client(userId); const right = client(userId);
  const results = await Promise.allSettled([left.cloud.createRoot(first), right.cloud.createRoot(second)]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1); assert.equal(results.filter(result => result.status === 'rejected').length, 1);
  const head = await left.cloud.readHead(); const winner = head.rootDigest === first.digest ? first : second; const loser = winner === first ? second : first;
  assert.equal((await right.cloud.createRoot(winner)).created, false);
  await assert.rejects(() => right.cloud.createRoot(loser), { code: 'private-calendar/conflict' });
  assert.equal((await left.cloud.readHead()).rootDigest, winner.digest);
});

test('private Calendar authority CAS preserves the signed chain and concurrent main changes remain conflicts rather than last-writer updates', async () => {
  const h = await fixture(); const third = await createDeviceIdentity(crypto);
  const a = advancePrivateCalendarAuthority(h.root, { mainDeviceId: h.other.deviceId, devices: [h.main, h.other], keyVersion: 1 }, h.main);
  const b = advancePrivateCalendarAuthority(h.root, { mainDeviceId: h.main.deviceId, devices: [h.main, third], keyVersion: 1 }, h.main);
  const changes = await Promise.allSettled([h.left.cloud.commitAuthority(h.root, a), h.right.cloud.commitAuthority(h.root, b)]);
  assert.equal(changes.filter(result => result.status === 'fulfilled').length, 1); assert.equal(changes.filter(result => result.status === 'rejected').length, 1);
  const archive = await h.right.cloud.authorityPage(0); assert.equal(archive.authorities.length, 2);
  const root = verifyPrivateCalendarRoot(archive.authorities[0], h.root.anchor); const latest = verifyPrivateCalendarAuthorityUpdate(root, archive.authorities[1]);
  assert.equal(latest.digest, archive.head.authorityDigest);
  assert.equal((await h.left.cloud.commitAuthority(h.root, latest)).head.authorityDigest, latest.digest);
  await assert.rejects(updateDoc(h.ref, { authorityRevision: 50 }), { code: 'permission-denied' });
});

test('private Calendar approved same-UID devices receive the same private key through immutable authenticated envelopes', async () => {
  const h = await joined(); const key = await createPrivateCalendarAccountKey(crypto);
  assert.equal(await h.right.cloud.readKey(h.authority, h.other.deviceId), null);
  const wrapped = await wrapPrivateCalendarKey(crypto, key, h.authority, h.main, h.other.deviceId);
  await h.left.cloud.sendKey(h.authority, wrapped); await h.left.cloud.sendKey(h.authority, wrapped);
  const received = await h.right.cloud.readKey(h.authority, h.other.deviceId);
  assert.deepEqual(await unwrapPrivateCalendarKey(crypto, received, h.authority, h.other), key);
  const differentEnvelope = await wrapPrivateCalendarKey(crypto, key, h.authority, h.main, h.other.deviceId);
  await assert.rejects(() => h.left.cloud.sendKey(h.authority, differentEnvelope), { code: 'private-calendar/conflict' });
  const outsider = client('another-group-member');
  await assert.rejects(getDocFromServer(doc(outsider.firestore, 'privateCalendars', userId, 'keyEnvelopes', `${h.authority.digest}_${h.other.deviceId}`)), { code: 'permission-denied' });
  const stranger = await createDeviceIdentity(crypto); await assert.rejects(() => h.right.cloud.readKey(h.authority, stranger.deviceId), /未承認/u); key.fill(0);
});

test('private Calendar authority changes retire obsolete wrapped transport copies and revoked devices cannot publish against the old head', async () => {
  const h = await joined(); const key = await createPrivateCalendarAccountKey(crypto);
  const wrapped = await wrapPrivateCalendarKey(crypto, key, h.authority, h.main, h.other.deviceId); await h.left.cloud.sendKey(h.authority, wrapped);
  const removed = advancePrivateCalendarAuthority(h.authority, { mainDeviceId: h.main.deviceId, devices: [h.main], keyVersion: 2 }, h.main);
  await h.left.cloud.commitAuthority(h.authority, removed);
  await assert.rejects(() => h.right.cloud.sendKey(h.authority, wrapped), { code: 'private-calendar/conflict' });
  await assert.rejects(() => h.right.cloud.readKey(h.authority, h.other.deviceId), { code: 'private-calendar/conflict' });
  const old = await getDocFromServer(doc(h.left.firestore, 'privateCalendars', userId, 'keyEnvelopes', `${h.authority.digest}_${h.other.deviceId}`));
  assert.equal(old.exists(), false); const archive = await h.left.cloud.authorityPage(0); assert.equal(archive.authorities.length, 3); key.fill(0);
});

test('private Calendar Cloud rechecks the account after a committed create and an exact retry recovers the existing root', async () => {
  const identity = await createDeviceIdentity(crypto); const root = await createPrivateCalendarRoot(crypto, userId, identity);
  const interrupted = await clientSwitchingAfterCommit(userId);
  await assert.rejects(() => interrupted.cloud.createRoot(root), { code: 'private-calendar/access-denied' });
  const recovered = client(userId); assert.equal((await recovered.cloud.createRoot(root)).created, false);
  assert.equal((await recovered.cloud.readHead()).rootDigest, root.digest);
  recovered.switch('another-user'); await assert.rejects(() => recovered.cloud.readHead(), { code: 'private-calendar/access-denied' });
});

test('private Calendar Cloud rejects malformed public metadata and a substituted signed root never passes the original local trust pin', async () => {
  const h = await fixture();
  await env.withSecurityRulesDisabled(async context => { await updateDoc(doc(context.firestore(), 'privateCalendars', userId), { authorityDigest: '0'.repeat(64) }); });
  await assert.rejects(() => h.left.cloud.readHead(), /公開情報/u);
  const impostor = await createPrivateCalendarRoot(crypto, userId, h.other);
  assert.throws(() => verifyPrivateCalendarRoot(impostor.signed, h.root.anchor), /信頼情報/u);
});

async function cacheFixture(count = 1) {
  const h = await joined(); const key = await createPrivateCalendarAccountKey(crypto); const calendarBinding = 'private-calendar-google-binding';
  const start = Date.parse('2026-10-28T00:00:00.000Z');
  const cache = { ownerUserId: userId, accountGeneration: h.authority.signed.body.accountGeneration, mainDeviceId: h.main.deviceId, mainRevision: 2,
    calendarBinding, timeZone: 'Asia/Tokyo', fetchedAt: new Date(start).toISOString(), coverage: { start: new Date(start).toISOString(), end: new Date(start + 30 * 86400000).toISOString() },
    intervals: Array.from({ length: count }, (_, index) => ({ start: new Date(start + index * 120000).toISOString(), end: new Date(start + index * 120000 + 60000).toISOString() })) };
  const seal = (sequence = 1, changes = {}) => sealPrivateCalendarCache(crypto, { cache, authority: h.authority, calendarBinding, accountKey: key, mainDevice: h.main, sequence, ...changes });
  const open = encrypted => openPrivateCalendarCache(crypto, encrypted, { authority: h.authority, calendarBinding, accountKey: key });
  return { ...h, key, calendarBinding, cache, seal, open };
}

test('private Calendar Cloud transfers twenty thousand encrypted intervals to the same approved UID with bounded parts and no public busy content', async () => {
  const h = await cacheFixture(20000); const encrypted = await h.seal(); assert.equal(encrypted.chunks.length, 22);
  assert.equal((await h.left.cloud.uploadCache(h.authority, encrypted)).published, true);
  const received = await h.right.cloud.readCache(h.authority); assert.deepEqual(await h.open(received), h.cache);
  const root = await h.left.cloud.readHead(); assert.equal(root.cacheHead.manifestDigest, sharedDocumentDigest(encrypted.manifest));
  const cacheRef = doc(h.ref, 'caches', root.cacheHead.cacheId); const parts = await getDocsFromServer(collection(cacheRef, 'parts'));
  assert.equal(parts.size, 22); assert.ok(parts.docs.every(part => JSON.stringify(part.data()).length < 141000));
  const serialized = JSON.stringify([root, (await getDocFromServer(cacheRef)).data(), ...parts.docs.map(part => part.data())]);
  for (const privateText of [h.calendarBinding, 'Asia/Tokyo', h.cache.fetchedAt, h.cache.intervals[0].start, h.main.signingSecretKey, Buffer.from(h.key).toString('hex')]) assert.equal(serialized.includes(privateText), false);
  const outsider = client('same-group-owner');
  for (const suffix of [[], ['parts', '0']]) await assert.rejects(getDocFromServer(doc(outsider.firestore, 'privateCalendars', userId, 'caches', root.cacheHead.cacheId, ...suffix)), { code: 'permission-denied' });
  h.key.fill(0);
});

test('private Calendar Cloud uncertain cache delivery recovers the exact saved envelope after an account change without publishing a second cache', async () => {
  const h = await cacheFixture(); const encrypted = await h.seal(); const interrupted = await clientSwitchingAfterCommit(userId);
  await assert.rejects(() => interrupted.cloud.uploadCache(h.authority, encrypted), { code: 'private-calendar/access-denied' });
  assert.equal((await h.right.cloud.uploadCache(h.authority, encrypted)).published, false);
  assert.deepEqual(await h.right.cloud.readCache(h.authority), encrypted);
  assert.equal((await getDocsFromServer(collection(h.ref, 'caches'))).size, 1); h.key.fill(0);
});

test('private Calendar Cloud publishes and retires derived snapshots atomically and rejects delayed or forked sequences', async () => {
  const h = await cacheFixture(); const first = await h.seal(); const second = await h.seal(2);
  await h.left.cloud.uploadCache(h.authority, first); await h.left.cloud.uploadCache(h.authority, second);
  assert.equal((await getDocsFromServer(collection(h.ref, 'caches'))).size, 1);
  const old = doc(h.ref, 'caches', first.manifest.body.cacheId); assert.equal((await getDocFromServer(old)).exists(), false);
  assert.equal((await getDocsFromServer(collection(old, 'parts'))).size, 0);
  await assert.rejects(() => h.right.cloud.uploadCache(h.authority, first), { code: 'private-calendar/conflict' });
  const fork = await h.seal(2); await assert.rejects(() => h.right.cloud.uploadCache(h.authority, fork), { code: 'private-calendar/conflict' });
  assert.equal((await h.right.cloud.readHead()).cacheHead.manifestDigest, sharedDocumentDigest(second.manifest)); h.key.fill(0);
});

test('private Calendar Cloud concurrent uploads converge on the highest sequence and same-sequence forks never silently overwrite', async () => {
  const h = await cacheFixture(); const same = await h.seal();
  const duplicate = await Promise.all([h.left.cloud.uploadCache(h.authority, same), h.right.cloud.uploadCache(h.authority, same)]);
  assert.deepEqual(duplicate.map(result => result.published).sort(), [false, true]);
  const a = await h.seal(2); const b = await h.seal(2);
  const fork = await Promise.allSettled([h.left.cloud.uploadCache(h.authority, a), h.right.cloud.uploadCache(h.authority, b)]);
  assert.equal(fork.filter(result => result.status === 'fulfilled').length, 1); assert.equal(fork.filter(result => result.status === 'rejected').length, 1);
  const c = await h.seal(3); const d = await h.seal(4);
  await Promise.allSettled([h.left.cloud.uploadCache(h.authority, c), h.right.cloud.uploadCache(h.authority, d)]);
  assert.equal((await h.right.cloud.readHead()).cacheHead.sequence, 4); assert.equal((await getDocsFromServer(collection(h.ref, 'caches'))).size, 1); h.key.fill(0);
});

test('private Calendar Cloud one denied part aborts the entire publication and the previous complete cache remains readable', async () => {
  const h = await cacheFixture(20000); const first = await h.seal(); await h.left.cloud.uploadCache(h.authority, first);
  const next = await h.seal(2); const ref = doc(h.ref, 'caches', next.manifest.body.cacheId); const digest = sharedDocumentDigest(next.manifest);
  const head = { cacheId: next.manifest.body.cacheId, manifestDigest: digest, authorityDigest: h.authority.digest, sequence: 2, chunkCount: next.chunks.length };
  const batch = writeBatch(h.left.firestore);
  batch.set(ref, { schemaVersion: 1, authorityDigest: h.authority.digest, sequence: 2, chunkCount: head.chunkCount, manifestDigest: digest, manifestJson: canonicalJson(next.manifest), createdAt: serverTimestamp() });
  for (const part of next.chunks) batch.set(doc(ref, 'parts', String(part.index)), { schemaVersion: 1, index: part.index, partJson: canonicalJson(part), createdAt: serverTimestamp(), ...(part.index === next.chunks.length - 1 ? { forbiddenPlainBusy: [] } : {}) });
  batch.update(h.ref, { cacheHead: head, updatedAt: serverTimestamp() });
  await assert.rejects(batch.commit(), { code: 'permission-denied' });
  assert.equal((await getDocFromServer(ref)).exists(), false); assert.equal((await getDocsFromServer(collection(ref, 'parts'))).size, 0);
  assert.deepEqual(await h.right.cloud.readCache(h.authority), first); h.key.fill(0);
});

test('private Calendar Cloud missing or altered server parts are unconfirmed and are never returned as an authenticated cache', async () => {
  const h = await cacheFixture(); const encrypted = await h.seal(); await h.left.cloud.uploadCache(h.authority, encrypted);
  const path = ['privateCalendars', userId, 'caches', encrypted.manifest.body.cacheId, 'parts', '0'];
  await env.withSecurityRulesDisabled(async context => {
    const part = { ...encrypted.chunks[0], encryptedPayload: '0'.repeat(encrypted.chunks[0].encryptedPayload.length) };
    await updateDoc(doc(context.firestore(), ...path), { partJson: canonicalJson(part) });
  });
  await assert.rejects(() => h.right.cloud.readCache(h.authority), /改ざん/u);
  await assert.rejects(() => h.left.cloud.uploadCache(h.authority, encrypted), /欠けているか異なります/u);
  await env.withSecurityRulesDisabled(async context => { await deleteDoc(doc(context.firestore(), ...path)); });
  await assert.rejects(() => h.right.cloud.readCache(h.authority), /揃っていません/u); h.key.fill(0);
});

test('private Calendar Cloud switches main authority before accepting its new cache and rejects every old-main upload', async () => {
  const h = await cacheFixture(); const old = await h.seal(40); await h.left.cloud.uploadCache(h.authority, old);
  const next = advancePrivateCalendarAuthority(h.authority, { mainDeviceId: h.other.deviceId, devices: [h.main, h.other], keyVersion: 1 }, h.main);
  await h.left.cloud.commitAuthority(h.authority, next);
  assert.equal(await h.right.cloud.readCache(next), null);
  const delayed = await h.seal(41); await assert.rejects(() => h.left.cloud.uploadCache(h.authority, delayed), { code: 'private-calendar/conflict' });
  const changedBody = { ...h.cache, mainDeviceId: h.other.deviceId, mainRevision: 3 };
  const current = await h.seal(1, { authority: next, mainDevice: h.other, cache: changedBody });
  await h.right.cloud.uploadCache(next, current);
  assert.equal((await h.left.cloud.readHead()).cacheHead.sequence, 1);
  assert.deepEqual(await openPrivateCalendarCache(crypto, await h.left.cloud.readCache(next), { authority: next, accountKey: h.key, calendarBinding: h.calendarBinding }), changedBody); h.key.fill(0);
});

test('private Calendar concurrent retries of the same prepared first-device root both recover one immutable acceptance', async () => {
  const identity = await createDeviceIdentity(crypto); const root = await createPrivateCalendarRoot(crypto, userId, identity);
  const left = client(userId); const right = client(userId);
  const accepted = await Promise.all([left.cloud.createRoot(root), right.cloud.createRoot(root)]);
  assert.equal(accepted.length, 2); assert.ok(accepted.every(result => result.head.rootDigest === root.digest));
  assert.equal((await getDocsFromServer(collection(doc(left.firestore, 'privateCalendars', userId), 'authorities'))).size, 1);
});

test('private Calendar concurrent retries of one signed authority update recover the exact archive without advancing another revision', async () => {
  const h = await fixture(); const next = advancePrivateCalendarAuthority(h.root, { devices: [h.main, h.other], mainDeviceId: h.other.deviceId, keyVersion: 1 }, h.main);
  const accepted = await Promise.all([h.left.cloud.commitAuthority(h.root, next), h.right.cloud.commitAuthority(h.root, next)]);
  assert.ok(accepted.every(result => result.head.authorityDigest === next.digest));
  assert.equal((await h.left.cloud.authorityPage(0)).authorities.length, 2);
});

for (const olderRead of ['head', 'archive']) {
  test(`private Calendar identical authority retry recovers when its ${olderRead} read precedes the other client's atomic commit`, async () => {
    const h = await fixture(); const next = advancePrivateCalendarAuthority(h.root, { devices: [h.main, h.other], mainDeviceId: h.other.deviceId, keyVersion: 1 }, h.main);
    const ready = Promise.withResolvers(); const committed = Promise.withResolvers(); let attempts = 0;
    const filename = 'src/platform/sharing/private-calendar-cloud.ts'; const sourceUrl = new URL(`../${filename}`, import.meta.url);
    // Keep the real SDK, Rules, signatures and cloud implementation. Only hold a
    // read until the independent client's commit to reproduce both read orders.
    const imports = [...new Set([...readFileSync(sourceUrl, 'utf8').matchAll(/from '([^']+)'/g)].map(match => match[1]))];
    const mocks = Object.fromEntries(await Promise.all(imports.filter(name => name !== 'firebase/firestore')
      .map(async name => [name, await import(new URL(name, sourceUrl))])));
    mocks['firebase/firestore'] = { ...firestoreSdk, runTransaction: (db, work, options) => firestoreSdk.runTransaction(db, transaction => {
      const attempt = ++attempts;
      return work(new Proxy(transaction, { get(target, key) {
        if (key !== 'get') { const value = Reflect.get(target, key); return typeof value === 'function' ? value.bind(target) : value; }
        return async reference => {
          const side = reference.path === h.ref.path ? 'head' : reference.path === `${h.ref.path}/authorities/2` ? 'archive' : null;
          if (attempt === 1 && side && side !== olderRead) await committed.promise;
          const snapshot = await target.get(reference);
          if (attempt === 1 && side === olderRead) ready.resolve();
          return snapshot;
        };
      } }));
    }, options) };
    const { createPrivateCalendarCloud: controlledCloud } = loadNativeModule(filename, mocks);
    const cloud = controlledCloud(h.left.firestore, userId, () => userId, crypto);
    const pending = cloud.commitAuthority(h.root, next); pending.catch(() => {});
    let timeout;
    try {
      await Promise.race([ready.promise, new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error('First authority read did not arrive')), 5000); })]);
      await h.right.cloud.commitAuthority(h.root, next); committed.resolve();
      assert.equal((await pending).head.authorityDigest, next.digest);
      assert.ok(attempts > 1, 'The real SDK must retry its changed document version');
      assert.equal((await h.right.cloud.authorityPage(0)).authorities.length, 2);
    } finally { clearTimeout(timeout); committed.resolve(); await pending.catch(() => {}); }
  });
}

test('private Calendar concurrent retries of the exact prepared key envelope recover its original bytes without replacement', async () => {
  const h = await joined(); const key = await createPrivateCalendarAccountKey(crypto);
  const wrapped = await wrapPrivateCalendarKey(crypto, key, h.authority, h.main, h.other.deviceId);
  await Promise.all([h.left.cloud.sendKey(h.authority, wrapped), h.right.cloud.sendKey(h.authority, wrapped)]);
  assert.deepEqual(await h.right.cloud.readKey(h.authority, h.other.deviceId), wrapped); key.fill(0);
});

test('private Calendar Cloud maximum device membership rotates without exceeding Rules access limits and removes every old transport key', async () => {
  const h = await fixture(); const devices = [h.main, ...await Promise.all(Array.from({ length: 15 }, () => createDeviceIdentity(crypto)))];
  const joined = advancePrivateCalendarAuthority(h.root, { devices, mainDeviceId: h.main.deviceId, keyVersion: 1 }, h.main);
  await h.left.cloud.commitAuthority(h.root, joined); const key = await createPrivateCalendarAccountKey(crypto);
  const wrapped = await Promise.all(devices.map(device => wrapPrivateCalendarKey(crypto, key, joined, h.main, device.deviceId)));
  await Promise.all(wrapped.map(value => h.left.cloud.sendKey(joined, value)));
  const removed = advancePrivateCalendarAuthority(joined, { devices: [h.main], mainDeviceId: h.main.deviceId, keyVersion: 2 }, h.main);
  await h.left.cloud.commitAuthority(joined, removed);
  const previous = await Promise.all(devices.map(device => getDocFromServer(doc(h.ref, 'keyEnvelopes', `${joined.digest}_${device.deviceId}`))));
  assert.ok(previous.every(value => !value.exists())); assert.equal((await h.right.cloud.readHead()).keyVersion, 2);
  await assert.rejects(() => h.right.cloud.sendKey(joined, wrapped[1]), { code: 'private-calendar/conflict' }); key.fill(0);
});

test('private Calendar Cloud authority history pages at one hundred revisions and never treats server rollback as an empty successful update', async () => {
  const h = await joined(); let current = h.authority;
  for (let index = 0; index < 101; index++) {
    const next = advancePrivateCalendarAuthority(current, { devices: [h.main, h.other], mainDeviceId: current.signed.body.mainDeviceId === h.main.deviceId ? h.other.deviceId : h.main.deviceId, keyVersion: 1 }, h.main);
    await h.left.cloud.commitAuthority(current, next); current = next;
  }
  const first = await h.right.cloud.authorityPage(0); const second = await h.right.cloud.authorityPage(100);
  assert.equal(first.authorities.length, 100); assert.equal(second.authorities.length, 3);
  let verified = verifyPrivateCalendarRoot(first.authorities[0], h.root.anchor);
  for (const signed of [...first.authorities.slice(1), ...second.authorities]) verified = verifyPrivateCalendarAuthorityUpdate(verified, signed);
  assert.equal(verified.digest, current.digest); assert.equal((await h.right.cloud.authorityPage(103)).authorities.length, 0);
  await assert.rejects(() => h.right.cloud.authorityPage(104), { code: 'private-calendar/conflict' });
});

test('private Calendar Cloud account change during Native ciphertext verification prevents every publication write', async () => {
  const h = await cacheFixture(); const encrypted = await h.seal(); let interrupted;
  interrupted = client(userId, 0, { ...crypto, async digestSha256(bytes) {
    interrupted.switch('another-user'); return new Uint8Array(createHash('sha256').update(bytes).digest());
  } });
  await assert.rejects(() => interrupted.cloud.uploadCache(h.authority, encrypted), { code: 'private-calendar/access-denied' });
  assert.equal((await h.left.cloud.readHead()).cacheHead, null); assert.equal((await getDocsFromServer(collection(h.ref, 'caches'))).size, 0); h.key.fill(0);
});

test('private Calendar prepared first-device setup resumes the same real server acceptance from SQLite after a lost reply', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'liflow-root-cloud-')); t.after(() => rmSync(directory, { force: true, recursive: true }));
  const path = join(directory, 'prepared.db'); const local = privateCalendarSetupFixture(t, { userId, path }); const remote = client(userId); let drop = true;
  const cloud = { async createRoot(root) { const accepted = await remote.cloud.createRoot(root); if (drop) { drop = false; throw new Error('reply lost after server acceptance'); } return accepted; } };
  await assert.rejects(() => local.controller(cloud).prepareAndResume(), /reply lost/u);
  const prepared = await local.roots.read(); assert.equal((await local.readProtected()).authority, null); assert.equal((await local.readProtected()).hasStoredKeys, false);
  assert.equal((await remote.cloud.readHead()).rootDigest, prepared.digest);
  const restarted = privateCalendarSetupFixture(t, { userId, path, values: local.values, state: local.state });
  assert.equal((await restarted.controller(remote.cloud).resume()).rootDigest, prepared.digest);
  assert.equal((await restarted.roots.read()).status, 'ready'); assert.equal((await restarted.readProtected()).hasCurrentKey, true);
  const generation = local.state.generations; await restarted.controller(remote.cloud).prepareAndResume(); assert.equal(local.state.generations, generation);
});

test('private Calendar a losing first-device setup keeps its local candidate without pinning or generating a key for the winning account root', async t => {
  const winning = await fixture(); const losing = privateCalendarSetupFixture(t, { userId });
  await assert.rejects(() => losing.controller(client(userId).cloud).prepareAndResume(), { code: 'private-calendar/conflict' });
  const intent = await losing.roots.read(); assert.equal(intent.status, 'pending'); assert.notEqual(intent.digest, winning.root.digest);
  assert.equal((await losing.readProtected()).authority, null); assert.equal((await losing.readProtected()).hasStoredKeys, false);
  assert.equal((await winning.left.cloud.readHead()).rootDigest, winning.root.digest);
});

test('private Calendar prepared device changes recover their exact real server receipt after a lost reply and SQL reconstruction', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'liflow-control-cloud-')); t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, 'control.db'); const f = privateCalendarSetupFixture(t, { userId, path }); const native = client(userId);
  await f.controller(native.cloud).prepareAndResume(); const root = await f.secrets.authority(userId); const other = await createDeviceIdentity(crypto); let lose = true;
  const cloud = { ...native.cloud, async commitAuthority(...args) {
    const receipt = await native.cloud.commitAuthority(...args); if (lose) { lose = false; throw new Error('connection lost after device approval'); } return receipt;
  } };
  const sync = h => createPrivateCalendarAuthoritySync({ userId, secrets: h.secrets, intents: h.changes, cloud });
  const change = { mainDeviceId: root.signed.body.mainDeviceId, devices: [...root.signed.body.devices, other], keyVersion: 1 };
  await assert.rejects(() => sync(f).change(change), /connection lost/u); const saved = await f.changes.readPending();
  assert.equal((await f.secrets.authority(userId)).digest, root.digest); assert.equal((await native.cloud.readHead()).authorityDigest, saved.digest);
  const restored = privateCalendarSetupFixture(t, { userId, path, values: f.values, state: f.state });
  const accepted = await sync(restored).resume(); assert.equal(accepted.kind, 'accepted'); assert.equal(accepted.authority.digest, saved.digest);
  assert.equal(await restored.changes.readPending(), null); assert.equal((await native.cloud.authorityPage(0)).authorities.length, 2);
});

test('private Calendar real competing device changes retain the losing draft while verified history follows the server winner', async t => {
  const f = privateCalendarSetupFixture(t, { userId }); const left = client(userId); await f.controller(left.cloud).prepareAndResume();
  const root = await f.secrets.authority(userId); const identity = await f.secrets.identity(userId); const other = await createDeviceIdentity(crypto);
  const pending = await f.changes.prepare({ mainDeviceId: identity.deviceId, devices: [identity, other], keyVersion: 1 }, identity);
  const winning = advancePrivateCalendarAuthority(root, { mainDeviceId: identity.deviceId, devices: [identity], keyVersion: 2 }, identity);
  await client(userId).cloud.commitAuthority(root, winning);
  const sync = createPrivateCalendarAuthoritySync({ userId, secrets: f.secrets, intents: f.changes, cloud: left.cloud });
  const review = await sync.resume(); assert.equal(review.kind, 'review'); assert.equal(review.intentDigest, pending.digest);
  assert.equal((await f.secrets.authority(userId)).digest, winning.digest); assert.equal((await f.changes.readPending()).digest, pending.digest);
  assert.equal((await f.readProtected()).hasCurrentKey, false); assert.equal((await f.readProtected()).hasStoredKeys, true);
  assert.equal(await sync.dismissReviewed(pending.digest, review.observedCurrentDigest), true); assert.equal(await f.changes.readPending(), null);
  assert.equal((await left.cloud.readHead()).authorityDigest, winning.digest);
});

test('private Calendar receiver rejects a tampered real authority archive before advancing protected state', async t => {
  const f = privateCalendarSetupFixture(t, { userId }); const left = client(userId); await f.controller(left.cloud).prepareAndResume();
  const root = await f.secrets.authority(userId); const identity = await f.secrets.identity(userId);
  const next = advancePrivateCalendarAuthority(root, { mainDeviceId: identity.deviceId, devices: [identity], keyVersion: 2 }, identity);
  await left.cloud.commitAuthority(root, next); const bad = { ...next.signed, signature: '0'.repeat(128) };
  await env.withSecurityRulesDisabled(async context => {
    await updateDoc(doc(context.firestore(), 'privateCalendars', userId, 'authorities', '2'), { authorityJson: canonicalJson(bad), authorityDigest: sharedDocumentDigest(bad) });
  });
  await assert.rejects(() => createPrivateCalendarAuthoritySync({ userId, secrets: f.secrets, intents: f.changes, cloud: left.cloud }).refresh());
  assert.equal((await f.secrets.authority(userId)).digest, root.digest); assert.equal((await f.readProtected()).hasCurrentKey, true);
});

test('private Calendar fixed wrapped-key outbox recovers an actual immutable server write after reply loss and SQLite restart', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'liflow-key-outbox-cloud-')); t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, 'keys.db'); const f = privateCalendarSetupFixture(t, { userId, path }); const transport = client(userId);
  await f.controller(transport.cloud).prepareAndResume(); const root = await f.secrets.authority(userId); const other = await createDeviceIdentity(crypto);
  const control = createPrivateCalendarAuthoritySync({ userId, secrets: f.secrets, intents: f.changes, cloud: transport.cloud });
  const approved = await control.change({ mainDeviceId: root.signed.body.mainDeviceId, devices: [...root.signed.body.devices, other], keyVersion: 1 }); const authority = approved.authority;
  let lose = true; const sent = []; const cloud = { async sendKey(expected, packet) {
    sent.push(canonicalJson(packet)); await transport.cloud.sendKey(expected, packet);
    if (lose) { lose = false; throw Object.assign(new Error('reply lost after actual key acceptance'), { code: 'unavailable' }); }
  } };
  const service = h => createPrivateCalendarKeyDelivery({ userId, secrets: h.secrets, outbox: h.keyOutbox, cloud, now: () => 1_000, randomFraction: () => 0.5 });
  const first = service(f); await first.queueApprovedDevices(); assert.equal((await first.flush()).kind, 'deferred');
  const received = await client(userId).cloud.readKey(authority, other.deviceId); assert.ok(received); assert.equal(canonicalJson(received), sent[0]);
  const original = await f.secrets.currentKey(userId, authority); const opened = await unwrapPrivateCalendarKey(crypto, received, authority, other); assert.deepEqual(opened, original);
  const after = privateCalendarSetupFixture(t, { userId, path, values: f.values, state: f.state }); const resumed = service(after); const generations = f.state.generations;
  await resumed.queueApprovedDevices(); assert.equal((await resumed.flush()).kind, 'waiting'); assert.equal((await resumed.flush({ force: true })).kind, 'sent');
  assert.equal(sent.length, 2); assert.equal(sent[0], sent[1]); assert.equal(f.state.generations, generations); assert.equal((await after.keyOutbox.status(authority)).pending, 0);
  const raw = (await getDocFromServer(doc(transport.firestore, 'privateCalendars', userId, 'keyEnvelopes', `${authority.digest}_${other.deviceId}`))).data();
  for (const secret of [Buffer.from(original).toString('hex'), other.signingSecretKey, other.agreementSecretKey]) assert.equal(JSON.stringify(raw).includes(secret), false);
  original.fill(0); opened.fill(0);
});

test('private Calendar a non-main generation issuer distributes the same key to the new main through real Rules and transport', async t => {
  const f = privateCalendarSetupFixture(t, { userId }); const transport = client(userId); await f.controller(transport.cloud).prepareAndResume();
  const identity = await f.secrets.identity(userId); const other = await createDeviceIdentity(crypto); const devices = [identity, other];
  const control = createPrivateCalendarAuthoritySync({ userId, secrets: f.secrets, intents: f.changes, cloud: transport.cloud });
  await control.change({ mainDeviceId: identity.deviceId, devices, keyVersion: 1 });
  await control.change({ mainDeviceId: identity.deviceId, devices, keyVersion: 2 });
  const switched = await control.change({ mainDeviceId: other.deviceId, devices, keyVersion: 2 }); const authority = switched.authority;
  assert.equal((await f.readProtected()).hasCurrentKey, false); assert.equal(authority.keyIssuer.deviceId, identity.deviceId);
  const service = createPrivateCalendarKeyDelivery({ userId, secrets: f.secrets, outbox: f.keyOutbox, cloud: transport.cloud });
  assert.deepEqual(await service.queueApprovedDevices(), { kind: 'queued', count: 1 }); assert.equal((await service.flush()).sent, 1);
  const packet = await client(userId).cloud.readKey(authority, other.deviceId); const received = await unwrapPrivateCalendarKey(crypto, packet, authority, other);
  const original = await f.secrets.currentKey(userId, authority); assert.deepEqual(received, original);
  assert.equal(JSON.parse(await f.vault.getItem(`private-calendar-state:${userId}`)).keys.length, 2); received.fill(0); original.fill(0);
});

test('private Calendar actual pairing and main switch transfer one key and encrypted cache while revocation rejects rejoin and future decryption', async t => {
  const owner = privateCalendarSetupFixture(t, { userId }); const recipient = privateCalendarSetupFixture(t, { userId }); const left = client(userId); const right = client(userId);
  const services = (h, cloud) => {
    const authoritySync = createPrivateCalendarAuthoritySync({ userId, secrets: h.secrets, intents: h.changes, cloud });
    const delivery = createPrivateCalendarKeyDelivery({ userId, secrets: h.secrets, outbox: h.keyOutbox, cloud });
    return { authoritySync, delivery, pair: createPrivateCalendarPairingController({ userId, secrets: h.secrets, candidates: h.pairing, intents: h.changes, authoritySync, delivery, cloud }) };
  };
  await owner.controller(left.cloud).prepareAndResume(); const root = await owner.secrets.authority(userId); const originalIdentity = await owner.secrets.identity(userId);
  const original = services(owner, left.cloud); const joining = services(recipient, right.cloud);
  const request = await joining.pair.prepareConfirmedReference(privateCalendarPairingReference(root));
  assert.equal((await recipient.readProtected()).authority, null); assert.equal((await original.pair.approve(request.request)).kind, 'approved');
  assert.equal((await joining.pair.join()).kind, 'ready'); const secondIdentity = await recipient.secrets.identity(userId);
  const mainChanged = await original.authoritySync.change({ devices: [originalIdentity, secondIdentity], mainDeviceId: secondIdentity.deviceId, keyVersion: 1 });
  const authority = (await joining.authoritySync.refresh()).authority; assert.equal(authority.digest, mainChanged.authority.digest);
  const key = await recipient.secrets.currentKey(userId, authority); const firstKey = await owner.secrets.currentKey(userId, authority); assert.deepEqual(key, firstKey);
  const fetchedAt = '2026-10-28T00:00:00.000Z'; const calendarBinding = 'pairing-private-google-binding';
  const cache = { ownerUserId: userId, accountGeneration: authority.anchor.accountGeneration, mainDeviceId: secondIdentity.deviceId, mainRevision: authority.signed.body.revision,
    calendarBinding, timeZone: 'Asia/Tokyo', fetchedAt, coverage: { start: fetchedAt, end: '2026-10-29T00:00:00.000Z' }, intervals: [{ start: '2026-10-28T01:00:00.000Z', end: '2026-10-28T02:00:00.000Z' }] };
  const encrypted = await sealPrivateCalendarCache(crypto, { authority, accountKey: key, calendarBinding, cache, mainDevice: secondIdentity, sequence: 1 });
  await right.cloud.uploadCache(authority, encrypted);
  assert.deepEqual(await openPrivateCalendarCache(crypto, await left.cloud.readCache(authority), { authority, accountKey: firstKey, calendarBinding }), cache);
  await assert.rejects(() => sealPrivateCalendarCache(crypto, { authority, accountKey: firstKey, calendarBinding, cache, mainDevice: originalIdentity, sequence: 2 }));
  const removed = await original.authoritySync.change({ devices: [originalIdentity], mainDeviceId: originalIdentity.deviceId, keyVersion: 2 }); const final = removed.authority;
  await assert.rejects(() => original.pair.approve(request.request)); await assert.rejects(() => joining.pair.join(), /解除/u);
  assert.equal((await recipient.readProtected()).hasStoredKeys, true); assert.equal((await recipient.readProtected()).hasCurrentKey, false);
  const nextKey = await owner.secrets.createCurrentKey(userId, final);
  const next = await sealPrivateCalendarCache(crypto, { authority: final, accountKey: nextKey, calendarBinding,
    cache: { ...cache, mainDeviceId: originalIdentity.deviceId, mainRevision: final.signed.body.revision }, mainDevice: originalIdentity, sequence: 2 });
  await left.cloud.uploadCache(final, next);
  await assert.rejects(() => openPrivateCalendarCache(crypto, next, { authority: final, accountKey: key, calendarBinding }));
  const renewed = await joining.pair.prepareConfirmedReference(privateCalendarPairingReference(final));
  assert.equal(renewed.request.body.device.deviceId, secondIdentity.deviceId); assert.notEqual(renewed.request.body.requestNonce, request.request.body.requestNonce);
  await original.pair.approve(renewed.request); assert.equal((await joining.pair.join()).kind, 'ready');
  const restoredAuthority = await recipient.secrets.authority(userId); const restoredKey = await recipient.secrets.currentKey(userId, restoredAuthority);
  assert.deepEqual(restoredKey, nextKey); assert.equal(JSON.parse(await recipient.vault.getItem(`private-calendar-state:${userId}`)).keys.length, 2); restoredKey.fill(0);
  assert.equal(JSON.parse(await owner.vault.getItem(`private-calendar-state:${userId}`)).keys.length, 2); key.fill(0); firstKey.fill(0); nextKey.fill(0);
});

test('private Calendar a tampered actual approval archive cannot establish a new device pin even for the same authenticated UID', async t => {
  const owner = privateCalendarSetupFixture(t, { userId }); const recipient = privateCalendarSetupFixture(t, { userId }); const cloud = client(userId).cloud;
  const services = h => {
    const authoritySync = createPrivateCalendarAuthoritySync({ userId, secrets: h.secrets, intents: h.changes, cloud });
    const delivery = createPrivateCalendarKeyDelivery({ userId, secrets: h.secrets, outbox: h.keyOutbox, cloud });
    return createPrivateCalendarPairingController({ userId, secrets: h.secrets, candidates: h.pairing, intents: h.changes, authoritySync, delivery, cloud });
  };
  await owner.controller(cloud).prepareAndResume(); const root = await owner.secrets.authority(userId);
  const candidate = await services(recipient).prepareConfirmedReference(privateCalendarPairingReference(root)); await services(owner).approve(candidate.request);
  await env.withSecurityRulesDisabled(async context => {
    const reference = doc(context.firestore(), 'privateCalendars', userId, 'authorities', '2'); const value = (await getDocFromServer(reference)).data();
    const signed = JSON.parse(value.authorityJson); signed.signature = '0'.repeat(128); await updateDoc(reference, { authorityJson: canonicalJson(signed), authorityDigest: sharedDocumentDigest(signed) });
  });
  await assert.rejects(() => services(recipient).join()); assert.equal((await recipient.readProtected()).authority, null); assert.equal((await recipient.readProtected()).hasStoredKeys, false);
  assert.equal((await recipient.pairing.read()).status, 'prepared');
});

test('private Calendar normal device settings facade recovers actual server receipts and enforces reviewed main changes and revocation', async t => {
  const owner = privateCalendarSetupFixture(t, { userId }); const recipient = privateCalendarSetupFixture(t, { userId }); const left = client(userId); const right = client(userId);
  let loseReply = true;
  const cloud = { ...left.cloud, async commitAuthority(...args) {
    const result = await left.cloud.commitAuthority(...args); if (loseReply) { loseReply = false; throw new Error('actual acceptance reply lost'); } return result;
  } };
  const session = (f, transport) => createPrivateCalendarDeviceSession({ userId, secrets: f.secrets, roots: f.roots, intents: f.changes,
    candidates: f.pairing, outbox: f.keyOutbox, cache: f.cache, cloud: transport, assertOwner: () => assert.equal(f.state.currentUser, userId) });
  const a = session(owner, cloud); const b = session(recipient, right.cloud);
  assert.equal((await a.read()).phase, 'unconfigured'); assert.equal((await left.cloud.readHead()), null); assert.equal(owner.state.generations, 0);
  const first = await a.initializeFirstDevice(); const request = await b.prepareConfirmedReference(first.reference);
  await assert.rejects(() => a.approveConfirmedRequest(request.request), /actual acceptance/u); assert.ok((await a.read()).pendingChange);
  const resumed = await a.synchronizeDevices(); assert.equal(resumed.pendingChange, null); assert.equal(resumed.pendingKeys, 0);
  const joined = await b.acceptApproval(); assert.equal(joined.keyReady, true); assert.equal(joined.revision, 2);
  const main = await a.changeMain(joined.deviceId, resumed.authorityDigest); assert.equal(main.mainDeviceId, joined.deviceId);
  await assert.rejects(() => a.changeMain(resumed.deviceId, resumed.authorityDigest), /表示後/u);
  const removed = await a.revokeDevice(joined.deviceId, main.authorityDigest); assert.equal(removed.keyVersion, 2); assert.equal(removed.mainDeviceId, resumed.deviceId);
  assert.equal((await b.synchronizeDevices()).phase, 'revoked'); assert.equal((await recipient.readProtected()).hasStoredKeys, true);
  assert.equal((await left.cloud.authorityPage(0)).authorities.length, 4);
});

test('private Calendar actual three-device key delivery settles another approved sender without overwriting accepted ciphertext or retrying forever', async t => {
  const devices = Array.from({ length: 3 }, () => privateCalendarSetupFixture(t, { userId })); const clients = devices.map(() => client(userId));
  const sessions = devices.map((f, index) => createPrivateCalendarDeviceSession({ userId, secrets: f.secrets, roots: f.roots, intents: f.changes,
    candidates: f.pairing, outbox: f.keyOutbox, cache: f.cache, cloud: clients[index].cloud, assertOwner: () => assert.equal(f.state.currentUser, userId) }));
  const [a,b,c] = sessions; const first = await a.initializeFirstDevice();
  const joinB = await b.prepareConfirmedReference(first.reference); await a.approveConfirmedRequest(joinB.request); await b.acceptApproval();
  const joinC = await c.prepareConfirmedReference((await a.read()).reference); const approved = await a.approveConfirmedRequest(joinC.request); await c.acceptApproval();
  const ref = doc(clients[0].firestore, 'privateCalendars', userId, 'keyEnvelopes', `${approved.authorityDigest}_${joinC.deviceId}`);
  const saved = (await getDocFromServer(ref)).data().wrappedKeyJson;
  assert.equal((await b.synchronizeDevices()).pendingKeys, 0); assert.equal((await c.synchronizeDevices()).pendingKeys, 0);
  assert.equal((await getDocFromServer(ref)).data().wrappedKeyJson, saved);
  const authority = await devices[0].secrets.authority(userId); const identity = await devices[0].secrets.identity(userId); const key = await devices[0].secrets.currentKey(userId, authority);
  try {
    const other = await devices[1].secrets.currentKey(userId, authority); const last = await devices[2].secrets.currentKey(userId, authority);
    assert.deepEqual(key, other); assert.deepEqual(key, last); other.fill(0); last.fill(0);
    const sameSenderFork = await wrapPrivateCalendarKey(crypto, key, authority, identity, joinC.deviceId);
    await assert.rejects(() => clients[0].cloud.sendKey(authority, sameSenderFork), { code: 'private-calendar/conflict' });
    const allocations = devices[1].state.generations; const before = devices[1].connection.prepare('SELECT envelope_json FROM private_calendar_key_outbox ORDER BY recipient_id').all();
    await b.synchronizeDevices(); assert.equal(devices[1].state.generations, allocations);
    assert.deepEqual(devices[1].connection.prepare('SELECT envelope_json FROM private_calendar_key_outbox ORDER BY recipient_id').all(), before);
  } finally { key.fill(0); }
});

test('private Calendar an explicit protected source switch recovers its actual receipt and invalidates the prior server cache without publishing the Google subject', async t => {
  const f = privateCalendarSetupFixture(t, { userId }); const left = client(userId); await f.controller(left.cloud).prepareAndResume();
  const root = await f.secrets.authority(userId); const identity = await f.secrets.identity(userId); const key = await f.secrets.currentKey(userId, root);
  try {
    const binding = privateCalendarSourceBinding(root); const cache = { ownerUserId: userId, accountGeneration: root.anchor.accountGeneration, mainDeviceId: identity.deviceId, mainRevision: 1,
      calendarBinding: binding, timeZone: 'Asia/Tokyo', fetchedAt: '2026-10-28T00:00:00.000Z', coverage: { start: '2026-10-28T00:00:00.000Z', end: '2026-10-29T00:00:00.000Z' }, intervals: [] };
    const encrypted = await sealPrivateCalendarCache(crypto, { authority: root, accountKey: key, mainDevice: identity, calendarBinding: binding, cache, sequence: 1 }); await left.cloud.uploadCache(root, encrypted);
    let lost = true; const cloud = { ...left.cloud, async commitAuthority(...args) { const accepted = await left.cloud.commitAuthority(...args); if (lost) { lost = false; throw new Error('source acceptance reply interrupted'); } return accepted; } };
    const source = createPrivateCalendarSourceStorage({ ownerUserId: userId, assertOwner: uid => assert.equal(f.state.currentUser,uid), readProtected: f.readProtected, exclusive: f.exclusive, vault: f.vault });
    const authoritySync = createPrivateCalendarAuthoritySync({ userId, secrets: f.secrets, intents: f.changes, cloud });
    const controller = createPrivateCalendarSourceController({ userId, secrets: f.secrets, intents: f.changes, source, authoritySync });
    const subject = 'google-subject-is-not-a-firebase-uid'; await assert.rejects(() => controller.change({ googleSubject: subject }, root.digest), /interrupted/u);
    assert.equal((await source.read()).active, null); assert.ok((await source.read()).pending); assert.equal((await controller.resume()).kind,'ready');
    const selected = await f.secrets.authority(userId); assert.equal(selected.signed.body.revision,2); assert.equal(selected.signed.body.keyVersion,1);
    assert.equal(await left.cloud.readCache(selected),null); assert.equal((await source.read()).active.googleSubject,subject);
    assert.equal(JSON.stringify(await left.cloud.readHead()).includes(subject),false); assert.equal(JSON.stringify((await left.cloud.authorityPage(0)).authorities).includes(subject),false);
    await controller.change({ googleSubject:null },selected.digest); const disabled = await f.secrets.authority(userId); assert.equal(disabled.signed.body.revision,3); assert.equal((await source.read()).active.googleSubject,null);
    const retained = await f.secrets.currentKey(userId,disabled); assert.deepEqual(retained,key); retained.fill(0);
  } finally { key.fill(0); }
});

test('private Calendar actual Rules capture publishes bounded FreeBusy ciphertext and resumes a lost receipt without reacquiring Google data', async t => {
  const f = privateCalendarSetupFixture(t, { userId }); const left = client(userId); const outsider = client('other-calendar-user'); await f.controller(left.cloud).prepareAndResume();
  const source = createPrivateCalendarSourceStorage({ ownerUserId: userId, assertOwner: uid => assert.equal(f.state.currentUser, uid), readProtected: f.readProtected, exclusive: f.exclusive, vault: f.vault });
  const authoritySync = createPrivateCalendarAuthoritySync({ userId, secrets: f.secrets, intents: f.changes, cloud: left.cloud });
  const sourceController = createPrivateCalendarSourceController({ userId, secrets: f.secrets, source, intents: f.changes, authoritySync }); const subject = 'explicit-private-google-subject';
  await sourceController.change({ googleSubject: subject }, (await f.secrets.authority(userId)).digest);
  let queries = 0; let lost = true; const packets = [];
  const cloud = { ...left.cloud, async uploadCache(...args) { packets.push(JSON.stringify(args[1])); const result = await left.cloud.uploadCache(...args);
    if (lost) { lost = false; throw Object.assign(new Error('accepted snapshot reply lost'), { code: 'unavailable' }); } return result; } };
  const range = createCalendarQueryRange('2026-10-28', '2027-04-26', 'Asia/Tokyo'); const raw = [{ start: '2026-10-28T00:00:00.000Z', end: '2026-10-28T01:00:00.000Z' }];
  const port = { userId, secrets: f.secrets, source, cache: f.cache, cloud, crypto, assertOwner: () => assert.equal(f.state.currentUser, userId), now: () => Date.parse('2026-10-28T00:00:00.000Z'),
    queryGoogle: async (expected, query) => { assert.equal(expected, subject); assert.deepEqual(query, range); queries++; return raw; } };
  await assert.rejects(() => createPrivateCalendarCapture(port).capture({ range }), /snapshot reply lost/u); const generations = f.state.generations;
  const authority = await f.secrets.authority(userId); assert.equal((await f.cache.status(authority)).pending, true);
  assert.deepEqual(await createPrivateCalendarCapture(port).capture({ range, force: true }), { kind: 'published', sequence: 1 });
  assert.equal(queries, 1); assert.equal(f.state.generations, generations); assert.equal(packets[0], packets[1]);
  const fetched = await left.cloud.readCache(authority); const key = await f.secrets.currentKey(userId, authority);
  try { const body = await openPrivateCalendarCache(crypto, fetched, { authority, accountKey: key, calendarBinding: privateCalendarSourceBinding(authority) }); assert.deepEqual(body.intervals, raw); }
  finally { key.fill(0); }
  assert.equal(JSON.stringify(await left.cloud.readHead()).includes(subject), false); assert.equal(packets[0].includes(raw[0].start), false);
  await assert.rejects(getDocFromServer(doc(outsider.firestore, 'privateCalendars', userId)), { code: 'permission-denied' });
});

test('private Calendar actual Rules preserve a remote stop when a former main returns until it explicitly confirms the source again', async t => {
  const owner = 'private-runtime-owner'; const a = privateCalendarRuntimeFixture(t, { cloud: client(owner).cloud }); const b = privateCalendarRuntimeFixture(t, { cloud: client(owner).cloud });
  const initial = await a.devices.initializeFirstDevice(); const request = await b.devices.prepareConfirmedReference(initial.reference);
  await a.devices.approveConfirmedRequest(request.request); await b.devices.acceptApproval(); const left = a.open(); const right = b.open();
  await a.connect(left); await left.refreshData(); await a.devices.changeMain(request.deviceId, (await a.devices.read()).authorityDigest);
  await b.devices.synchronizeDevices(); await b.connect(right); await right.disableSource((await right.readSettings()).device.authorityDigest);
  await b.devices.changeMain(initial.deviceId, (await b.devices.read()).authorityDigest); const count = a.state.googleReads;
  assert.deepEqual(await left.refreshData(), { kind: 'sourceReview' }); assert.equal(a.state.googleReads, count); assert.equal(await left.readForPlan(), null);
  const expected = (await left.readSettings()).device.authorityDigest; await left.connectCurrentSource(a.googleSubject, expected);
  assert.notEqual((await left.readSettings()).device.authorityDigest, expected); assert.equal((await left.refreshData()).kind, 'published');
  assert.equal(a.state.googleReads, count + 1); assert.equal(JSON.stringify(await a.cloud.readHead()).includes(a.googleSubject), false);
});
