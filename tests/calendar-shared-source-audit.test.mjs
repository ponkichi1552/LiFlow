import './helpers/typescript-loader.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { screenHarness } from './helpers/screen-harness.mjs';
import { createDatabase } from './helpers/sqlite.mjs';
import { newEventDraft } from '../src/domain/calendar/events.ts';
const { initializeLocalDatabase } = await import('../src/platform/storage/repository.ts');
const { readLocalCalendar } = await import('../src/platform/storage/calendar-events.ts');

for (const platform of ['ios', 'android']) test(`${platform} personal event categories exclude unsaveable group IDs and temporary shared categories cannot follow a changed workspace`, async t => {
  const h = createDatabase(); t.after(() => h.connection.close()); await initializeLocalDatabase(h.database);
  const snapshot = await readLocalCalendar(h.database); let binding;
  const record = { id: 'shared-event', creatorUserId: 'owner', heads: [{ operationId: 'op', logicalClock: 1, payload: {
    value: { ...newEventDraft('2026-11-01', 'UTC'), title: 'Shared', categoryId: 'group-only' }, category: { id: 'group-only', name: 'Group only', color: '#348DC2' },
  } }], exceptions: [] };
  const props = { local: { database: h.database, snapshot, loading: false, error: null, refresh: async () => {} }, actions: {},
    model: { viewerUserId: 'owner', adminUserId: 'owner', calendarSupported: true, calendar: [record], plan: { groupId: 'group.one' } }, capture: value => { binding = value; } };
  const source = screenHarness('tests/helpers/calendar-source-host.tsx', { exportName: 'CalendarSourceHost', platform, props });
  assert.equal(binding.categoriesFor('personal').some(row => row.name === 'Group only'), false);
  assert.equal(binding.categoriesFor('group').some(row => row.name === 'Group only'), true);
  const editor = screenHarness('src/features/calendar/calendar-editor.tsx', { exportName: 'CalendarEditor', platform,
    props: { local: binding, initial: { eventId: null, anchorDate: null, revision: 0, exceptionRevision: 0, scope: 'series', value: newEventDraft('2026-11-01', 'UTC') }, onClose: () => {}, onSaved: () => {} } });
  await editor.press('分類を選択'); assert.equal(editor.nodes().some(row => row.props.accessibilityLabel === 'Group onlyの分類を選択'), false);
  await binding.saveCategory({ expectedRevision: 0, name: 'Pending group category', color: '#123456' }, 'group'); source.render();
  assert.equal(binding.categoriesFor('group').some(row => row.name === 'Pending group category'), true);
  props.model = { ...props.model, calendar: [], plan: { groupId: 'group.two' } }; source.render();
  assert.equal(binding.categoriesFor('group').some(row => row.name === 'Pending group category'), false);
  assert.equal((await readLocalCalendar(h.database)).categories.some(row => row.name === 'Pending group category'), false);
});
