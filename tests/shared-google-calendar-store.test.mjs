import './helpers/typescript-loader.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, seeds, groupId, now, receiptsFor } from './helpers/sharing-v2-repository-fixture.mjs';
import { createSharedCalendarExportStore } from '../src/platform/storage/sharing-v2-calendar-export.ts';
import { createV2GroupController } from '../src/features/sharing/v2/controller.ts';
import { loadSharedFacts, listSharingOutbox, readSharingCheckpoint, applyReceivedSharedFacts } from '../src/platform/storage/sharing-ledger.ts';
import { newEventDraft } from '../src/domain/calendar/events.ts';

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
    const store = createSharedCalendarExportStore(d.repository); assert.deepEqual(await store.readItems(), []);
    const facts = await loadSharedFacts(d.database, groupId); const checkpoint = await readSharingCheckpoint(d.database, groupId);
    await applyReceivedSharedFacts(d.database, groupId, facts, 'receipt-cursor', d.repository.project, checkpoint.cursor, now().getTime(), d.repository.evidenceForServerReceipts(receiptsFor(facts)));
    const items = await store.readItems(); assert.equal(items.length, 1); assert.equal(items[0].value.title, '共有する予定'); assert.ok(!JSON.stringify(items).includes('google-subject'));
  } finally { d.connection.close(); }
});
