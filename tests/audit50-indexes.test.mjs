import './helpers/typescript-loader.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createV2AuthorityIndex } from '../src/features/sharing/v2/history-view.ts';
import { v2ReadPoint } from '../src/features/sharing/v2/view-point.ts';
import { createDatabase } from './helpers/sqlite.mjs';
const { initializeLocalDatabase } = await import('../src/platform/storage/repository.ts');
const { readLocalCalendar } = await import('../src/platform/storage/calendar-events.ts');
const { initializePersonalGoogleCalendar } = await import('../src/platform/storage/personal-google-calendar.ts');
import { listPersonalGoogleItems, writePersonalGoogleLink } from '../src/platform/storage/personal-google-store.ts';
import { newEventDraft } from '../src/domain/calendar/events.ts';

test('audit50 repeated shared read boundaries reuse verified frontier without revisiting every historical clock', () => {
  const { view, accept } = createV2AuthorityIndex('group'); let inspected = 0;
  const make = n => ({ groupId: 'group', operationId: `op-${n}`, entityType: 'chore', entityId: 'chore', operationType: 'patch', authorDeviceId: 'device', deviceSequence: n, get logicalClock() { inspected++; return n; }, payload: { name: 'title' } });
  for (let n = 1; n <= 1000; n++) accept(make(n));
  inspected = 0;
  const roster = { body: { schemaVersion: 2, groupId: 'group', ownerUserId: 'owner', ownerDeviceId: 'device', keyVersion: 1 } };
  const old = v2ReadPoint(view, roster);
  for (let n = 0; n < 20; n++) assert.equal(v2ReadPoint(view, roster).logicalClock, 1001);
  assert.ok(inspected <= 1000, `historical clock inspections: ${inspected}`);
  old.context.device = -1;
  assert.equal(v2ReadPoint(view, roster).context.device, 1000, 'caller mutations must not corrupt the indexed frontier');
  accept(make(1001)); assert.equal(v2ReadPoint(view, roster).logicalClock, 1002);
  assert.equal(old.logicalClock, 1001, 'previous causal cuts remain immutable');
});

test('audit50 a thousand changed Calendar items index calendar membership once without exporting unselected items', async t => {
  const h = createDatabase(); t.after(() => h.connection.close()); await initializeLocalDatabase(h.database); await readLocalCalendar(h.database); await initializePersonalGoogleCalendar(h.database);
  let inspected = 0;
  const calendars = Array.from({ length: 1000 }, (_, n) => ({ get id() { inspected++; return `calendar-${n}`; }, accessRole: 'owner' }));
  const value = { ...newEventDraft('2026-11-07', 'UTC'), title: 'saved' };
  for (let n = 0; n < 1000; n++) {
    await h.database.runAsync('INSERT INTO calendar_events(id,definition_json,revision,deleted) VALUES(?,?,2,0)', `event-${n}`, JSON.stringify(value));
    await writePersonalGoogleLink(h.database, { subject: 'owner', calendar_id: `calendar-${n}`, google_id: `remote-${n}`, event_id: `event-${n}`, anchor_date: '', etag: null, base_json: null, local_revision: 1, remote_json: null, conflict_json: null, read_only: 0 });
  }
  await h.database.runAsync('INSERT INTO calendar_events(id,definition_json,revision,deleted) VALUES(?,?,2,0)', 'unselected', JSON.stringify(value));
  await writePersonalGoogleLink(h.database, { subject: 'owner', calendar_id: 'unselected', google_id: 'unselected', event_id: 'unselected', anchor_date: '', etag: null, base_json: null, local_revision: 1, remote_json: null, conflict_json: null, read_only: 0 });
  const items = await listPersonalGoogleItems(h.database, { subject: 'owner', calendars, targetCalendarId: 'calendar-0' });
  assert.equal(items.length, 1000); assert.ok(inspected <= 2000, `calendar ID inspections: ${inspected}`);
});
