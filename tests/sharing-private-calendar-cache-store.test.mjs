import './helpers/typescript-loader.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createDatabase } from './helpers/sqlite.mjs';
import { sharingTestCrypto as crypto } from './helpers/sharing-crypto.mjs';
import { createDeviceIdentity, sharedDocumentDigest } from '../src/features/sharing/crypto.ts';
import { createPrivateCalendarRoot, advancePrivateCalendarAuthority } from '../src/features/sharing/private-calendar/authority.ts';
import { createPrivateCalendarAccountKey } from '../src/features/sharing/private-calendar/key-envelope.ts';
import { sealPrivateCalendarCache } from '../src/features/sharing/private-calendar/cache-crypto.ts';
import { privateCalendarDatabaseFilename } from '../src/features/sharing/private-calendar/database-name.ts';
import { createPrivateCalendarExclusiveStorage } from '../src/platform/storage/private-calendar-store.ts';
import { createPrivateCalendarCacheStorage } from '../src/platform/storage/private-calendar-cache.ts';

const clone = value => JSON.parse(JSON.stringify(value));
async function fixture(t, options = {}) {
  const ownerUserId = 'private-cache-owner'; const main = await createDeviceIdentity(crypto);
  const authority = await createPrivateCalendarRoot(crypto, ownerUserId, main); const accountKey = await createPrivateCalendarAccountKey(crypto);
  const calendarBinding = 'private-google-subject-binding';
  const state = { user: ownerUserId, authority, localDevice: main.deviceId, ownerHook: null, authorityHook: null };
  const cache = { ownerUserId, accountGeneration: authority.signed.body.accountGeneration, mainDeviceId: main.deviceId, mainRevision: 1,
    calendarBinding, timeZone: 'Asia/Tokyo', fetchedAt: '2026-10-28T00:00:00.000Z',
    coverage: { start: '2026-10-28T00:00:00.000Z', end: '2026-11-28T00:00:00.000Z' },
    intervals: [{ start: '2026-10-28T01:00:00.000Z', end: '2026-10-28T02:00:00.000Z' }] };
  const connect = path => {
    const raw = createDatabase(path); t.after(() => raw.connection.close());
    const database = options.decorate ? options.decorate(raw.database, state) : raw.database;
    const storage = createPrivateCalendarExclusiveStorage({ kind: 'private-calendar', ownerUserId, filename: privateCalendarDatabaseFilename(ownerUserId, true), development: true, database });
    const assertOwner = async expected => { if (state.ownerHook) await state.ownerHook(); assert.equal(state.user, expected, 'account changed'); };
    const ledger = createPrivateCalendarCacheStorage({ ownerUserId, crypto: options.crypto ?? crypto, exclusive: storage.exclusive, assertOwner,
      async assertAuthority(expected, requireMain) {
        if (state.authorityHook) await state.authorityHook();
        assert.equal(state.authority.digest, expected.digest, 'authority changed');
        assert.ok(expected.signed.body.devices.some(device => device.deviceId === state.localDevice), 'device revoked');
        if (requireMain) assert.equal(state.localDevice, expected.signed.body.mainDeviceId, 'main device required');
      } });
    return { ...raw, database, storage, ledger };
  };
  const db = connect(options.path); const input = changes => ({ authority: state.authority, calendarBinding, accountKey, ...changes });
  const seal = (sequence = 1, changes = {}) => sealPrivateCalendarCache(crypto, { cache: { ...cache, mainRevision: state.authority.signed.body.revision,
    mainDeviceId: state.authority.signed.body.mainDeviceId }, authority: state.authority, calendarBinding, accountKey, mainDevice: main, sequence, ...changes });
  const row = () => db.connection.prepare('SELECT * FROM private_calendar_cache').get();
  return { ...db, state, cache, input, seal, row, connect, main, accountKey, authority, calendarBinding };
}

test('private Calendar deferred outbox checks read metadata without transferring the entire ciphertext', async t => {
  let bodyReads = 0;
  const f = await fixture(t, { decorate: database => ({ ...database, async getFirstAsync(sql, ...params) {
    const row = await database.getFirstAsync(sql, ...params);
    if (row && typeof row.encrypted_json === 'string') bodyReads++;
    return row;
  } }) });
  const encrypted = await f.seal(); await f.ledger.save(encrypted, f.input({ origin: 'local' }));
  await f.ledger.fail(f.authority, sharedDocumentDigest(encrypted.manifest), 1000, 'offline', 0);
  bodyReads = 0;
  for (let n = 0; n < 20; n++) assert.equal(await f.ledger.pending(f.authority, 1001), null);
  assert.equal(bodyReads, 0);
  assert.deepEqual((await f.ledger.pending(f.authority, 1001, { force: true })).encrypted, encrypted);
});

test('private Calendar ciphertext ledger atomically saves one complete cache with its cursor and outbox, and survives reopening SQLite', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'liflow-private-cache-')); t.after(() => rmSync(directory, { recursive: true, force: true }));
  const f = await fixture(t, { path: join(directory, 'cache.db') }); const encrypted = await f.seal();
  assert.equal((await f.ledger.save(encrypted, f.input({ origin: 'local' }))).kind, 'new');
  assert.deepEqual(await f.ledger.read(f.input()), f.cache);
  const row = f.row(); assert.equal(row.pending, 1); assert.equal(JSON.parse(row.cursor_json).manifestDigest, sharedDocumentDigest(encrypted.manifest));
  const stored = JSON.stringify(row); for (const value of [f.calendarBinding, 'Asia/Tokyo', f.cache.fetchedAt, f.cache.intervals[0].start, Buffer.from(f.accountKey).toString('hex')]) assert.equal(stored.includes(value), false);
  const another = f.connect(join(directory, 'cache.db'));
  assert.deepEqual(await another.ledger.read(f.input()), f.cache);
  assert.deepEqual((await another.ledger.pending(f.authority, 1)).encrypted, encrypted);
  assert.equal(f.connection.prepare('SELECT count(*) AS n FROM private_calendar_cache').get().n, 1);
});

test('private Calendar missing, tampered and wrongly bound incoming snapshots leave the previous cache and pending retry untouched', async t => {
  const f = await fixture(t); const first = await f.seal(); await f.ledger.save(first, f.input({ origin: 'local' }));
  await f.ledger.fail(f.authority, sharedDocumentDigest(first.manifest), 10, 'offline', 0.5); const before = f.row();
  const next = await f.seal(2);
  for (const bad of [{ ...next, chunks: [] }, { ...next, chunks: [{ ...next.chunks[0], encryptedPayload: '0'.repeat(next.chunks[0].encryptedPayload.length) }] }]) {
    await assert.rejects(() => f.ledger.save(bad, f.input({ origin: 'remote' })));
    assert.deepEqual(f.row(), before);
  }
  await assert.rejects(() => f.ledger.save(next, f.input({ origin: 'remote', calendarBinding: 'different-calendar' })), /接続先/u);
  assert.deepEqual(f.row(), before); assert.deepEqual(await f.ledger.read(f.input()), f.cache);
});

test('private Calendar a failure after writing SQL rolls back cache, cursor and outbox together', async t => {
  let rejectAfterWrite = false;
  const f = await fixture(t, { decorate: (database, state) => ({ ...database, async runAsync(sql, ...params) {
    const result = await database.runAsync(sql, ...params);
    if (rejectAfterWrite && sql.includes('INSERT INTO private_calendar_cache')) state.user = 'different-user'; return result;
  } }) });
  await f.ledger.save(await f.seal(), f.input({ origin: 'local' })); const before = f.row();
  rejectAfterWrite = true;
  const next = await f.seal(2);
  await assert.rejects(() => f.ledger.save(next, f.input({ origin: 'local' })), /account changed/u);
  f.state.user = f.cache.ownerUserId; assert.deepEqual(f.row(), before);
});

test('private Calendar save owns its key, origin and ciphertext before the first account or native await', async t => {
  const f = await fixture(t); const encrypted = await f.seal(); const expected = clone(encrypted); const key = f.accountKey.slice();
  const input = f.input({ origin: 'local', accountKey: key }); let release; let reached;
  const entered = new Promise(resolve => { reached = resolve; }); const gate = new Promise(resolve => { release = resolve; });
  let once = true; f.state.ownerHook = async () => { if (once) { once = false; reached(); await gate; } };
  const saving = f.ledger.save(encrypted, input); await entered;
  key.fill(0); input.origin = 'remote'; input.calendarBinding = 'changed'; encrypted.chunks[0].encryptedPayload = '0'.repeat(encrypted.chunks[0].encryptedPayload.length); release();
  await saving; assert.equal(f.row().pending, 1); assert.deepEqual((await f.ledger.pending(f.authority, 1)).encrypted, expected);
  assert.deepEqual(await f.ledger.read(f.input()), f.cache);
});

test('private Calendar stale acknowledgement and stale failure cannot erase or delay a newer pending snapshot', async t => {
  const f = await fixture(t); const first = await f.seal(); await f.ledger.save(first, f.input({ origin: 'local' }));
  const newer = await f.seal(2); await f.ledger.save(newer, f.input({ origin: 'local' })); const before = f.row();
  assert.equal(await f.ledger.acknowledge(f.authority, sharedDocumentDigest(first.manifest)), false);
  assert.equal(await f.ledger.fail(f.authority, sharedDocumentDigest(first.manifest), 10, 'offline', 1), false); assert.deepEqual(f.row(), before);
  const digest = sharedDocumentDigest(newer.manifest); assert.equal(await f.ledger.acknowledge(f.authority, digest), true);
  assert.equal((await f.ledger.save(clone(newer), f.input({ origin: 'local' }))).kind, 'duplicate');
  assert.equal(await f.ledger.pending(f.authority, 99), null); assert.equal(f.row().pending, 0);
});

test('private Calendar retry retains exact ciphertext and applies exponential backoff with bounded jitter without resetting on duplicate saves', async t => {
  const f = await fixture(t); const encrypted = await f.seal(); const digest = sharedDocumentDigest(encrypted.manifest);
  await f.ledger.save(encrypted, f.input({ origin: 'local' }));
  assert.equal(await f.ledger.fail(f.authority, digest, 1000, 'offline', 0), true); assert.equal(f.row().retry_at, 25_000);
  await f.ledger.save(clone(encrypted), f.input({ origin: 'local' })); assert.equal(f.row().attempts, 1); assert.equal(f.row().retry_at, 25_000);
  assert.equal(await f.ledger.pending(f.authority, 24_999), null);
  assert.deepEqual((await f.ledger.pending(f.authority, 1000, { force: true })).encrypted, encrypted);
  assert.equal(f.row().retry_at, 25_000); assert.equal(f.row().attempts, 1);
  assert.deepEqual((await f.ledger.pending(f.authority, 25_000)).encrypted, encrypted);
  await f.ledger.fail(f.authority, digest, 25_000, 'temporary', 1); assert.equal(f.row().retry_at, 97_000);
  for (let i = 0; i < 20; i++) await f.ledger.fail(f.authority, digest, 100_000, 'temporary', 1);
  assert.equal(f.row().retry_at, 100_000 + 6 * 60 * 60 * 1000); assert.equal(f.row().encrypted_json, JSON.stringify(encrypted));
  const before = f.row();
  for (const args of [[-1, 'offline', 0.5], [1, 'token=secret', 0.5], [1, 'offline', NaN], [1, 'offline', 2]]) await assert.rejects(async () => f.ledger.fail(f.authority, digest, ...args));
  assert.deepEqual(f.row(), before);
});

test('private Calendar newer complete remote snapshots supersede obsolete cached publications but reject old sequences and same-sequence forks', async t => {
  const f = await fixture(t); const first = await f.seal(); const second = await f.seal(2);
  await f.ledger.save(first, f.input({ origin: 'local' })); await f.ledger.save(second, f.input({ origin: 'remote' }));
  const before = f.row(); assert.equal(before.pending, 0);
  await assert.rejects(() => f.ledger.save(first, f.input({ origin: 'remote' })), /古い/u);
  const fork = await f.seal(2); await assert.rejects(() => f.ledger.save(fork, f.input({ origin: 'remote' })), /同じ連番/u);
  assert.deepEqual(f.row(), before);
});

test('private Calendar simultaneous SQLite connections preserve the largest sequence and never choose a last-writer winner for forks', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'liflow-private-cache-race-')); t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, 'cache.db'); const f = await fixture(t, { path }); const right = f.connect(path);
  await f.ledger.save(await f.seal(), f.input({ origin: 'local' }));
  const a = await f.seal(2); const b = await f.seal(3);
  const results = await Promise.allSettled([f.ledger.save(a, f.input({ origin: 'local' })), right.ledger.save(b, f.input({ origin: 'local' }))]);
  assert.ok(results.some(result => result.status === 'fulfilled')); assert.equal(JSON.parse(f.row().cursor_json).sequence, 3);
  const fork1 = await f.seal(4); const fork2 = await f.seal(4);
  const forks = await Promise.allSettled([f.ledger.save(fork1, f.input({ origin: 'local' })), right.ledger.save(fork2, f.input({ origin: 'local' }))]);
  assert.equal(forks.filter(result => result.status === 'fulfilled').length, 1); assert.equal(forks.filter(result => result.status === 'rejected').length, 1);
  assert.equal(JSON.parse(f.row().cursor_json).sequence, 4);
});

test('private Calendar old authority, foreign account and non-main publishers cannot read or publish current private state', async t => {
  const f = await fixture(t); await f.ledger.save(await f.seal(), f.input({ origin: 'local' })); const before = f.row();
  const second = await createDeviceIdentity(crypto);
  f.state.authority = advancePrivateCalendarAuthority(f.authority, { devices: [f.main, second], mainDeviceId: f.main.deviceId, keyVersion: 1 }, f.main);
  await assert.rejects(() => f.ledger.read(f.input({ authority: f.authority })), /authority changed/u);
  assert.equal(await f.ledger.pending(f.state.authority, 1), null); assert.deepEqual(f.row(), before);
  const fresh = await f.seal(1); await f.ledger.save(fresh, f.input({ origin: 'local' }));
  f.state.localDevice = second.deviceId;
  await assert.rejects(() => f.ledger.pending(f.state.authority, 1), /main device/u);
  await assert.rejects(() => f.ledger.save(fresh, f.input({ origin: 'local' })), /main device/u);
  assert.deepEqual(await f.ledger.read(f.input()), { ...f.cache, mainRevision: 2 });
  f.state.user = 'foreign-user'; await assert.rejects(() => f.ledger.read(f.input()), /account changed/u);
});

test('private Calendar corrupt persisted cursor or ciphertext is rejected rather than published or accepted as a duplicate', async t => {
  const f = await fixture(t); const encrypted = await f.seal(); await f.ledger.save(encrypted, f.input({ origin: 'local' })); const original = f.row();
  const bad = clone(encrypted); bad.chunks[0].encryptedPayload = '0'.repeat(bad.chunks[0].encryptedPayload.length);
  f.connection.prepare('UPDATE private_calendar_cache SET encrypted_json = ?').run(JSON.stringify(bad));
  await assert.rejects(() => f.ledger.pending(f.authority, 1), /改ざん/u);
  await assert.rejects(() => f.ledger.read(f.input()), /改ざん/u);
  await assert.rejects(() => f.ledger.save(encrypted, f.input({ origin: 'local' })), /暗号文が一致/u);
  f.connection.prepare('UPDATE private_calendar_cache SET encrypted_json = ?, cursor_json = ?').run(original.encrypted_json, JSON.stringify({ ...JSON.parse(original.cursor_json), unknown: true }));
  await assert.rejects(() => f.ledger.pending(f.authority, 1), /形式/u);
});

test('private Calendar an account switch after SQLite commits cannot expose the previous account result but preserves its durable snapshot', async t => {
  let flip = false;
  const f = await fixture(t, { decorate: (database, state) => ({ ...database, async withTransactionAsync(work) {
    await database.withTransactionAsync(work); if (flip) state.user = 'another-user';
  } }) });
  await f.ledger.save(await f.seal(), f.input({ origin: 'local' })); const second = await f.seal(2);
  flip = true; await assert.rejects(() => f.ledger.save(second, f.input({ origin: 'local' })), /account changed/u);
  assert.equal(JSON.parse(f.row().cursor_json).sequence, 2);
  flip = false; f.state.user = f.cache.ownerUserId;
  assert.deepEqual((await f.ledger.pending(f.authority, 1)).encrypted, second);
  flip = true; await assert.rejects(() => f.ledger.read(f.input()), /account changed/u);
});

test('private Calendar read refuses an obsolete clear result when a newer complete snapshot arrives during native decryption', async t => {
  let onDecrypt = null;
  const f = await fixture(t, { crypto: { ...crypto, async decrypt(...args) {
    const action = onDecrypt; onDecrypt = null; if (action) await action(); return crypto.decrypt(...args);
  } } });
  await f.ledger.save(await f.seal(), f.input({ origin: 'local' }));
  const nextCache = { ...f.cache, intervals: [{ start: '2026-10-28T03:00:00.000Z', end: '2026-10-28T04:00:00.000Z' }] };
  const newer = await f.seal(2, { cache: nextCache });
  onDecrypt = () => f.ledger.save(newer, f.input({ origin: 'remote' }));
  await assert.rejects(() => f.ledger.read(f.input()), /更新/u);
  assert.deepEqual(await f.ledger.read(f.input()), nextCache);
});

test('private Calendar a main change during native validation cannot commit or return an obsolete pending publication', async t => {
  let onDigest = null;
  const { createHash } = await import('node:crypto');
  const f = await fixture(t, { crypto: { ...crypto, async digestSha256(bytes) {
    const action = onDigest; onDigest = null; if (action) await action(); return new Uint8Array(createHash('sha256').update(bytes).digest());
  } } });
  const first = await f.seal(); await f.ledger.save(first, f.input({ origin: 'local' })); const before = f.row();
  const second = await createDeviceIdentity(crypto);
  const change = () => { f.state.authority = advancePrivateCalendarAuthority(f.authority, { devices: [f.main, second], mainDeviceId: second.deviceId, keyVersion: 1 }, f.main); };
  const incoming = await f.seal(2); onDigest = change;
  await assert.rejects(() => f.ledger.save(incoming, f.input({ authority: f.authority, origin: 'local' })), /authority changed/u);
  assert.deepEqual(f.row(), before); f.state.authority = f.authority;
  onDigest = change; await assert.rejects(() => f.ledger.pending(f.authority, 1), /authority changed/u);
  assert.deepEqual(f.row(), before);
});

test('private Calendar metadata status, delivery acknowledgement and retry updates avoid transferring the full encrypted cache from SQLite', async t => {
  let fullReads = 0;
  const f = await fixture(t, { decorate: database => ({ ...database, async getFirstAsync(sql, ...params) {
    const row = await database.getFirstAsync(sql, ...params); if (typeof row?.encrypted_json === 'string') fullReads++; return row;
  } }) });
  const first = await f.seal(); await f.ledger.save(first, f.input({ origin: 'local' }));
  assert.equal((await f.ledger.status(f.authority)).pending, true);
  const digest = sharedDocumentDigest(first.manifest); await f.ledger.fail(f.authority, digest, 1, 'offline', 0.5);
  assert.equal((await f.ledger.status(f.authority)).attempts, 1);
  await f.ledger.acknowledge(f.authority, digest); assert.equal((await f.ledger.status(f.authority)).pending, false);
  await f.ledger.save(await f.seal(2), f.input({ origin: 'local' }));
  assert.equal(fullReads, 0, 'metadata-only operations and a new snapshot do not read megabytes of previous ciphertext');
  await f.ledger.read(f.input()); assert.equal(fullReads, 1, 'only a genuine cache read transfers the complete ciphertext');
});
