import './helpers/typescript-loader.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { createDatabase } from './helpers/sqlite.mjs';
import { createGoogleTaskCreateJournal, initializeGoogleTaskCreateIntentsInside } from '../src/platform/storage/google-task-create-intents.ts';
import { beginPrivateCalendarAcquisition, completePrivateCalendarAcquisition } from '../src/platform/storage/private-calendar-acquisition.ts';
import { createV2AuthorityIndex } from '../src/features/sharing/v2/history-view.ts';
import { createSharedCalendarExportStore } from '../src/platform/storage/sharing-v2-calendar-export.ts';
import { newEventDraft } from '../src/domain/calendar/events.ts';

test('audit50 reserving a hundred personal Tasks uses one atomic bounded batch and keeps duplicate or already reserved identities closed', async t => {
  const h = createDatabase(); t.after(() => h.connection.close()); await initializeGoogleTaskCreateIntentsInside(h.database);
  let transactions = 0; let sequence = 0;
  const journal = createGoogleTaskCreateJournal(async work => { transactions++; let result; await h.database.withTransactionAsync(async () => { result = await work(h.database); }); return result; }, () => `attempt-${++sequence}`, () => new Date('2026-11-07T00:00:00Z'));
  const identities = Array.from({ length: 100 }, (_, n) => ({ accountSubject: 'owner', taskListId: 'list', occurrenceMarker: `round-${n}` }));
  const results = journal.reserveBatch ? await journal.reserveBatch(identities) : await Promise.all(identities.map(async identity => {
    // The real coordinator serializes the fallback one by one.
    return identity;
  })).then(async rows => { const values = []; for (const row of rows) values.push(await journal.reserve(row)); return values; });
  assert.equal(results.filter(Boolean).length, 100); assert.ok(transactions <= 1, `reservation transactions: ${transactions}`);
  assert.ok(h.writes.length <= 3, `reservation bridge writes: ${h.writes.length}`);
  assert.deepEqual(await journal.reserveBatch([identities[0], identities[0]]), [null, null]);
  const foreign = { ...identities[0], accountSubject: 'another-owner' };
  const pair = await journal.reserveBatch([foreign, foreign]); assert.ok(pair[0]); assert.equal(pair[1], null);
  const before = h.connection.prepare('SELECT count(*) n FROM private_google_task_create_intents').get().n;
  await assert.rejects(journal.reserveBatch([{ ...foreign, occurrenceMarker: 'new' }, { ...foreign, occurrenceMarker: '' }]));
  assert.equal(h.connection.prepare('SELECT count(*) n FROM private_google_task_create_intents').get().n, before);
});

test('audit50 a wall clock rollback cannot leave a private Calendar acquisition leased until its former future date', async t => {
  const h = createDatabase(); t.after(() => h.connection.close()); let counter = 0;
  const crypto = { randomBytes: async n => new Uint8Array(n).fill(++counter) };
  const input = { authorityDigest: 'a'.repeat(64), rangeDigest: 'b'.repeat(64), now: Date.parse('2026-11-07T12:00:00Z'), force: false, automatic: true, randomFraction: .5, currentManifestDigest: null };
  const first = await beginPrivateCalendarAcquisition(h.database, crypto, input);
  assert.equal(first.kind, 'acquired');
  assert.equal((await beginPrivateCalendarAcquisition(h.database, crypto, { ...input, now: input.now + 1000 })).kind, 'inProgress');
  const replacement = await beginPrivateCalendarAcquisition(h.database, crypto, { ...input, now: input.now - 3600_000 });
  assert.equal(replacement.kind, 'acquired'); assert.notEqual(replacement.lease.token, first.lease.token);
  await assert.rejects(completePrivateCalendarAcquisition(h.database, first.lease, input.now, 'c'.repeat(64)), 'the displaced query must not overwrite its replacement');
  await completePrivateCalendarAcquisition(h.database, replacement.lease, replacement.lease.startedAt + 1000, 'd'.repeat(64));
});

test('audit50 multiple historical resets of the same shared Calendar occurrence produce one export instruction', async () => {
  const { view, accept } = createV2AuthorityIndex('group'); let sequence = 0;
  const category = { id: 'personal', name: 'personal', color: '#338899' };
  const value = { ...newEventDraft('2026-11-03', 'UTC'), title: 'weekly', recurrence: 'weekly' };
  const make = (eventId, changes = {}) => { const n = ++sequence; const operationId = n === 1 ? 'series' : `calendar-${n}`; const op = { schemaVersion: 2, operationId, entityType: 'calendarEvent', entityId: operationId, operationType: 'patch', groupId: 'group', authorUserId: 'owner', authorDeviceId: 'device', deviceSequence: n, logicalClock: n, context: { device: n - 1 }, payload: { eventId, value, category, scope: 'series', anchorDate: null, basisOperationIds: [], resetExceptionIds: [], ...changes } }; accept(op); return op; };
  make('series'); let parent = 'series';
  for (let n = 0; n < 10; n++) {
    const exception = make('series', { scope: 'one', anchorDate: '2026-11-10' });
    const reset = make('series', { basisOperationIds: [parent], resetExceptionIds: [exception.operationId] }); parent = reset.operationId;
  }
  const state = { archive: [{ body: { schemaVersion: 2, groupId: 'group', ownerUserId: 'owner', ownerDeviceId: 'device', keyVersion: 1 } }], assessment: { view }, receipts: new Map(view.ready.map(op => [op.operationId, {}])) };
  const store = createSharedCalendarExportStore({ readCurrent: work => work(state) });
  const items = await store.readItems();
  assert.equal(items.length, 2, 'one series plus one reset, regardless of old reset count');
  assert.equal(new Set(items.map(row => row.sourceId)).size, items.length);
});
