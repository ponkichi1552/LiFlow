import './helpers/typescript-loader.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseTitleDateTime, createTitleDateTimeInput } from '../src/features/calendar/title-datetime.ts';
import { newEventDraft } from '../src/features/calendar/events.ts';
const today = '2026-11-15', selected = '2026-11-20';

test('calendar title date grammar resolves Japanese relative dates from Monday weeks without AI or changing the title', () => {
  for (const [title, expected] of [
    ['11時に集合', { minute: 660, allDay: false }], ['１１時３０分に集合', { minute: 690, allDay: false }],
    ['来週の火曜日18時から友達と食事', { date: '2026-11-17', minute: 1080, allDay: false }],
    ['再来週月曜 午後3時半', { date: '2026-11-23', minute: 930, allDay: false }],
    ['今週の月曜日11:30', { date: '2026-11-09', minute: 690, allDay: false }],
    ['二週間後の火曜日', { date: '2026-11-24' }], ['2週間後に旅行', { date: '2026-11-29' }],
    ['一年後に点検', { date: '2027-11-15' }], ['来月に点検', { date: '2026-12-15' }], ['来月10日に点検', { date: '2026-12-10' }],
    ['明日11時半', { date: '2026-11-16', minute: 690, allDay: false }], ['明後日は終日休み', { date: '2026-11-17', allDay: true }],
    ['2027年1月3日 9時', { date: '2027-01-03', minute: 540, allDay: false }], ['2027/1/3 09:05', { date: '2027-01-03', minute: 545, allDay: false }],
    ['明日23時から1時', { date: '2026-11-16', minute: 1380, endMinute: 60, endDayOffset: 1, allDay: false }],
    ['18:00〜20:30に食事', { minute: 1080, endMinute: 1230, endDayOffset: 0, allDay: false }],
    ['24時に集合', { date: '2026-11-21', minute: 0, allDay: false }],
    ['18〜20時に食事', { minute: 1080, endMinute: 1200, endDayOffset: 0, allDay: false }],
    ['夜12時に集合', { minute: 0, allDay: false }], ['来月末に支払', { date: '2026-12-31' }], ['来年1月3日に旅行', { date: '2027-01-03' }], ['来年末に点検', { date: '2027-12-31' }],
    ['午前12時に出発', { minute: 0, allDay: false }], ['午後12時に食事', { minute: 720, allDay: false }],
  ]) assert.deepEqual(parseTitleDateTime(title, today, selected), expected, title);
});

test('calendar title date grammar handles month ends leap years and civil year boundaries', () => {
  for (const [title, base, expected] of [
    ['来月', '2026-01-31', '2026-02-28'], ['来月', '2028-01-31', '2028-02-29'], ['1年後', '2028-02-29', '2029-02-28'],
    ['明日', '2026-12-31', '2027-01-01'], ['来週火曜日', '2026-12-31', '2027-01-05'], ['再来月', '2026-12-31', '2027-02-28'],
  ]) assert.equal(parseTitleDateTime(title, base, base).date, expected);
});

test('calendar title date grammar refuses conflicting invalid vague and duration-only input', () => {
  for (const title of ['友達と食事', '来週火鍋を食べる2時間', '11時間の作業', '11時台に集合', '11時前に集合', '11時以降に集合',
    '明日か明後日11時', '2月30日11時', '2026年2月29日', '来月32日', '25時に集合', '11:99', '午後18時',
    '11時に集合して18時に解散', '終日11時から', '18時から18時', '来月上旬に点検', 'https://example.com/11:00'])
    assert.equal(parseTitleDateTime(title, today, selected), null, title);
});

test('calendar title automatic fields preserve duration restore removed expressions and respect manual date and clock choices', () => {
  const original = newEventDraft(selected, 'Asia/Tokyo'), input = createTitleDateTimeInput(original, today);
  let value = input.change(original, '来週の火曜日18時から友達と食事', true);
  assert.equal(value.title, '来週の火曜日18時から友達と食事'); assert.equal(value.startDate, '2026-11-17'); assert.equal(value.startMinute, 1080); assert.equal(value.endMinute, 1140);
  value = input.change(value, '友達と食事', true); assert.deepEqual(value, { ...original, title: '友達と食事' });
  input.manual('startDate'); value = { ...value, startDate: '2026-12-10', endDate: '2026-12-10' };
  value = input.change(value, '明日11時に食事', true); assert.equal(value.startDate, '2026-12-10'); assert.equal(value.endDate, '2026-12-10'); assert.equal(value.startMinute, 660);
  input.manual('startMinute'); value = { ...value, startMinute: 900, endMinute: 960 };
  value = input.change(value, '明日18時に食事', true); assert.equal(value.startMinute, 900); assert.equal(value.endMinute, 960);
  value = input.change(value, '食事', true); assert.equal(value.startDate, '2026-12-10'); assert.equal(value.startMinute, 900);
  input.manual('endMinute'); value = { ...value, endMinute: 1200 };
  value = input.change(value, '18時から19時', true); assert.equal(value.endMinute, 1200);
});

test('calendar title input cannot rewrite existing chore birthday or readonly values when automatic input is disabled', () => {
  const original = newEventDraft(selected, 'Asia/Tokyo'), input = createTitleDateTimeInput(original, today);
  assert.deepEqual(input.change(original, '明日18時', false), { ...original, title: '明日18時' });
  const value = input.change(original, '明日23時から1時', true);
  assert.equal(value.endDate, '2026-11-17'); assert.equal(value.endMinute, 60);
});
