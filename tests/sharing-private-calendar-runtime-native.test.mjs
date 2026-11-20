import './helpers/typescript-loader.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { loadNativeModule } from './helpers/native-module.mjs';
import { assertSharedIdentifier } from '../src/features/sharing/identifier.ts';
import { GoogleAccountMismatchError } from '../src/features/google-sync/account-binding.ts';
import { withGoogleSyncOperation } from '../src/features/google-sync/operation-lock.ts';
import { privateCalendarDeadlineError } from '../src/features/sharing/private-calendar/sync-deadline.ts';

function fixture() {
  const state = { uid: null, subject: 'selected-google-subject', cloud: [], ports: [], callbacks: [], tokens: [], queries: [], consents: [], restores: 0, invalidations: [], authReads: 0 };
  const auth = { get currentUser() { return state.uid ? { uid: state.uid } : null; } }; const firestore = { name: 'named-authenticated-Firestore' };
  const services = { auth, firestore }; const native = { nativePrivateCalendarSecrets: { name: 'protected-secrets' } };
  for (const name of ['Source', 'AuthorityIntents', 'Cache']) native['nativePrivateCalendar' + name] = owner => ({ owner, kind: name });
  native.nativePrivatePlannerPreferences = owner => ({ owner, kind: 'PlannerPreferences', read: async () => null });
  native.nativePrivateDeliveryArchive = async owner => {
    state.deliveryOpenings = (state.deliveryOpenings ?? 0) + 1;
    await state.deliveryWait;
    if (owner !== state.uid) throw new Error('本人用Calendarのアカウントが変わりました。');
    return { owner };
  };
  const gateway = {
    getCurrentGoogleCalendarAccount: async () => ({ subject: state.subject, label: 'Synthetic label' }),
    restorePrivateGoogleCalendarAccount: async () => { state.restores++; return { subject: state.subject, label: 'Synthetic label' }; },
    authorizePrivateGoogleCalendarSource: async subject => { state.consents.push(subject); },
    getGoogleCalendarAccessToken: async subject => { assert.equal(subject, state.subject); state.tokens.push(subject); return 'synthetic-test-token'; },
    getCurrentGoogleSubject: async () => state.subject,
  };
  const module = loadNativeModule('src/platform/sharing/private-calendar-runtime.ts', {
    'firebase/auth': { onAuthStateChanged: (value, callback) => { assert.equal(value, auth); state.callbacks.push(callback); return () => {}; } },
    './firebase-services': { getSharingServices: () => { state.authReads++; return services; } },
    './private-calendar-devices': { openPrivateCalendarDevices: owner => ({ owner }) },
    './private-calendar-cloud': { createPrivateCalendarCloud: (db, owner, current, _crypto, delivery) => {
      assert.equal(db, firestore); assert.equal(current(), owner); state.cloud.push(owner); return { owner, delivery };
    } },
    './private-delivery': { createPrivateDelivery: ({ archive }) => ({ prepare: async () => archive.owner }) },
    '../../features/sharing/crypto': { signSharedDocument: () => 'synthetic-signature' },
    './private-planner-cloud': { createPrivatePlannerCloud: (db, owner, current) => { assert.equal(db, firestore); assert.equal(current(), owner); return { owner, kind: 'PrivatePlannerCloud' }; } },
    '../../features/sharing/private-planner/preference-sync': { createPrivatePreferenceSync: port => { assert.equal(port.ownerUserId, state.uid); return { port, kind: 'PrivatePreferenceSync' }; } },
    './native-private-calendar-crypto': { nativePrivateCalendarCrypto: {} }, './private-calendar-secrets': native,
    '../../features/sharing/private-calendar/authority-sync': { createPrivateCalendarAuthoritySync: port => port },
    '../../features/sharing/private-calendar/source-controller': { createPrivateCalendarSourceController: port => port },
    '../../features/sharing/private-calendar/runtime': { createPrivateCalendarRuntime: port => { state.ports.push(port); return { port, invalidatePlaintext: () => state.invalidations.push(port.userId) }; } },
    '../../features/google-sync/calendar-availability': { getDeviceTimeZone: () => 'Asia/Tokyo' },
    '../../features/google-sync/operation-lock': { withGoogleSyncOperation },
    '../google-tasks/google-calendar-freebusy-client': { createCalendarFreeBusyClient: () => ({ query: async (token, range, options) => { state.queries.push({ token, range, options }); return state.busy ?? []; } }) },
    '../google-tasks/google-sign-in-gateway': gateway, '../../features/google-sync/account-binding': { GoogleAccountMismatchError }, '../../features/sharing/identifier': { assertSharedIdentifier },
    '../../features/sharing/private-calendar/sync-deadline': { privateCalendarDeadlineError },
  });
  return { module, state, gateway, services, auth };
}

test('private Calendar Native runtime is lazy one per authenticated UID and invalidates plaintext on logout without deleting retained keys', async () => {
  const f = fixture(); assert.equal(f.state.authReads, 0); assert.equal(f.state.ports.length, 0);
  assert.throws(() => f.module.openPrivateCalendarRuntime('owner-a'), /アカウント/u); assert.equal(f.state.ports.length, 0);
  f.state.uid = 'owner-a'; const first = f.module.openPrivateCalendarRuntime('owner-a'); assert.equal(f.module.openPrivateCalendarRuntime('owner-a'), first);
  f.state.uid = 'owner-b'; f.state.callbacks[0]({ uid: 'owner-b' }); assert.deepEqual(f.state.invalidations, ['owner-a']);
  assert.throws(() => first.port.assertOwner(), /アカウント/u); const other = f.module.openPrivateCalendarRuntime('owner-b'); assert.notEqual(other, first);
  f.state.uid = null; f.state.callbacks[0](null); assert.ok(f.state.invalidations.includes('owner-b')); assert.equal(f.state.ports.length, 2);
  assert.deepEqual(f.state.cloud, ['owner-a', 'owner-b']); assert.deepEqual(f.state.tokens, []); assert.equal(f.state.restores, 0);
});

test('private delivery initialization retries after returning to the same account without restarting the app', async t => {
  const flag = 'EXPO_PUBLIC_SHARING_EPHEMERAL_DELIVERY';
  const previous = process.env[flag];
  process.env[flag] = '1';
  t.after(() => { if (previous === undefined) delete process.env[flag]; else process.env[flag] = previous; });
  const f = fixture();
  f.state.uid = 'owner-a';
  const runtime = f.module.openPrivateCalendarRuntime(f.state.uid);
  let release;
  f.state.deliveryWait = new Promise(resolve => { release = resolve; });
  const prepare = () => runtime.port.cloud.delivery.prepare();
  const first = prepare();
  await new Promise(setImmediate);
  assert.equal(f.state.deliveryOpenings, 1);
  f.state.uid = null;
  f.state.callbacks[0](null);
  release();
  await assert.rejects(first, /アカウント/u);
  f.state.uid = 'owner-a';
  assert.equal(f.module.openPrivateCalendarRuntime(f.state.uid), runtime);
  assert.deepEqual(await Promise.all([prepare(), prepare()]), ['owner-a', 'owner-a']);
  assert.equal(f.state.deliveryOpenings, 2, 'both callers share the new initialization');
});

test('private Calendar Native acquisition refuses an expired Google mutex wait before requesting a token', async t => {
  let now = 1_000; t.mock.method(Date, 'now', () => now); const f = fixture(); f.state.uid = 'owner-a'; const { port } = f.module.openPrivateCalendarRuntime(f.state.uid);
  let release; let enter; const gate = new Promise(done => { release = done; }); const entered = new Promise(done => { enter = done; });
  const held = withGoogleSyncOperation(async () => { enter(); await gate; }); await entered;
  const request = port.queryGoogle(f.state.subject, {}, { deadline: 1_100 }); const failed = assert.rejects(() => request, error => error.code === 'deadline-exceeded');
  now = 1_100; release(); await held; await failed; assert.deepEqual(f.state.tokens, []); assert.deepEqual(f.state.queries, []);
});

test('private Calendar Native acquisition passes only its remaining total budget and bounded intervals after token refresh', async t => {
  let now = 1_000; t.mock.method(Date, 'now', () => now); const f = fixture(); f.state.uid = 'owner-a'; const { port } = f.module.openPrivateCalendarRuntime(f.state.uid);
  f.gateway.getGoogleCalendarAccessToken = async () => { now += 2_000; return 'synthetic-token'; };
  await port.queryGoogle(f.state.subject, { synthetic: true }, { deadline: 6_000 });
  assert.deepEqual(f.state.queries[0].options, { timeoutMs: 3_000, maxIntervals: 100_000 }); assert.equal(f.state.uid, 'owner-a');
});

test('private Calendar Native acquisition refuses an already cancelled operation before retrieving any Google token', async () => {
  const f = fixture(); f.state.uid = 'owner-a'; const { port } = f.module.openPrivateCalendarRuntime(f.state.uid); const controller = new AbortController(); controller.abort();
  await assert.rejects(() => port.queryGoogle(f.state.subject, {}, { signal: controller.signal }), error => error.code === 'deadline-exceeded');
  assert.deepEqual(f.state.tokens, []); assert.deepEqual(f.state.queries, []);
});

test('private Calendar Native acquisition serializes with the existing Google worker and rechecks Google and Firebase identities after transport', async () => {
  const f = fixture(); f.state.uid = 'owner-a'; const { port } = f.module.openPrivateCalendarRuntime(f.state.uid); const range = { timeMin: 'synthetic-start', timeMax: 'synthetic-end' };
  let release; let enter; const gate = new Promise(done => { release = done; }); const entered = new Promise(done => { enter = done; });
  const held = withGoogleSyncOperation(async () => { enter(); await gate; }); await entered;
  const request = port.queryGoogle(f.state.subject, range); await new Promise(setImmediate); assert.equal(f.state.tokens.length, 0); release(); await held; await request;
  assert.equal(f.state.tokens.length, 1); assert.equal(f.state.queries.length, 1); assert.deepEqual(f.state.queries[0].range, range);
  f.gateway.getCurrentGoogleSubject = async () => 'other-google-subject'; await assert.rejects(() => port.queryGoogle(f.state.subject, range), GoogleAccountMismatchError);
  f.gateway.getCurrentGoogleSubject = async () => { f.state.uid = 'owner-b'; return f.state.subject; };
  await assert.rejects(() => port.queryGoogle(f.state.subject, range), /アカウント/u);
});

test('private Calendar Native identity checks and explicit source consent never request Tasks permission or change the Firebase session', async () => {
  const f = fixture(); f.state.uid = 'owner-a'; const { port } = f.module.openPrivateCalendarRuntime(f.state.uid);
  assert.equal((await port.currentGoogleAccount()).subject, f.state.subject); assert.equal(f.state.restores, 0); assert.deepEqual(f.state.consents, []);
  await port.restoreGoogleAccount(); assert.equal(f.state.restores, 1); await port.authorizeGoogleSource(f.state.subject); assert.deepEqual(f.state.consents, [f.state.subject]);
  assert.equal(f.state.uid, 'owner-a'); assert.deepEqual(f.state.tokens, []); assert.deepEqual(f.state.queries, []);
});
