import './helpers/typescript-loader.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { createDatabase } from './helpers/sqlite.mjs';
import { screenHarness } from './helpers/screen-harness.mjs';
const { initializeLocalDatabase } = await import('../src/platform/storage/repository.ts');
const { OWN_BIRTHDAY_EVENT_ID, deleteCalendarEvent, readLocalCalendar, saveCalendarDraft, saveCalendarEvent, saveOwnBirthday } = await import('../src/platform/storage/calendar-events.ts');
import { newEventDraft, projectCalendarEvents } from '../src/features/calendar/events.ts';
import { registerSharedRepositoryAdapter } from '../src/platform/storage/shared-repository-adapter.ts';

async function fixture(t) { const h = createDatabase(); t.after(() => h.connection.close()); await initializeLocalDatabase(h.database); return h; }
const flush = async ui => { for (let i = 0; i < 15; i++) await ui.flush(); };
test('own birthday date replaces one annual nonblocking event while preserving other birthdays and drafts', async t => {
  const h = await fixture(t);
  const other = { ...newEventDraft('2001-04-02', 'Asia/Tokyo', true), title: '友人の誕生日', notes: '残すメモ' };
  const otherId = await saveCalendarEvent(h.database, { value: other, expectedRevision: 0 });
  const unfinished = { eventId: null, revision: 0, exceptionRevision: 0, anchorDate: null, scope: 'series', value: { ...other, title: '入力中の別の誕生日' } };
  await saveCalendarDraft(h.database, unfinished);
  await saveOwnBirthday(h.database, { date: '2000-02-29', timeZone: 'Asia/Tokyo', expectedRevision: 0 });
  await saveOwnBirthday(h.database, { date: '2000-03-01', timeZone: 'Asia/Tokyo', expectedRevision: 1 });
  const saved = await readLocalCalendar(h.database); const own = saved.events.find(row => row.id === OWN_BIRTHDAY_EVENT_ID);
  assert.equal(saved.events.length, 2); assert.deepEqual(saved.events.find(row => row.id === otherId), { ...other, id: otherId, revision: 1 });
  assert.equal(own.startDate, '2000-03-01'); assert.equal(own.revision, 2); assert.equal(own.title, '誕生日');
  assert.equal(own.allDay, true); assert.equal(own.birthday, true); assert.equal(own.recurrence, 'yearly'); assert.equal(own.notes, '');
  assert.equal(projectCalendarEvents([own], [], '2027-03-01', '2027-03-01').length, 1);
  assert.equal(saved.draft.value.title, unfinished.value.title);
  await assert.rejects(saveOwnBirthday(h.database, { date: '2000-05-01', timeZone: 'Asia/Tokyo', expectedRevision: 1 }), /別の画面/);
});
test('own birthday registration rejects concurrent copies and restores a cleared date without resetting revisions', async t => {
  const h = await fixture(t); const input = { date: '2000-02-29', timeZone: 'Asia/Tokyo', expectedRevision: 0 };
  const result = await Promise.allSettled([saveOwnBirthday(h.database, input), saveOwnBirthday(h.database, input)]);
  assert.equal(result.filter(row => row.status === 'fulfilled').length, 1);
  await deleteCalendarEvent(h.database, { id: OWN_BIRTHDAY_EVENT_ID, expectedRevision: 1 });
  await assert.rejects(saveCalendarEvent(h.database, { id: OWN_BIRTHDAY_EVENT_ID, expectedRevision: 0, value: { ...newEventDraft(input.date, input.timeZone, true), title: '一般予定からの復活' } }), /別の画面/);
  await saveOwnBirthday(h.database, input);
  const saved = (await readLocalCalendar(h.database)).events;
  assert.equal(saved.length, 1); assert.equal(saved[0].id, OWN_BIRTHDAY_EVENT_ID); assert.equal(saved[0].revision, 3);
  const stop = registerSharedRepositoryAdapter(h.database, { groupId: 'group', userId: 'owner', readSnapshot() {}, mutate() {} });
  t.after(stop); await assert.rejects(saveOwnBirthday(h.database, { ...input, expectedRevision: 3 }), /個人/);
});
for (const platform of ['ios', 'android']) test(`${platform} own birthday settings save only the committed date and expose no other peoples inputs`, async t => {
  const h = await fixture(t); let snapshot = await readLocalCalendar(h.database); let nativePicker;
  const local = { database: h.database, snapshot, loading: false, error: null, refresh: async () => { snapshot = await readLocalCalendar(h.database); local.snapshot = snapshot; } };
  const ui = screenHarness('src/features/calendar/birthday-settings.tsx', { exportName: 'BirthdaySettings', platform,
    layoutEffect: fn => fn(), effectDependencies: true, props: { database: h.database, today: '2026-11-09', timeZone: 'Asia/Tokyo' },
    datePicker: value => { nativePicker = value; }, mocks: { './use-local-calendar': { useLocalCalendar: () => local } } });
  t.after(() => ui.unmount());
  assert.equal(ui.nodes().some(row => row.type === 'TextInput'), false);
  await ui.press('自分の誕生日を選択');
  if (platform === 'ios') {
    const finish = ui.nodes().find(row => row.props.accessibilityLabel === '自分の誕生日の選択を完了').props.onPress;
    ui.nodes().find(row => row.type === 'DateTimePicker').props.onValueChange({}, new Date('2000-02-29T12:00:00Z'));
    assert.equal((await readLocalCalendar(h.database)).events.length, 0);
    finish();
  } else nativePicker.onValueChange({}, new Date('2000-02-29T12:00:00Z'));
  await flush(ui); assert.equal((await readLocalCalendar(h.database)).events[0].startDate, '2000-02-29');
  await ui.press('自分の誕生日を選択');
  if (platform === 'ios') await ui.press('日時選択を閉じる');
  else nativePicker.onValueChange({ type: 'dismissed' }, undefined);
  await flush(ui); assert.equal((await readLocalCalendar(h.database)).events[0].revision, 1);
});
test('calendar birthday classification registers another persons named annual event without changing the settings date', async t => {
  const h = await fixture(t); await saveOwnBirthday(h.database, { date: '2000-02-29', timeZone: 'Asia/Tokyo', expectedRevision: 0 });
  const local = { database: h.database, snapshot: await readLocalCalendar(h.database), loading: false, error: null, refresh: async () => {} };
  const ui = screenHarness('src/features/calendar/calendar-editor.tsx', { exportName: 'CalendarEditor',
    props: { initial: { eventId: null, revision: 0, exceptionRevision: 0, anchorDate: null, scope: 'series', value: newEventDraft('2026-04-02', 'Asia/Tokyo') }, local, onClose() {}, onSaved() {} } });
  t.after(() => ui.unmount()); await ui.change('予定名', '友人の誕生日'); await ui.press('分類を選択'); await ui.press('誕生日の分類を選択');
  await ui.press('予定を保存'); await flush(ui);
  const rows = (await readLocalCalendar(h.database)).events;
  assert.equal(rows.length, 2); const other = rows.find(row => row.id !== OWN_BIRTHDAY_EVENT_ID);
  assert.equal(other.title, '友人の誕生日'); assert.equal(other.birthday, true); assert.equal(other.allDay, true); assert.equal(other.recurrence, 'yearly');
  assert.equal(rows.find(row => row.id === OWN_BIRTHDAY_EVENT_ID).startDate, '2000-02-29');
});
