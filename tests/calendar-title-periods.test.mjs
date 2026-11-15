import './helpers/typescript-loader.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import * as titleInput from '../src/features/calendar/title-datetime.ts';
import { newEventDraft, projectCalendarEvents } from '../src/domain/calendar/events.ts';
import { googleEventBody } from '../src/features/calendar/google-event-mapping.ts';
import { screenHarness } from './helpers/screen-harness.mjs';
import { createDatabase } from './helpers/sqlite.mjs';
const storage = await import('../src/platform/storage/calendar-events.ts');
const { initializeLocalDatabase } = await import('../src/platform/storage/repository.ts');
const today = '2026-11-16', selected = '2026-11-20';
const cases = [
  ['毎月21日学校', '2026-11-21', '2026-11-21', 'monthly', false, '学校'],
  ['毎週火曜日、日曜日ランチ', '2026-11-17', '2026-11-17', 'custom', false, 'ランチ'],
  ['毎月11日、12日ハッカソン', '2026-12-11', '2026-12-11', 'custom', false, 'ハッカソン'],
  ['毎年5月22日お父さん誕生日', '2027-05-22', '2027-05-22', 'yearly', false, 'お父さん誕生日'],
  ['彼女の誕生日、毎年8月22日', '2027-08-22', '2027-08-22', 'yearly', false, '彼女の誕生日'],
  ['旅行　4月11日から1週間', '2027-04-11', '2027-04-17', 'none', true, '旅行'],
  ['1月1日から親戚との集まり6日間', '2027-01-01', '2027-01-06', 'none', true, '親戚との集まり'],
];
const change = (title, base = today) => {
  const original = newEventDraft(selected, 'Asia/Tokyo');
  return titleInput.createTitleDateTimeInput(original, base).change(original, title, true);
};

test('all seven requested calendar sentences resolve their full period and recurrence while preserving the original title', () => {
  for (const [title, start, end, recurrence, allDay] of cases) {
    const value = change(title); assert.equal(value.title, title); assert.equal(value.startDate, start, title);
    assert.equal(value.endDate, end, title); assert.equal(value.recurrence, recurrence, title); assert.equal(value.allDay, allDay, title);
    assert.equal(value.birthday, false, 'a word in the title cannot alter the birthday kind or audience');
  }
});

test('yearless and yearly dates seek the next actual date and explicit past years remain explicit', () => {
  for (const [title, base, expected] of [
    ['4月11日旅行', today, '2027-04-11'], ['1/1 集合', today, '2027-01-01'],
    ['11月16日', today, today], ['毎年2月29日', today, '2028-02-29'], ['2月29日', '2029-03-01', '2032-02-29'],
    ['毎年8月22日', '2026-08-22', '2026-08-22'], ['毎年8月22日', '2026-08-23', '2027-08-22'],
    ['2024年2月29日', today, '2024-02-29'], ['2024/4/11', today, '2024-04-11'],
  ]) assert.equal(titleInput.parseTitleDateTime(title, base, selected)?.date, expected, title);
  const value = change('毎年2月29日');
  assert.deepEqual(projectCalendarEvents([{ ...value, id: 'leap.title', revision: 1 }], [], '2029-01-01', '2029-12-31'), []);
  for (const title of ['毎年2月30日', '毎年13月1日', '毎年5月', '毎年5月22日か23日', '毎年5月22日以外', '毎年5月22日と毎週火曜']) {
    assert.equal(titleInput.parseTitleDateTime(title, today, selected), null, title);
  }
});

test('explicit day and week durations count civil days and timed durations retain the written clock through year changes', () => {
  const week = change('2026年12月29日から旅行1週間'); assert.equal(week.startDate, '2026-12-29'); assert.equal(week.endDate, '2027-01-04'); assert.equal(week.allDay, true);
  const timed = change('4月11日18時から1週間旅行');
  assert.equal(timed.startDate, '2027-04-11'); assert.equal(timed.endDate, '2027-04-18');
  assert.equal(timed.startMinute, 1080); assert.equal(timed.endMinute, 1080); assert.equal(timed.allDay, false);
  const one = change('明日から1日間旅行'); assert.equal(one.startDate, '2026-11-17'); assert.equal(one.endDate, '2026-11-17');
  assert.equal(change('2週間後に旅行').startDate, '2026-11-30');
  for (const title of ['旅行1週間', '6日間', '明日から0日間', '明日から367日間', '明日から1.5週間', '明日から1週間か2週間', '明日18時から20時旅行6日間']) {
    assert.equal(titleInput.parseTitleDateTime(title, today, selected), null, title);
  }
});

test('title display removes parsed schedule tokens at either end without normalizing names or making an empty title', () => {
  for (const [title, , , , , label] of cases) {
    assert.equal(titleInput.calendarTitleLabel(title, today), label, title);
    assert.equal(titleInput.calendarTitleLabel(title, today, false), title);
  }
  for (const [title, expected] of [
    ['🧹毎月二十一日　第１研究室でﾗﾝﾁ', '🧹　第１研究室でﾗﾝﾁ'],
    ['毎週火・日１８〜２０時に研究室', '研究室'], ['研究室　毎週火曜日、日曜日', '研究室'],
    ['毎月21日', '毎月21日'], ['毎週火曜か日曜ランチ', '毎週火曜か日曜ランチ'],
    ['予定名に日時なし', '予定名に日時なし'], ['2月30日集合', '2月30日集合'],
  ]) assert.equal(titleInput.calendarTitleLabel(title, today), expected, title);
});

test('all requested sentences send the selected Google title style while keeping recurrence and complete day periods intact', () => {
  for (const [title, start, end, recurrence, allDay, label] of cases) {
    const value = change(title), body = googleEventBody(value, false, true), raw = googleEventBody(value, false, false);
    assert.equal(body.summary, label, title); assert.equal(raw.summary, title); assert.equal(value.title, title);
    assert.deepEqual(body.start, raw.start); assert.deepEqual(body.end, raw.end); assert.deepEqual(body.recurrence, raw.recurrence);
    if (allDay) {
      assert.equal(body.start.date, start);
      assert.equal(body.end.date, new Date(Date.parse(`${end}T00:00:00Z`) + 86400000).toISOString().slice(0, 10));
    }
    if (recurrence === 'yearly') assert.ok(body.recurrence[0].includes('FREQ=YEARLY'));
    if (title.includes('毎月11日')) assert.ok(body.recurrence[0].includes('BYMONTHDAY=11,12'));
    if (title.includes('毎週火曜日')) assert.ok(body.recurrence[0].includes('BYDAY=SU,TU'));
  }
});

test('period removal restores automatic values and manual period boundaries remain authoritative', () => {
  const original = newEventDraft(selected, 'Asia/Tokyo'), input = titleInput.createTitleDateTimeInput(original, today);
  let value = input.change(original, '旅行4月11日から1週間', true); assert.equal(value.allDay, true);
  assert.deepEqual(input.change(value, '旅行', true), { ...original, title: '旅行' });
  value = input.change(original, '旅行4月11日から1週間', true); input.manual('endDate'); input.manual('allDay');
  value = { ...value, endDate: '2027-05-01', allDay: false };
  const changed = input.change(value, '旅行4月12日から6日間', true);
  assert.equal(changed.endDate, '2027-05-01'); assert.equal(changed.allDay, false);
});

for (const platform of ['ios', 'android']) test(`${platform} requested calendar title examples save original names and complete civil periods through the normal editor`, async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-11-16T03:00:00Z') });
  const h = createDatabase(); t.after(() => h.connection.close()); await initializeLocalDatabase(h.database);
  for (const [title, start, end, recurrence, allDay] of cases) {
    const initial = { eventId: null, anchorDate: null, revision: 0, exceptionRevision: 0, scope: 'series', value: newEventDraft(selected, 'Asia/Tokyo') };
    const ui = screenHarness('src/features/calendar/calendar-editor.tsx', { exportName: 'CalendarEditor', platform,
      props: { initial, local: { database: h.database, snapshot: await storage.readLocalCalendar(h.database), refresh: async () => {} }, onClose() {}, onSaved() {} } });
    try {
      await ui.change('予定名', title); await ui.press('予定を保存'); for (let i = 0; i < 20; i++) await ui.flush();
      const value = (await storage.readLocalCalendar(h.database)).events.find(row => row.title === title); assert.ok(value, ui.text());
      assert.equal(value.startDate, start); assert.equal(value.endDate, end); assert.equal(value.recurrence, recurrence); assert.equal(value.allDay, allDay);
      assert.equal(value.title, title); assert.equal(Object.hasOwn(value, 'displayTitle'), false);
    } finally { ui.unmount(); }
  }
});
