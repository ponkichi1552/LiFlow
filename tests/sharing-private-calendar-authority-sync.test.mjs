import './helpers/typescript-loader.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { privateCalendarSetupFixture } from './helpers/private-calendar-setup.mjs';
import { sharingTestCrypto as crypto } from './helpers/sharing-crypto.mjs';
import { createDeviceIdentity, sharedDocumentDigest, signSharedDocument } from '../src/features/sharing/crypto.ts';
import { advancePrivateCalendarAuthority, verifyPrivateCalendarAuthorityUpdate, privateCalendarAuthorityFromProtectedCheckpoint, createPrivateCalendarRoot } from '../src/features/sharing/private-calendar/authority.ts';
import { canonicalJson } from '../src/features/sharing/operations.ts';
import { privateCalendarCloudFields, PrivateCalendarCloudConflict } from '../src/features/sharing/private-calendar/cloud-contract.ts';
import { collectPrivateCalendarAuthorityHistory, createPrivateCalendarAuthoritySync } from '../src/features/sharing/private-calendar/authority-sync.ts';

function server() {
  let current; const history = []; let loseReply = false; const pages = [];
  return { history, pages, get current() { return current; }, loseNextReply() { loseReply = true; },
    async createRoot(root) { current = root; history.push(root.signed); return { head: privateCalendarCloudFields(root) }; },
    async commitAuthority(before, next) {
      if (history[next.signed.body.revision - 1]) {
        if (sharedDocumentDigest(history[next.signed.body.revision - 1]) !== next.digest) throw new PrivateCalendarCloudConflict();
      } else {
        if (before.digest !== current.digest) throw new PrivateCalendarCloudConflict();
        current = verifyPrivateCalendarAuthorityUpdate(before, next.signed); history.push(current.signed);
      }
      if (loseReply) { loseReply = false; throw new Error('lost control receipt'); }
      return { head: privateCalendarCloudFields(current), accepted: true };
    },
    async authorityPage(after) { pages.push(after); return { head: privateCalendarCloudFields(current), authorities: history.slice(after, after + 100) }; },
  };
}
const control = (f, cloud) => createPrivateCalendarAuthoritySync({ userId: f.userId, secrets: f.secrets, intents: f.changes, cloud });
const configuration = authority => { const { devices, mainDeviceId, keyVersion } = authority.signed.body; return { devices, mainDeviceId, keyVersion }; };
async function fixture(t, options = {}) {
  const f = privateCalendarSetupFixture(t, options); const cloud = server(); await f.controller(cloud).prepareAndResume();
  const root = await f.secrets.authority(f.userId); const identity = await f.secrets.identity(f.userId); const second = await createDeviceIdentity(crypto);
  return { f, cloud, root, identity, second, add: { ...configuration(root), devices: [...root.signed.body.devices, second] } };
}
function file(t) { const dir = mkdtempSync(join(tmpdir(), 'liflow-control-')); t.after(() => rmSync(dir, { force: true, recursive: true })); return join(dir, 'control.db'); }

test('private Calendar reuses only verified authority prefixes and one work scope while fresh scopes still check the current cloud head', async t => {
  const { f, cloud, identity } = await fixture(t); let corruptHead = false;
  const sync = control(f, { ...cloud, async authorityPage(after) {
    const page = await cloud.authorityPage(after);
    return corruptHead ? { ...page, head: { ...page.head, authorityRevision: page.head.authorityRevision - 1 } } : page;
  } });
  await sync.refresh(); assert.deepEqual(cloud.pages, [0]);
  for (let n = 0; n < 104; n++) {
    const before = cloud.current; const next = advancePrivateCalendarAuthority(before, configuration(before), identity, { purpose: 'calendarSourceChange' });
    await cloud.commitAuthority(before, next);
  }
  const signal = new AbortController().signal;
  const first = await sync.refresh({ signal }); assert.equal(first.history.length, 105); assert.deepEqual(cloud.pages, [0, 1, 101]);
  assert.throws(() => { first.history[0].body.revision = 999; });
  first.history.length = 0; const same = await sync.refresh({ signal }); assert.equal(same.history.length, 105);
  assert.deepEqual(cloud.pages, [0, 1, 101], 'the immediate source check reuses the exact verified work scope');
  await sync.refresh({ signal: new AbortController().signal }); assert.deepEqual(cloud.pages, [0, 1, 101, 105]);
  corruptHead = true; await assert.rejects(sync.refresh({ signal: new AbortController().signal }), /署名履歴/);
  corruptHead = false; f.state.currentUser = 'another-owner'; const calls = cloud.pages.length;
  await assert.rejects(sync.refresh({ signal })); assert.equal(cloud.pages.length, calls);
});

test('private Calendar pending authority receipts invalidate a same-work cached head before resolving the committed update', async t => {
  const { f, cloud, identity, add } = await fixture(t); const sync = control(f, cloud); const signal = new AbortController().signal;
  await sync.refresh({ signal }); const pending = await f.changes.prepare(add, identity);
  const result = await sync.resume({ signal }); assert.equal(result.kind, 'accepted'); assert.equal(result.intentDigest, pending.digest);
  assert.equal(result.authority.digest, cloud.current.digest); assert.equal(result.authority.signed.body.revision, 2);
  assert.deepEqual(cloud.pages, [0, 1]); assert.equal(await f.changes.readPending(), null);
  assert.equal((await sync.refresh({ signal })).authority.digest, pending.digest); assert.deepEqual(cloud.pages, [0, 1]);
});

test('private Calendar authority changes persist one exact signed intent before transport and keep the formal pin unchanged until receipt', async t => {
  const { f, cloud, root, identity, add } = await fixture(t); const pending = await f.changes.prepare(add, identity);
  assert.equal((await f.secrets.authority(f.userId)).digest, root.digest); assert.equal(pending.signed.body.revision, 2);
  assert.equal((await f.changes.prepare(add, identity)).digest, pending.digest);
  assert.equal(await f.changes.markAccepted(pending.digest, root), false);
  const sql = JSON.stringify(f.connection.prepare('SELECT * FROM private_calendar_authority_intents').all());
  assert.equal(sql.includes(identity.signingSecretKey), false); assert.equal(sql.includes(identity.agreementSecretKey), false);
  const result = await control(f, cloud).resume(); assert.equal(result.kind, 'accepted'); assert.equal(result.authority.digest, pending.digest);
  assert.equal(await f.changes.readPending(), null); assert.equal((await control(f, cloud).resume()).kind, 'idle');
  assert.equal(f.connection.prepare('SELECT count(*) AS n FROM private_calendar_authority_intents').get().n, 1);
});

test('private Calendar lost authority receipts resume the same SQL intent after process reconstruction without replacing keys', async t => {
  const path = file(t); const { f, cloud, root, add } = await fixture(t, { path }); const originalKey = await f.secrets.currentKey(f.userId, root);
  cloud.loseNextReply(); await assert.rejects(() => control(f, cloud).change(add), /lost control receipt/u);
  const pending = await f.changes.readPending(); assert.equal((await f.secrets.authority(f.userId)).digest, root.digest);
  const after = privateCalendarSetupFixture(t, { path, values: f.values, state: f.state }); const generations = f.state.generations;
  const ready = await control(after, cloud).resume(); assert.equal(ready.intentDigest, pending.digest); assert.equal(ready.kind, 'accepted');
  assert.equal(f.state.generations, generations); assert.deepEqual(await after.secrets.currentKey(after.userId, ready.authority), originalKey); originalKey.fill(0);
});

test('private Calendar authority receipt recovery handles failure after protected update but before the SQL acknowledgement', async t => {
  let fail = false;
  const path = file(t); const { f, cloud, add } = await fixture(t, { path, decorate: db => ({ ...db, async runAsync(sql, ...args) {
    if (fail && sql.startsWith('UPDATE private_calendar_authority_intents')) throw new Error('SQL acknowledgement failed'); return db.runAsync(sql, ...args);
  } }) });
  fail = true; await assert.rejects(() => control(f, cloud).change(add), /SQL acknowledgement/u);
  assert.equal((await f.secrets.authority(f.userId)).digest, cloud.current.digest); assert.ok(await f.changes.readPending());
  const after = privateCalendarSetupFixture(t, { path, values: f.values, state: f.state });
  assert.equal((await control(after, cloud).resume()).kind, 'accepted'); assert.equal(await after.changes.readPending(), null);
});

test('private Calendar competing device changes preserve the losing draft for explicit review and cannot dismiss a newer or accepted intent', async t => {
  const { f, cloud, root, identity, add } = await fixture(t); const pending = await f.changes.prepare(add, identity);
  const winner = advancePrivateCalendarAuthority(root, { ...configuration(root), keyVersion: 2 }, identity); await cloud.commitAuthority(root, winner);
  const review = await control(f, cloud).resume(); assert.equal(review.kind, 'review'); assert.equal(review.intentDigest, pending.digest);
  assert.equal((await f.secrets.authority(f.userId)).digest, winner.digest); assert.equal((await f.changes.readPending()).digest, pending.digest);
  assert.equal(await f.changes.dismissReviewed(pending.digest, root.digest), false);
  assert.equal(await f.changes.dismissReviewed('a'.repeat(64), winner.digest), false);
  assert.equal(await f.changes.dismissReviewed(pending.digest, review.observedCurrentDigest), true);
  assert.equal(await f.changes.readPending(), null); assert.equal(f.connection.prepare('SELECT status FROM private_calendar_authority_intents').get().status, 'dismissed');
  const next = await control(f, cloud).change({ ...add, keyVersion: 2 }); assert.equal(next.kind, 'accepted');
  assert.equal(await f.changes.dismissReviewed(next.intentDigest, next.authority.digest), false);
});

test('private Calendar two SQLite runtimes cannot prepare competing changes or overwrite the first draft', async t => {
  const path = file(t); const { f, root, identity, add } = await fixture(t, { path });
  const other = privateCalendarSetupFixture(t, { path, values: f.values, state: f.state });
  const results = await Promise.allSettled([f.changes.prepare(add, identity), other.changes.prepare({ ...configuration(root), keyVersion: 2 }, identity)]);
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1); assert.equal(results.filter(r => r.status === 'rejected').length, 1);
  assert.equal(f.connection.prepare("SELECT count(*) AS n FROM private_calendar_authority_intents WHERE status = 'pending'").get().n, 1);
  assert.equal((await f.secrets.authority(f.userId)).digest, root.digest);
});

test('private Calendar authority history paginates 103 signed revisions and validates every link from the protected root before applying', async t => {
  const { f, cloud, identity, root } = await fixture(t);
  for (let i = 2; i <= 103; i++) { const next = advancePrivateCalendarAuthority(cloud.current, { ...configuration(cloud.current), keyVersion: i }, identity); await cloud.commitAuthority(cloud.current, next); }
  const read = await collectPrivateCalendarAuthorityHistory(cloud, root); assert.equal(read.history.length, 103); assert.deepEqual(cloud.pages, [0, 100]);
  const synced = await control(f, cloud).refresh(); assert.equal(synced.authority.digest, cloud.current.digest); assert.equal(synced.authority.keyIssuer.revision, 103);
  assert.equal((await f.readProtected()).hasCurrentKey, false); assert.equal((await f.readProtected()).hasStoredKeys, true);
});

test('private Calendar missing reordered forked and substituted authority history never advances a protected checkpoint', async t => {
  const { f, cloud, root, identity, add } = await fixture(t); const next = advancePrivateCalendarAuthority(root, add, identity); await cloud.commitAuthority(root, next);
  const correct = await cloud.authorityPage(0);
  for (const page of [null, { ...correct, authorities: [] }, { ...correct, authorities: [next.signed, root.signed] },
    { ...correct, authorities: [root.signed] }, { ...correct, head: { ...correct.head, rootDigest: 'a'.repeat(64) } },
    { ...correct, authorities: [root.signed, { ...next.signed, signature: '0'.repeat(128) }] }]) {
    await assert.rejects(() => control(f, { ...cloud, authorityPage: async () => page }).refresh());
    assert.equal((await f.secrets.authority(f.userId)).digest, root.digest);
  }
  const branch = advancePrivateCalendarAuthority(root, { ...configuration(root), keyVersion: 2 }, identity);
  await f.secrets.acceptAuthorityUpdate(f.userId, branch.signed);
  await assert.rejects(() => control(f, cloud).refresh(), /分岐/u); assert.equal((await f.secrets.authority(f.userId)).digest, branch.digest);
});

test('private Calendar authority input is copied before authentication awaits and revocation must rotate its key generation', async t => {
  const { f, cloud, root, add, identity, second } = await fixture(t); let enter; let release;
  const entered = new Promise(done => { enter = done; }); const gate = new Promise(done => { release = done; });
  const originalRead = f.secrets.authority; let first = true;
  f.secrets.authority = async (...args) => { const value = await originalRead(...args); if (first) { first = false; enter(); await gate; } return value; };
  const mutable = structuredClone(add); const work = control(f, cloud).change(mutable); await entered;
  mutable.mainDeviceId = second.deviceId; mutable.devices.length = 0; release(); const accepted = await work;
  assert.equal(accepted.authority.signed.body.mainDeviceId, root.signed.body.mainDeviceId); assert.equal(accepted.authority.signed.body.devices.length, 2);
  await assert.rejects(() => f.changes.prepare({ ...configuration(accepted.authority), devices: [identity] }, identity), /新しい鍵/u);
  assert.equal(await f.changes.readPending(), null);
});

test('private Calendar authority intents fail closed on corrupted SQL, owner switches and missing trust without replacing saved originals', async t => {
  const { f, cloud, root, identity, add } = await fixture(t); const saved = await f.changes.prepare(add, identity);
  const json = f.connection.prepare('SELECT authority_json FROM private_calendar_authority_intents').get().authority_json;
  f.connection.prepare('UPDATE private_calendar_authority_intents SET authority_json = ?').run('{broken');
  await assert.rejects(() => control(f, cloud).resume()); assert.equal((await f.secrets.authority(f.userId)).digest, root.digest);
  f.connection.prepare('UPDATE private_calendar_authority_intents SET authority_json = ?').run(json); f.state.currentUser = 'other-owner';
  await assert.rejects(() => f.changes.readPending(), /account changed/u); f.state.currentUser = f.userId;
  assert.equal((await f.changes.readPending()).digest, saved.digest); assert.equal((await f.secrets.identity(f.userId)).deviceId, identity.deviceId);
  const blank = privateCalendarSetupFixture(t); await assert.rejects(() => control(blank, cloud).change(add), /信頼/u); assert.equal(blank.values.size, 0);
});

test('private Calendar authority production refuses a new revision past the readable history limit while preserving an identical no-op', async () => {
  const identity = await createDeviceIdentity(crypto); const root = await createPrivateCalendarRoot(crypto, 'bounded-history-owner', identity);
  const body = { ...root.signed.body, revision: 4096, previousDigest: 'a'.repeat(64) };
  const checkpoint = privateCalendarAuthorityFromProtectedCheckpoint({ signed: { body, signature: signSharedDocument(body, identity) }, signer: root.signer, keyIssuer: root.keyIssuer }, root.anchor);
  assert.equal(advancePrivateCalendarAuthority(checkpoint, configuration(checkpoint), identity), checkpoint);
  assert.throws(() => advancePrivateCalendarAuthority(checkpoint, { ...configuration(checkpoint), keyVersion: 2 }, identity), /履歴.*上限/u);
  assert.throws(() => advancePrivateCalendarAuthority(checkpoint, configuration(checkpoint), identity, { purpose: 'calendarSourceChange' }), /履歴.*上限/u);
});

test('private Calendar authority delivery refuses a signed append that would make the complete verified history unreadable', { timeout: 30000 }, async () => {
  const identity = await createDeviceIdentity(crypto); let current = await createPrivateCalendarRoot(crypto, 'bounded-byte-owner', identity);
  const devices = [identity]; for (let i = 1; i < 16; i++) devices.push(await createDeviceIdentity(crypto));
  const history = [current.signed]; let bytes = canonicalJson(current.signed).length; let next;
  for (let i = 0; i < 4096; i++) {
    next = advancePrivateCalendarAuthority(current, { mainDeviceId: devices[(i + 1) % devices.length].deviceId, devices, keyVersion: 1 }, identity);
    const size = canonicalJson(next.signed).length; if (bytes + size > 4 * 1024 * 1024) break;
    current = next; history.push(next.signed); bytes += size;
  }
  assert.ok(bytes < 4 * 1024 * 1024 && bytes + canonicalJson(next.signed).length > 4 * 1024 * 1024);
  let commits = 0; let acknowledged = false;
  const cloud = { authorityPage: async after => ({ head: privateCalendarCloudFields(current), authorities: history.slice(after, after + 100) }),
    commitAuthority: async () => { commits++; current = next; history.push(next.signed); } };
  const intents = { readPending: async () => ({ current, digest: next.digest, signed: next.signed }), markAccepted: async () => { acknowledged = true; return true; } };
  const control = createPrivateCalendarAuthoritySync({ userId: current.anchor.ownerUserId, cloud, intents, secrets: { authority: async () => current } });
  await assert.rejects(() => control.resume(), /履歴.*上限/u); assert.equal(commits, 0, 'must refuse before publishing an unreadable history'); assert.equal(acknowledged, false);
});
