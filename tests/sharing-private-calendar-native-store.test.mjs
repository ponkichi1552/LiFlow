import './helpers/typescript-loader.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { loadNativeModule } from './helpers/native-module.mjs';
import { createDatabase } from './helpers/sqlite.mjs';
import * as vault from '../src/features/sharing/secure-vault.ts';
import * as secrets from '../src/features/sharing/private-calendar/secret-store.ts';
import * as storage from '../src/platform/storage/private-calendar-store.ts';
import * as cacheStorage from '../src/platform/storage/private-calendar-cache.ts';
import * as rootSetupStorage from '../src/platform/storage/private-calendar-root-setup.ts';
import * as authorityIntentStorage from '../src/platform/storage/private-calendar-authority-intents.ts';
import * as keyOutboxStorage from '../src/platform/storage/private-calendar-key-outbox.ts';
import * as pairingStorage from '../src/platform/storage/private-calendar-pairing.ts';
import * as sourceStorage from '../src/platform/storage/private-calendar-source.ts';
import * as connectionStorage from '../src/platform/storage/private-calendar-connections.ts';
import * as preferenceStorage from '../src/features/sharing/private-planner/preference-store.ts';
import { privateCalendarDatabaseFilename } from '../src/features/sharing/private-calendar/database-name.ts';
import { sharingTestCrypto as crypto } from './helpers/sharing-crypto.mjs';
import { createHash } from 'node:crypto';
import { auditPrivateCalendarStoredState } from '../src/features/sharing/development/private-calendar-store-audit.ts';
import { createPrivateCalendarRoot } from '../src/features/sharing/private-calendar/authority.ts';
import { sealPrivateCalendarCache } from '../src/features/sharing/private-calendar/cache-crypto.ts';
import { auditPrivateCalendarCacheState } from '../src/features/sharing/development/private-calendar-cache-audit.ts';
import { PRIVATE_CALENDAR_STORE_QA_USER_ID } from '../src/features/sharing/development/private-calendar-store-audit.ts';
import { createPrivateCalendarFirstDeviceSetup } from '../src/features/sharing/private-calendar/first-device-setup.ts';
import { privateCalendarPairingReference } from '../src/features/sharing/private-calendar/pairing.ts';
import { privateCalendarCloudFields } from '../src/features/sharing/private-calendar/cloud-contract.ts';
import { privateCalendarMemoryCloud } from './helpers/private-calendar-cloud.mjs';
import { createPrivateCalendarSourceController } from '../src/features/sharing/private-calendar/source-controller.ts';
import { createPrivateCalendarAuthoritySync } from '../src/features/sharing/private-calendar/authority-sync.ts';

function fixture(values = new Map([['jp.jphacks.tkb2633.sharing:original', 'preserved']])) {
  const calls = []; const opens = []; const databases = [];
  let authReads = 0; let currentUser = null;
  const module = loadNativeModule('src/platform/sharing/private-calendar-secrets.ts', {
    'expo-secure-store': { AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY: 'device-only-after-unlock',
      getItemAsync: async (key, options) => { calls.push({ kind: 'get', options }); return values.get(`${options.keychainService}:${key}`) ?? null; },
      setItemAsync: async (key, value, options) => { calls.push({ kind: 'set', options }); values.set(`${options.keychainService}:${key}`, value); },
      deleteItemAsync: async (key, options) => { calls.push({ kind: 'remove', options }); values.delete(`${options.keychainService}:${key}`); } },
    '../../features/sharing/secure-vault.ts': vault,
    '../../features/sharing/private-calendar/secret-store.ts': secrets,
    '../storage/private-calendar-store.ts': storage,
    '../storage/private-calendar-cache.ts': cacheStorage,
    '../storage/private-calendar-root-setup.ts': rootSetupStorage,
    '../storage/private-calendar-authority-intents.ts': authorityIntentStorage,
    '../storage/private-calendar-key-outbox.ts': keyOutboxStorage,
    '../storage/private-calendar-pairing.ts': pairingStorage,
    '../storage/private-calendar-source.ts': sourceStorage,
    '../storage/private-calendar-connections.ts': connectionStorage,
    '../../features/sharing/private-planner/preference-store.ts': preferenceStorage,
    './firebase-services.ts': { getSharingServices: () => { authReads++; return { auth: { currentUser } }; } },
    './native-private-calendar-crypto': { nativePrivateCalendarCrypto: crypto },
    './database-location': { openPrivateCalendarDatabase: async (ownerUserId, development) => {
      const h = createDatabase(); databases.push(h); const descriptor = { kind: 'private-calendar', ownerUserId, development,
        filename: privateCalendarDatabaseFilename(ownerUserId, development), database: h.database }; opens.push(descriptor); return descriptor;
    } },
  });
  return { module, values, calls, opens, authReads: () => authReads, auth: uid => { currentUser = uid ? { uid } : null; }, close: () => databases.forEach(h => h.connection.close()) };
}

test('private planner Native preferences reuse protected owner storage without creating Calendar keys or writing group data', async t => {
  const f = fixture(); t.after(f.close); assert.equal(f.authReads(), 0); assert.equal(f.opens.length, 0);
  assert.throws(() => f.module.nativePrivatePlannerPreferences('private-owner'), /アカウント/u);
  f.auth('private-owner'); const own = f.module.nativePrivatePlannerPreferences('private-owner'); assert.equal(await own.read(), null);
  assert.equal(await f.module.nativePrivateCalendarSecrets.publicState('private-owner'), null);
  const saved = await own.save(0, { timeZone: 'Asia/Tokyo', restDays: [2], loadLimits: { heavyDailyLimit: 1, normalDailyLimit: 2 }, allowedBands: [] });
  assert.deepEqual(await own.read(), saved); assert.equal(f.opens.length, 1);
  assert.ok(f.calls.every(call => call.options.keychainService === 'jp.jphacks.tkb2633.private-calendar'));
  assert.equal(f.values.get('jp.jphacks.tkb2633.sharing:original'), 'preserved');
  f.auth('another'); await assert.rejects(() => own.read(), /アカウント/u);
  await assert.rejects(() => own.save(1, { timeZone: 'UTC', restDays: [], loadLimits: { heavyDailyLimit: 1, normalDailyLimit: 2 }, allowedBands: [] }), /アカウント/u);
  assert.equal(f.opens.length, 1);
});

test('private Calendar Native secret adapter stays lazy, uses its own Keychain service and only opens the authenticated owner database', async t => {
  const f = fixture(); t.after(f.close); assert.equal(f.authReads(), 0); assert.equal(f.calls.length, 0); assert.equal(f.opens.length, 0);
  await assert.rejects(() => f.module.nativePrivateCalendarSecrets.identity('private-owner'), /アカウント/u); assert.equal(f.opens.length, 0);
  f.auth('private-owner'); const identity = await f.module.nativePrivateCalendarSecrets.identity('private-owner');
  assert.equal((await f.module.nativePrivateCalendarSecrets.identity('private-owner')).deviceId, identity.deviceId); assert.equal(f.opens.length, 1);
  assert.equal(f.opens[0].development, false); assert.equal(f.opens[0].ownerUserId, 'private-owner');
  assert.ok(f.calls.every(call => call.options.keychainService === 'jp.jphacks.tkb2633.private-calendar' && call.options.keychainAccessible === 'device-only-after-unlock'));
  const count = f.calls.length; await assert.rejects(() => f.module.nativePrivateCalendarSecrets.identity('another-owner'), /アカウント/u);
  assert.equal(f.calls.length, count); assert.equal(f.opens.length, 1); assert.equal(f.values.get('jp.jphacks.tkb2633.sharing:original'), 'preserved');
});

test('private Calendar Native source association uses the same protected UID lock without storing subjects in SQLite or touching a group vault', async t => {
  const f = fixture(); t.after(f.close); assert.throws(() => f.module.nativePrivateCalendarSource('private-owner'), /アカウント/u); assert.equal(f.opens.length, 0);
  f.auth('private-owner'); const cloud = privateCalendarMemoryCloud().cloud; const secrets = f.module.nativePrivateCalendarSecrets;
  await createPrivateCalendarFirstDeviceSetup({ userId: 'private-owner', secrets, intents: f.module.nativePrivateCalendarRootSetup('private-owner'), cloud }).prepareAndResume();
  const source = f.module.nativePrivateCalendarSource('private-owner'); const intents = f.module.nativePrivateCalendarAuthorityIntents('private-owner');
  const authoritySync = createPrivateCalendarAuthoritySync({ userId: 'private-owner', secrets, intents, cloud });
  const controller = createPrivateCalendarSourceController({ userId: 'private-owner', secrets, source, intents, authoritySync });
  assert.equal(await source.read(), null); const current = await secrets.authority('private-owner');
  await controller.change({ googleSubject: 'explicit-distinct-google-subject' }, current.digest);
  assert.equal((await source.read()).active.googleSubject, 'explicit-distinct-google-subject'); assert.equal(f.opens.length, 1);
  assert.ok(f.calls.every(call => call.options.keychainService === 'jp.jphacks.tkb2633.private-calendar'));
  const tables = await f.opens[0].database.getAllAsync('SELECT authority_json FROM private_calendar_authority_intents'); assert.equal(JSON.stringify(tables).includes('explicit-distinct-google-subject'), false);
  const before = f.calls.length; f.auth('foreign-owner'); await assert.rejects(() => source.read(), /アカウント/u); assert.equal(f.calls.length, before);
  f.auth('private-owner'); assert.equal((await source.read()).active.googleSubject, 'explicit-distinct-google-subject'); assert.equal(f.values.get('jp.jphacks.tkb2633.sharing:original'), 'preserved');
});

test('private Calendar development key storage is release-blocked and uses a separate QA service without initializing Firebase', async t => {
  const before = globalThis.__DEV__; const f = fixture(); t.after(f.close);
  try {
    globalThis.__DEV__ = false; assert.throws(() => f.module.developmentPrivateCalendarSecrets(), /開発/u);
    assert.throws(() => f.module.developmentPrivateCalendarCache('development-calendar-private-store'), /開発/u);
    assert.throws(() => f.module.developmentPrivateCalendarRootSetup('development-calendar-private-store'), /開発/u);
    assert.throws(() => f.module.developmentPrivateCalendarAuthorityIntents('development-calendar-private-store'), /開発/u);
    assert.throws(() => f.module.developmentPrivateCalendarKeyOutbox('development-calendar-private-store'), /開発/u);
    assert.throws(() => f.module.developmentPrivateCalendarPairing('development-calendar-private-store'), /開発/u);
    assert.throws(() => f.module.developmentPrivateCalendarSource('development-calendar-private-store'), /開発/u);
    assert.equal(f.calls.length, 0); assert.equal(f.opens.length, 0); assert.equal(f.authReads(), 0);
    globalThis.__DEV__ = true; const qa = f.module.developmentPrivateCalendarSecrets();
    await assert.rejects(() => qa.identity('private-owner'), /アカウント/u); assert.equal(f.opens.length, 0);
    await qa.identity('development-calendar-private-store'); assert.equal(f.authReads(), 0); assert.equal(f.opens.length, 1);
    assert.equal(f.opens[0].development, true);
    const qaCache = f.module.developmentPrivateCalendarCache('development-calendar-private-store');
    assert.equal(typeof qaCache.save, 'function'); assert.equal(f.authReads(), 0);
    assert.ok(f.calls.every(call => call.options.keychainService === 'jp.jphacks.tkb2633.private-calendar.qa'));
    assert.equal(f.values.get('jp.jphacks.tkb2633.sharing:original'), 'preserved');
  } finally { globalThis.__DEV__ = before; }
});

test('private Calendar persisted Native audit recovers the same synthetic keys and public proof in a reconstructed runtime without touching an account', async t => {
  const before = globalThis.__DEV__; globalThis.__DEV__ = true;
  const a = fixture(); t.after(a.close);
  const accelerated = { ...crypto, digestSha256: async bytes => new Uint8Array(createHash('sha256').update(bytes).digest()) };
  try {
    const first = await auditPrivateCalendarStoredState({ development: true, crypto: accelerated, store: a.module.developmentPrivateCalendarSecrets() });
    const b = fixture(a.values); t.after(b.close);
    const second = await auditPrivateCalendarStoredState({ development: true, crypto: accelerated, store: b.module.developmentPrivateCalendarSecrets() });
    assert.equal(first.mode, 'created'); assert.equal(second.mode, 'restored'); assert.equal(second.checks.length, 4);
    assert.equal(second.deviceId, first.deviceId); assert.equal(second.authorityDigest, first.authorityDigest); assert.equal(second.storageProof, first.storageProof);
    assert.deepEqual(Object.keys(second).sort(), ['authorityDigest', 'checks', 'deviceId', 'mode', 'storageProof']);
    assert.equal(a.authReads(), 0); assert.equal(b.authReads(), 0); assert.equal(a.values.get('jp.jphacks.tkb2633.sharing:original'), 'preserved');
  } finally { globalThis.__DEV__ = before; }
});

test('private Calendar persisted audit rejects release execution before accessing any key or database', async () => {
  let touched = false; const store = new Proxy({}, { get() { touched = true; throw new Error('no key access'); } });
  await assert.rejects(() => auditPrivateCalendarStoredState({ development: false, crypto, store }), /開発/u); assert.equal(touched, false);
});

test('private Calendar Native cache uses the same protected vault and transaction lock and never writes plaintext or bypasses missing trust', async t => {
  const f = fixture(); t.after(f.close); f.auth('private-owner');
  const store = f.module.nativePrivateCalendarSecrets; const identity = await store.identity('private-owner');
  const root = await createPrivateCalendarRoot(crypto, 'private-owner', identity);
  const ledger = f.module.nativePrivateCalendarCache('private-owner');
  const cache = { ownerUserId: 'private-owner', accountGeneration: root.signed.body.accountGeneration, mainDeviceId: identity.deviceId,
    mainRevision: 1, calendarBinding: 'native-private-binding', timeZone: 'Asia/Tokyo', fetchedAt: '2026-10-28T00:00:00Z',
    coverage: { start: '2026-10-28T00:00:00Z', end: '2026-10-29T00:00:00Z' }, intervals: [] };
  const temporaryKey = new Uint8Array(32).fill(7);
  const untrusted = await sealPrivateCalendarCache(crypto, { cache, authority: root, calendarBinding: cache.calendarBinding, accountKey: temporaryKey, mainDevice: identity, sequence: 1 });
  const input = { authority: root, calendarBinding: cache.calendarBinding, accountKey: temporaryKey };
  await assert.rejects(() => ledger.save(untrusted, { ...input, origin: 'local' }), /信頼/u);
  await store.confirmTrust('private-owner', root, 'firstDeviceSetup'); const key = await store.createCurrentKey('private-owner', root);
  const encrypted = await sealPrivateCalendarCache(crypto, { cache, authority: root, calendarBinding: cache.calendarBinding, accountKey: key, mainDevice: identity, sequence: 1 });
  await ledger.save(encrypted, { ...input, accountKey: key, origin: 'local' });
  assert.equal((await ledger.read({ ...input, accountKey: key })).calendarBinding, cache.calendarBinding);
  assert.deepEqual((await ledger.pending(root, 1)).encrypted, encrypted); assert.equal(f.opens.length, 1);
  const before = f.calls.length; f.auth('another-owner');
  await assert.rejects(() => ledger.read({ ...input, accountKey: key }), /アカウント/u);
  assert.throws(() => f.module.nativePrivateCalendarCache('private-owner'), /アカウント/u);
  assert.equal(f.calls.length, before); assert.equal(f.values.get('jp.jphacks.tkb2633.sharing:original'), 'preserved'); key.fill(0);
});

test('private Calendar Native ciphertext audit persists twenty thousand intervals and resumes the exact previous snapshot without accessing an account', async t => {
  const before = globalThis.__DEV__; globalThis.__DEV__ = true; const f = fixture(); t.after(f.close);
  try {
    const accelerated = { ...crypto, digestSha256: async bytes => new Uint8Array(createHash('sha256').update(bytes).digest()) };
    const store = f.module.developmentPrivateCalendarSecrets(); const cache = f.module.developmentPrivateCalendarCache(PRIVATE_CALENDAR_STORE_QA_USER_ID);
    const options = { development: true, crypto: accelerated, store, cache };
    const first = await auditPrivateCalendarCacheState(options); const restored = await auditPrivateCalendarCacheState(options);
    assert.equal(first.checks.length, 8); assert.equal(restored.checks.length, 8);
    assert.equal(first.mode, 'created'); assert.equal(restored.mode, 'restored'); assert.equal(first.sequence, 1); assert.equal(restored.sequence, 2);
    assert.equal(first.chunkCount, 22); assert.equal(restored.chunkCount, 22); assert.equal(restored.storageProof, first.storageProof);
    assert.equal(f.opens.length, 1); assert.equal(f.authReads(), 0);
    for (const text of ['signingSecretKey', 'agreementSecretKey', 'intervals', 'development-private-calendar-cache-v1']) assert.equal(JSON.stringify(restored).includes(text), false);
    const unopened = new Proxy({}, { get() { throw new Error('must not access any store'); } });
    await assert.rejects(() => auditPrivateCalendarCacheState({ ...options, development: false, store: unopened, cache: unopened }), /開発/u);
    assert.equal(f.values.get('jp.jphacks.tkb2633.sharing:original'), 'preserved');
  } finally { globalThis.__DEV__ = before; }
});

test('private Calendar Native first-device setup shares its own protected vault and SQL connection and requires the authenticated owner', async t => {
  const f = fixture(); t.after(f.close);
  assert.throws(() => f.module.nativePrivateCalendarRootSetup('private-owner'), /アカウント/u); assert.equal(f.opens.length, 0); assert.equal(f.calls.length, 0);
  f.auth('private-owner'); const roots = f.module.nativePrivateCalendarRootSetup('private-owner'); const secrets = f.module.nativePrivateCalendarSecrets;
  let received; const cloud = { async createRoot(root) { received = root; assert.equal(await secrets.authority('private-owner'), null); return { head: privateCalendarCloudFields(root) }; } };
  const setup = createPrivateCalendarFirstDeviceSetup({ userId: 'private-owner', secrets, intents: roots, cloud });
  const result = await setup.prepareAndResume(); assert.equal(result.rootDigest, received.digest); assert.equal((await roots.read()).status, 'ready');
  assert.equal(f.opens.length, 1); assert.equal(f.opens[0].development, false);
  assert.ok(f.calls.every(call => call.options.keychainService === 'jp.jphacks.tkb2633.private-calendar'));
  const count = f.calls.length; f.auth('another-owner'); await assert.rejects(() => setup.resume(), /アカウント/u); assert.equal(f.calls.length, count);
  assert.equal(f.values.get('jp.jphacks.tkb2633.sharing:original'), 'preserved');
});

test('private Calendar Native authority intents reuse the protected owner lock without committing a draft or touching another user', async t => {
  const f = fixture(); t.after(f.close); assert.throws(() => f.module.nativePrivateCalendarAuthorityIntents('private-owner'), /アカウント/u);
  assert.equal(f.opens.length, 0); f.auth('private-owner'); const secrets = f.module.nativePrivateCalendarSecrets;
  const roots = f.module.nativePrivateCalendarRootSetup('private-owner'); let accepted;
  await createPrivateCalendarFirstDeviceSetup({ userId: 'private-owner', secrets, intents: roots,
    cloud: { async createRoot(root) { accepted = root; return { head: privateCalendarCloudFields(root) }; } } }).prepareAndResume();
  const identity = await secrets.identity('private-owner'); const { mainDeviceId, devices } = accepted.signed.body;
  const changes = f.module.nativePrivateCalendarAuthorityIntents('private-owner');
  const pending = await changes.prepare({ mainDeviceId, devices, keyVersion: 2 }, identity);
  assert.equal((await secrets.authority('private-owner')).digest, accepted.digest); assert.equal((await changes.readPending()).digest, pending.digest);
  assert.equal(f.opens.length, 1); assert.ok(f.calls.every(call => call.options.keychainService === 'jp.jphacks.tkb2633.private-calendar'));
  const calls = f.calls.length; f.auth('another-owner'); await assert.rejects(() => changes.readPending(), /アカウント/u); assert.equal(f.calls.length, calls);
  assert.equal(f.values.get('jp.jphacks.tkb2633.sharing:original'), 'preserved');
});

test('private Calendar Native key outbox remains lazy and uses only the authenticated protected key store and SQLite lock', async t => {
  const f = fixture(); t.after(f.close); assert.throws(() => f.module.nativePrivateCalendarKeyOutbox('private-owner'), /アカウント/u); assert.equal(f.opens.length, 0);
  f.auth('private-owner'); const secrets = f.module.nativePrivateCalendarSecrets; let authority;
  await createPrivateCalendarFirstDeviceSetup({ userId: 'private-owner', secrets, intents: f.module.nativePrivateCalendarRootSetup('private-owner'),
    cloud: { async createRoot(root) { authority = root; return { head: privateCalendarCloudFields(root) }; } } }).prepareAndResume();
  const identity = await secrets.identity('private-owner'); const key = await secrets.currentKey('private-owner', authority); const outbox = f.module.nativePrivateCalendarKeyOutbox('private-owner');
  const first = await outbox.prepare(authority, identity.deviceId, identity, key); const again = await outbox.prepare(authority, identity.deviceId, identity, key);
  assert.equal(first.envelopeDigest, again.envelopeDigest); assert.equal(f.opens.length, 1); assert.equal((await outbox.status(authority)).pending, 1);
  assert.ok(f.calls.every(call => call.options.keychainService === 'jp.jphacks.tkb2633.private-calendar'));
  const count = f.calls.length; f.auth('another-owner'); await assert.rejects(() => outbox.pending(authority, 0), /アカウント/u); assert.equal(f.calls.length, count);
  assert.equal(f.values.get('jp.jphacks.tkb2633.sharing:original'), 'preserved'); key.fill(0);
});

test('private Calendar Native pairing protects the confirmed reference separately and refuses release or other-account access', async t => {
  const owner = fixture(); t.after(owner.close); owner.auth('private-owner'); let authority;
  await createPrivateCalendarFirstDeviceSetup({ userId: 'private-owner', secrets: owner.module.nativePrivateCalendarSecrets, intents: owner.module.nativePrivateCalendarRootSetup('private-owner'),
    cloud: { async createRoot(root) { authority = root; return { head: privateCalendarCloudFields(root) }; } } }).prepareAndResume();
  const f = fixture(); t.after(f.close); assert.throws(() => f.module.nativePrivateCalendarPairing('private-owner'), /アカウント/u); assert.equal(f.opens.length, 0);
  f.auth('private-owner'); const pairing = f.module.nativePrivateCalendarPairing('private-owner'); assert.equal(f.calls.length, 0); assert.equal(f.opens.length, 0);
  assert.equal(await pairing.read(), null); const identity = await f.module.nativePrivateCalendarSecrets.identity('private-owner');
  const reference = privateCalendarPairingReference(authority); const prepared = await pairing.prepare(reference, identity); assert.equal(prepared.status, 'prepared');
  assert.equal((await f.module.nativePrivateCalendarSecrets.authority('private-owner')), null); assert.equal(f.opens.length, 1);
  assert.deepEqual(await pairing.read(), prepared); assert.ok(f.calls.every(call => call.options.keychainService === 'jp.jphacks.tkb2633.private-calendar'));
  const count = f.calls.length; f.auth('another-owner'); await assert.rejects(() => pairing.read(), /アカウント/u); assert.equal(f.calls.length, count);
  assert.equal(f.values.get('jp.jphacks.tkb2633.sharing:original'), 'preserved');
});
