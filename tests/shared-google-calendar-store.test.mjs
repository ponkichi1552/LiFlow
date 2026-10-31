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
