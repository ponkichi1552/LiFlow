import './helpers/typescript-loader.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, seeds, groupId, now, receiptsFor } from './helpers/sharing-v2-repository-fixture.mjs';
import { createSharedCalendarExportStore } from '../src/platform/storage/sharing-v2-calendar-export.ts';
import { createV2GroupController } from '../src/features/sharing/v2/controller.ts';
import { loadSharedFacts, listSharingOutbox, readSharingCheckpoint, applyReceivedSharedFacts } from '../src/platform/storage/sharing-ledger.ts';
import { newEventDraft } from '../src/domain/calendar/events.ts';
import { readSharedCalendar } from '../src/features/sharing/v2/calendar-state.ts';
import { v2ReadPoint } from '../src/features/sharing/v2/view-point.ts';
import { googleOwnedFields } from '../src/features/calendar/google-owned-fields.ts';
import { googleEventBody } from '../src/features/calendar/google-event-mapping.ts';

test('shared export can prove an older series revision only from receipted authorized history and reports the current revision without changing group facts', async t => {
  const d = await (await fixture()).device(); t.after(() => d.connection.close()); await d.repository.commit(seeds()); let sequence = 0;
  const controller = createV2GroupController(d.repository, { makeId: () => `proof-calendar-${++sequence}`, now, sync: async () => {} });
  const store = createSharedCalendarExportStore(d.repository); const category = { id: 'personal', name: '私用', color: '#3D906A', revision: 1 };
  const value = { ...newEventDraft('2026-11-03', 'Asia/Tokyo'), title: '版1' };
  const acknowledge = async () => {
    const facts = await loadSharedFacts(d.database, groupId); const checkpoint = await readSharingCheckpoint(d.database, groupId);
    await applyReceivedSharedFacts(d.database, groupId, facts, String(facts.length), d.repository.project, checkpoint.cursor, now().getTime(), d.repository.evidenceForServerReceipts(receiptsFor(facts)));
  };
  await controller.actions.saveCalendarEvent({ scope: 'series', anchorDate: null, value, category }); await acknowledge();
  const [first] = await store.readItems();
  const record = await d.repository.readCurrent(state => readSharedCalendar(state.assessment.view, v2ReadPoint(state.assessment.view, state.archive.at(-1)))[0]);
  await controller.actions.saveCalendarEvent({ eventId: record.id, scope: 'series', anchorDate: null, value: { ...value, title: '版2' }, category,
    basisRevision: JSON.stringify([record.heads.map(op => op.operationId).sort(), record.heads.map(op => op.operationId).sort()]) });
  assert.equal(await store.knownSeriesRevision(first.sourceId, first.revision), null, 'a new unreceipted head cannot authorize rebasing');
  await acknowledge(); const [second] = await store.readItems(); const before = await listSharingOutbox(d.database, groupId);
  assert.deepEqual(await store.knownSeriesRevision(first.sourceId, first.revision), { currentRevision: second.revision, fields: googleOwnedFields(googleEventBody(value)) });
  assert.equal(await store.knownSeriesRevision('foreign-event', first.revision), null);
  assert.equal(await store.knownSeriesRevision(first.sourceId, 'unverified-digest'), null);
  assert.equal(await store.knownSeriesRevision(`${first.sourceId}:2026-11-10`, first.revision), null, 'a series proof cannot authorize an instance');
  assert.deepEqual(await listSharingOutbox(d.database, groupId), before);
});

test('shared export settings and Google IDs stay private and OFF preserves the same account target links', async () => {
  const f = await fixture(); const d = await f.device();
  try {
    await d.repository.commit(seeds()); const store = createSharedCalendarExportStore(d.repository); const before = await listSharingOutbox(d.database, groupId);
    let control = await store.readControl(); assert.equal(control.enabled, false);
    control = await store.configure({ enabled: true, subject: 'google-subject', accountLabel: '検査', calendarId: 'chosen-calendar', calendarLabel: '検査用' }, control.revision);
    const link = { sourceId: 'signed-group-event', googleId: 'google-only-id', etag: 'google-etag', revision: 'source-digest', deleted: false };
    await store.saveLink('google-subject', 'chosen-calendar', link); await store.configure({ enabled: false }, control.revision);
    assert.deepEqual(await store.readLinks('google-subject', 'chosen-calendar'), [link]); assert.deepEqual(await store.readLinks('another-account', 'chosen-calendar'), []);
    assert.deepEqual(await listSharingOutbox(d.database, groupId), before);
    await assert.rejects(store.configure({ enabled: true, accessToken: 'must-not-be-persisted' }, (await store.readControl()).revision));
    await assert.rejects(store.saveLink('google-subject', 'chosen-calendar', { ...link, accessToken: 'must-not-be-persisted' }));
    assert.ok(!d.connection.prepare('SELECT value_json FROM sharing_v2_calendar_export_control').get().value_json.includes('accessToken'));
  } finally { d.connection.close(); }
});

test('private export HTTP guards and receipts do not replay business history while every access remains account-bound', async t => {
  const f = await fixture(); const d = await f.device(); t.after(() => d.connection.close()); await d.repository.commit(seeds());
  const store = createSharedCalendarExportStore(d.repository); const read = d.database.getAllAsync; let replays = 0;
  d.database.getAllAsync = async (sql, ...parameters) => { if (/FROM sharing_operations|author_signature/u.test(sql)) replays++; return read(sql, ...parameters); };
  const control = await store.configure({ enabled: true, subject: 'subject', calendarId: 'calendar' }, 0);
  for (let n = 0; n < 20; n++) {
    await store.readControl(); await store.saveLink('subject', 'calendar', { sourceId: `event-${n}`, googleId: `google-${n}`, etag: 'etag', revision: 'digest', deleted: false });
  }
  await store.saveStatus(control.revision, { error: null, retryAt: null, retryCount: 0 });
  assert.equal((await store.readLinks('subject', 'calendar')).length, 20); assert.equal(replays, 0);
  d.stopWrites(); await assert.rejects(store.readControl(), /account changed/u);
  await assert.rejects(store.saveStatus(control.revision, { error: null, retryAt: null, retryCount: 0 }), /account changed/u);
});
test('private metadata transactions reject a foreign binding and roll back when account access changes during a write', async t => {
  const f = await fixture(); const d = await f.device(); t.after(() => d.connection.close()); await d.repository.commit(seeds());
  await assert.rejects(d.repository.withPrivateStorage(async tx => {
    await tx.execAsync('CREATE TABLE audit_private(value TEXT)'); await tx.runAsync('INSERT INTO audit_private VALUES(?)', 'must roll back'); d.stopWrites();
  }), /account changed/u);
  assert.equal(d.connection.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name='audit_private'").get().n, 0);
  const other = await f.device(); t.after(() => other.connection.close());
  other.connection.exec("UPDATE sharing_v2_binding SET user_id='another-account'");
  await assert.rejects(createSharedCalendarExportStore(other.repository).readControl(), /一致しません/u);
});

test('shared export sends only server-receipted group events and cannot export unsent or unrelated personal state', async () => {
  const f = await fixture(); const d = await f.device();
  try {
    await d.repository.commit(seeds()); let sequence = 0;
    const c = createV2GroupController(d.repository, { makeId: () => `calendar-${++sequence}`, now, sync: async () => {} });
    await c.actions.saveCalendarEvent({ scope: 'series', anchorDate: null, value: { ...newEventDraft('2026-10-27', 'Asia/Tokyo'), title: '共有する予定' }, category: { id: 'personal', name: '私用', color: '#3D906A', revision: 1 } });
    const store = createSharedCalendarExportStore(d.repository); const waiting = await store.readItems();
    assert.equal(waiting.length, 1); assert.equal(waiting[0].blocked, 'receipt'); assert.equal(waiting[0].value, null);
    const facts = await loadSharedFacts(d.database, groupId); const checkpoint = await readSharingCheckpoint(d.database, groupId);
    await applyReceivedSharedFacts(d.database, groupId, facts, 'receipt-cursor', d.repository.project, checkpoint.cursor, now().getTime(), d.repository.evidenceForServerReceipts(receiptsFor(facts)));
    const items = await store.readItems(); assert.equal(items.length, 1); assert.equal(items[0].value.title, '共有する予定'); assert.ok(!JSON.stringify(items).includes('google-subject'));
  } finally { d.connection.close(); }
});

test('an unsent recurring exception reset survives further receipted series edits in the real private export store', async t => {
  const d = await (await fixture()).device(); t.after(() => d.connection.close()); await d.repository.commit(seeds());
  let sequence = 0;
  const controller = createV2GroupController(d.repository, { makeId: () => `export-calendar-${++sequence}`, now, sync: async () => {} });
  const category = { id: 'personal', name: '私用', color: '#3D906A', revision: 1 };
  const value = { ...newEventDraft('2026-11-03', 'Asia/Tokyo'), title: '共有予定', recurrence: 'weekly' };
  const current = () => d.repository.readCurrent(state => readSharedCalendar(state.assessment.view, v2ReadPoint(state.assessment.view, state.archive.at(-1)))[0]);
  const acknowledge = async () => {
    const facts = await loadSharedFacts(d.database, groupId); const checkpoint = await readSharingCheckpoint(d.database, groupId);
    await applyReceivedSharedFacts(d.database, groupId, facts, String(facts.length), d.repository.project, checkpoint.cursor, now().getTime(), d.repository.evidenceForServerReceipts(receiptsFor(facts)));
  };
  await controller.actions.saveCalendarEvent({ scope: 'series', anchorDate: null, value, category }); await acknowledge();
  let record = await current(); const eventId = record.id;
  await controller.actions.saveCalendarEvent({ eventId, scope: 'one', anchorDate: '2026-11-10', value: { ...value, recurrence: 'none', title: '個別変更', startDate: '2026-11-11', endDate: '2026-11-11' },
    category, basisRevision: JSON.stringify([record.heads.map(op => op.operationId).sort(), []]) }); await acknowledge();
  record = await current(); const resetIds = record.exceptions[0].heads.map(op => op.operationId);
  await controller.actions.saveCalendarEvent({ eventId, scope: 'series', anchorDate: null, value, category, resetExceptions: true, expectedExceptionIds: resetIds,
    basisRevision: JSON.stringify([record.heads.map(op => op.operationId).sort(), record.heads.map(op => op.operationId).sort()]) }); await acknowledge();
  record = await current();
  await controller.actions.saveCalendarEvent({ eventId, scope: 'series', anchorDate: null, value: { ...value, notes: 'リセット後の編集' }, category,
    basisRevision: JSON.stringify([record.heads.map(op => op.operationId).sort(), record.heads.map(op => op.operationId).sort()]) }); await acknowledge();
  const items = await createSharedCalendarExportStore(d.repository).readItems();
  assert.equal(items.length, 2); assert.equal(items[1].reset, true); assert.equal(items[1].anchorDate, '2026-11-10');
  assert.equal(items[1].value.notes, 'リセット後の編集');
});

test('real signed SQLite calendar conflicts remain explicit blocked export inputs until an accepted resolution replaces every head', async t => {
  const f = await fixture(); const a = await f.device(); const b = await f.device('member', f.member); t.after(() => { a.connection.close(); b.connection.close(); });
  await a.repository.commit(seeds()); let i = 0;
  const controller = d => createV2GroupController(d.repository, { makeId: () => `blocked-export-${++i}`, now, sync: async () => {} });
  const category = { id: 'personal', name: '私用', color: '#3D906A', revision: 1 };
  const value = { ...newEventDraft('2026-10-27', 'Asia/Tokyo'), title: '共有する予定' };
  const read = d => d.repository.readCurrent(state => readSharedCalendar(state.assessment.view, v2ReadPoint(state.assessment.view, state.archive.at(-1)))[0]);
  const accept = async (d, facts, _label) => {
    const checkpoint = await readSharingCheckpoint(d.database, groupId);
    const ordered = [...facts].sort((a, b) => a.operation.logicalClock - b.operation.logicalClock || a.operation.operationId.localeCompare(b.operation.operationId));
    const receipts = receiptsFor(ordered).map((row, index) => ({ ...row, uploadSequence: index + 1 }));
    await applyReceivedSharedFacts(d.database, groupId, facts, String(facts.length), d.repository.project, checkpoint.cursor, now().getTime(), d.repository.evidenceForServerReceipts(receipts));
  };
  const seeded = await loadSharedFacts(a.database, groupId); await accept(a, seeded, 'seeded'); await accept(b, seeded, 'seeded');
  await controller(b).actions.saveCalendarEvent({ scope: 'series', anchorDate: null, value, category });
  const initial = await loadSharedFacts(b.database, groupId); await accept(a, initial, 'initial'); await accept(b, initial, 'initial');
  const old = await read(a); const basis = JSON.stringify([old.heads.map(head => head.operationId).sort(), old.heads.map(head => head.operationId).sort()]);
  for (const [d, title] of [[a, '一方の変更'], [b, '別の変更']]) await controller(d).actions.saveCalendarEvent({ eventId: old.id, scope: 'series', anchorDate: null,
    value: { ...value, title }, category, basisRevision: basis });
  const unique = new Map([...(await loadSharedFacts(a.database, groupId)), ...(await loadSharedFacts(b.database, groupId))].map(fact => [fact.operation.operationId, fact]));
  await accept(a, [...unique.values()], 'conflict');
  const conflicted = await read(a); assert.equal(conflicted.heads.length, 2);
  const store = createSharedCalendarExportStore(a.repository); const blocked = await store.readItems();
  assert.equal(blocked.length, 1); assert.equal(blocked[0].blocked, 'conflict'); assert.equal(blocked[0].value, null);
  const heads = conflicted.heads.map(head => head.operationId).sort();
  await controller(a).actions.saveCalendarEvent({ eventId: old.id, scope: 'series', anchorDate: null, value: { ...value, title: '確定した予定' }, category, basisRevision: JSON.stringify([heads, heads]) });
  assert.equal((await store.readItems())[0].blocked, 'receipt');
  await accept(a, await loadSharedFacts(a.database, groupId), 'resolved');
  const ready = await store.readItems(); assert.equal(ready.length, 1); assert.equal(ready[0].blocked, undefined); assert.equal(ready[0].value.title, '確定した予定');
});
