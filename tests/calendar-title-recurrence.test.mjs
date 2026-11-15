import './helpers/typescript-loader.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseTitleDateTime, createTitleDateTimeInput } from '../src/features/calendar/title-datetime.ts';
import { newEventDraft, projectCalendarEvents } from '../src/features/calendar/events.ts';
import { screenHarness } from './helpers/screen-harness.mjs';
import { createDatabase } from './helpers/sqlite.mjs';
const repository = await import('../src/platform/storage/repository.ts');
const calendars = await import('../src/platform/storage/calendar-events.ts');
const today = '2026-11-15', selected = '2026-11-20';

test('calendar title weekly and monthly expressions choose the first matching civil date and recurrence without altering the sentence', () => {
  for (const [title, base, expected] of [
    ['毎週火曜日18時から食事', today, { date: '2026-11-17', minute: 1080, allDay: false, recurrence: 'weekly' }],
    ['🧹🧺毎週火曜日18時から掃除', today, { date: '2026-11-17', minute: 1080, allDay: false, recurrence: 'weekly' }],
    ['毎週の火曜18時から20時に食事', today, { date: '2026-11-17', minute: 1080, endMinute: 1200, endDayOffset: 0, allDay: false, recurrence: 'weekly' }],
    ['毎週 火曜日', '2026-11-17', { date: '2026-11-17', recurrence: 'weekly' }],
    ['毎週日曜日', today, { date: today, recurrence: 'weekly' }],
    ['毎週火曜日', '2026-11-18', { date: '2026-11-24', recurrence: 'weekly' }],
    ['毎週火曜24時', today, { date: '2026-11-18', minute: 0, allDay: false, recurrence: 'weekly' }],
    ['毎月21日に支払い', today, { date: '2026-11-21', recurrence: 'monthly' }],
    ['📅💰毎月21日に支払い', today, { date: '2026-11-21', recurrence: 'monthly' }],
    ['毎月の２１日 午後３時半', today, { date: '2026-11-21', minute: 930, allDay: false, recurrence: 'monthly' }],
    ['毎月二十一日', '2026-11-21', { date: '2026-11-21', recurrence: 'monthly' }],
    ['毎月21日', '2026-11-22', { date: '2026-12-21', recurrence: 'monthly' }],
    ['毎月31日', '2026-04-30', { date: '2026-05-31', recurrence: 'monthly' }],
    ['毎月30日', '2026-01-31', { date: '2026-03-30', recurrence: 'monthly' }],
    ['毎月29日', '2028-02-01', { date: '2028-02-29', recurrence: 'monthly' }],
    ['毎月21日', '2026-12-22', { date: '2027-01-21', recurrence: 'monthly' }],
    ['12月1日から毎週火曜日18時', today, { date: '2026-12-01', minute: 1080, allDay: false, recurrence: 'weekly' }],
    ['来月21日から毎月21日に支払い', today, { date: '2026-12-21', recurrence: 'monthly' }],
  ]) assert.deepEqual(parseTitleDateTime(title, base, selected), expected, title);
});

test('calendar title recurrence refuses incomplete conflicting excluded and unsupported period expressions', () => {
  for (const title of ['毎週', '毎月', '毎月21', '毎週18時', '毎月21時', '毎週火鍋を食べる18時',
    '毎月0日', '毎月32日', '毎月121日', '毎月21日間', '毎月21日か22日', '毎月21日と22日',
    '毎週火曜日と木曜日', '毎週火・木', '毎週火曜日以外', '毎週火曜日は除く',
    '毎週火曜日ではなく', '毎週火曜日じゃなく', '毎週火曜日の前日', '毎月21日より前',
    '毎週火曜日と毎月21日', '来週水曜日から毎週火曜日', '12月22日から毎月21日',
    '毎月31日24時', '毎月21日24時', '毎日18時', '毎年1月1日', '隔週火曜日',
    '毎週火曜日18時か19時', '毎週火曜日終日18時']) {
    assert.equal(parseTitleDateTime(title, today, selected), null, title);
  }
});

test('calendar title monthly input keeps real month-end anchors and overnight spans through year boundaries', () => {
  const original = newEventDraft(selected, 'Asia/Tokyo');
  const value = createTitleDateTimeInput(original, today).change(original, '毎月31日23時から1時に点検', true);
  assert.equal(value.startDate, '2026-12-31'); assert.equal(value.endDate, '2027-01-01');
  assert.equal(value.recurrence, 'monthly'); assert.equal(value.startMinute, 1380); assert.equal(value.endMinute, 60);
  const rows = projectCalendarEvents([{ ...value, id: 'qa-monthly', revision: 1 }], [], '2026-12-01', '2027-04-01');
  assert.deepEqual(rows.map(row => [row.startDate, row.endDate]), [
    ['2026-12-31', '2027-01-01'], ['2027-01-31', '2027-02-01'], ['2027-03-31', '2027-04-01'],
  ]);
});

test('calendar title recurrence restores only automatic values and protects chosen recurrence and custom rules', () => {
  const original = newEventDraft(selected, 'Asia/Tokyo'), input = createTitleDateTimeInput(original, today);
  let value = input.change(original, '毎週火曜日18時から食事', true);
  assert.equal(value.recurrence, 'weekly'); assert.equal(value.startDate, '2026-11-17');
  value = input.change(value, '食事', true); assert.deepEqual(value, { ...original, title: '食事' });
  value = input.change(value, '毎月21日に食事', true); assert.equal(value.recurrence, 'monthly');
  input.manual('recurrence'); input.manual('startDate');
  const rule = { unit: 'week', interval: 2, weekdays: [1, 4] };
  value = { ...value, recurrence: 'custom', customRecurrence: rule, untilDate: '2027-02-01', startDate: '2026-12-03' };
  value = input.change(value, '毎週火曜日19時から食事', true);
  assert.equal(value.recurrence, 'custom'); assert.deepEqual(value.customRecurrence, rule);
  assert.equal(value.untilDate, '2027-02-01'); assert.equal(value.startDate, '2026-12-03');
  value = input.change(value, '食事', true); assert.equal(value.recurrence, 'custom'); assert.deepEqual(value.customRecurrence, rule);
  const preset = { ...original, recurrence: 'monthly', untilDate: '2027-02-20' };
  const retained = createTitleDateTimeInput(preset, today).change(preset, '毎週火曜日18時', true);
  assert.equal(retained.recurrence, 'monthly'); assert.equal(retained.untilDate, '2027-02-20');
  assert.deepEqual(createTitleDateTimeInput(original, today).change(original, '毎月21日', false), { ...original, title: '毎月21日' });
});

for (const [platform, saveName, manualName] of [
  ['ios', 'ios recurring title input saves matching weekly and monthly schedules exactly once',
    'ios manually selected recurrence and end date survive later title input and audience changes'],
  ['android', 'android recurring title input saves matching weekly and monthly schedules exactly once',
    'android manually selected recurrence and end date survive later title input and audience changes'],
]) {
  test(saveName, async t => {
    t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-11-15T03:00:00Z') });
    for (const [title, recurrence, startDate, starts] of [
      ['毎週火曜日18時から食事', 'weekly', '2026-11-17', ['2026-11-17', '2026-11-24', '2026-12-01']],
      ['毎月21日に支払い', 'monthly', '2026-11-21', ['2026-11-21', '2026-12-21']],
    ]) {
      const h = createDatabase(); const saved = [];
      try {
        await repository.initializeLocalDatabase(h.database);
        const local = { database: h.database, snapshot: await calendars.readLocalCalendar(h.database), refresh: async () => {} };
        const initial = { eventId: null, anchorDate: null, revision: 0, exceptionRevision: 0, scope: 'series', value: newEventDraft(selected, 'Asia/Tokyo') };
        const ui = screenHarness('src/features/calendar/calendar-editor.tsx', { exportName: 'CalendarEditor', platform, props: { initial, local, onClose() {}, onSaved: date => saved.push(date) } });
        try {
          await ui.change('予定名', title); assert.equal((await calendars.readLocalCalendar(h.database)).events.length, 0);
          assert.equal(ui.button('開始日を選択').props.accessibilityValue.text, startDate.replaceAll('-', '/'));
          assert.equal(ui.button('繰り返しを選択').props.accessibilityValue.text, recurrence === 'weekly' ? '毎週' : '毎月');
          await ui.press('予定を保存'); for (let i = 0; i < 16; i++) await ui.flush();
          const state = await calendars.readLocalCalendar(h.database); assert.equal(state.events.length, 1);
          const event = state.events[0]; assert.equal(event.title, title); assert.equal(event.recurrence, recurrence); assert.equal(event.startDate, startDate);
          assert.deepEqual(projectCalendarEvents(state.events, state.exceptions, '2026-11-15', recurrence === 'weekly' ? '2026-12-01' : '2026-12-31').map(row => row.startDate), starts);
          assert.deepEqual(saved, [startDate]);
        } finally { ui.unmount(); }
      } finally { h.connection.close(); }
    }
  });
  test(manualName, async t => {
    t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-11-15T03:00:00Z') }); const writes = [];
    const local = { database: {}, snapshot: { events: [], exceptions: [], categories: [], drafts: [] }, refresh: async () => {},
      shared: { enabled: true, groupId: 'qa-group', name: 'QA' }, saveEvent: async value => writes.push(value) };
    const initial = { eventId: null, anchorDate: null, revision: 0, exceptionRevision: 0, scope: 'series', value: newEventDraft(selected, 'Asia/Tokyo') };
    const ui = screenHarness('src/features/calendar/calendar-editor.tsx', { exportName: 'CalendarEditor', platform, props: { initial, local, onClose() {}, onSaved() {} } }); t.after(() => ui.unmount());
    const choose = async recurrence => {
      await ui.press('繰り返しを選択');
      if (platform === 'ios') { ui.nodes().find(row => row.props.testID === 'calendar-option-wheel').props.onValueChange(recurrence); await ui.flush(); await ui.press('繰り返しの選択を完了'); }
      else await ui.press(recurrence === 'none' ? '繰り返さない' : '毎月');
    };
    await ui.change('予定名', '毎週火曜日18時');
    const firstUntil = ui.nodes().find(row => row.props.accessibilityRole === 'checkbox' && row.props.accessibilityLabel === '繰り返しに終了日を設定');
    assert.ok(firstUntil); await firstUntil.props.onPress(); await ui.flush();
    await ui.change('予定名', '食事'); assert.equal(ui.button('繰り返しを選択').props.accessibilityValue.text, '毎週');
    await choose('none');
    await ui.change('予定名', '毎週水曜日19時'); assert.equal(ui.button('繰り返しを選択').props.accessibilityValue.text, '繰り返さない');
    await choose('monthly');
    const until = ui.nodes().find(row => row.props.accessibilityRole === 'checkbox' && row.props.accessibilityLabel === '繰り返しに終了日を設定');
    assert.ok(until); await until.props.onPress(); await ui.flush();
    await ui.change('予定名', '毎週木曜日20時'); await ui.press('グループ共通');
    assert.equal(ui.button('繰り返しを選択').props.accessibilityValue.text, '毎月');
    await ui.press('予定を保存'); for (let i = 0; i < 16; i++) await ui.flush();
    assert.equal(writes.length, 1); assert.equal(writes[0].audience, 'group'); assert.equal(writes[0].groupId, 'qa-group');
    assert.equal(writes[0].value.recurrence, 'monthly'); assert.ok(writes[0].value.untilDate);
    assert.equal(writes[0].value.title, '毎週木曜日20時'); assert.equal(writes[0].value.startMinute, 1200);
  });
}
