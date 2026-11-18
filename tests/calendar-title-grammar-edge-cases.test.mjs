import './helpers/typescript-loader.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import * as titles from '../src/features/calendar/title-datetime.ts';
import { newEventDraft } from '../src/domain/calendar/events.ts';
import { screenHarness } from './helpers/screen-harness.mjs';

const today = '2026-11-16', selected = '2026-11-20';

// Independent Gregorian oracle: deliberately avoid product date/recurrence helpers
// and Date arithmetic, so a shared month clamp or leap-year bug cannot self-verify.
const leap = year => year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
const monthLength = (year, month) => [31, leap(year) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
const civilText = ([year, month, day]) => `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
const civilParts = date => date.split('-').map(Number);
function advance(date, count = 1) {
  const parts = civilParts(date);
  for (let i = 0; i < count; i++) {
    parts[2]++;
    if (parts[2] > monthLength(parts[0], parts[1])) { parts[2] = 1; parts[1]++; }
    if (parts[1] > 12) { parts[1] = 1; parts[0]++; }
  }
  return civilText(parts);
}
function nextMonthDay(base, month, day) {
  const [year] = civilParts(base);
  for (let candidateYear = year; candidateYear <= year + 8; candidateYear++) {
    if (day > monthLength(candidateYear, month)) continue;
    const candidate = civilText([candidateYear, month, day]);
    if (candidate >= base) return candidate;
  }
  throw new Error('Oracle could not find the next valid month/day');
}
function weekday(date) {
  let [year, month, day] = civilParts(date);
  if (month < 3) year--;
  const offsets = [0, 3, 2, 5, 0, 3, 5, 1, 4, 6, 2, 4];
  return (year + Math.floor(year / 4) - Math.floor(year / 100) + Math.floor(year / 400) + offsets[month - 1] + day) % 7;
}
function nextWeekday(base, days) {
  for (let offset = 0; offset < 7; offset++) {
    const candidate = advance(base, offset);
    if (days.includes(weekday(candidate))) return candidate;
  }
  throw new Error('Oracle could not find the next weekday');
}
function nextMonthlyDate(base, days) {
  for (let offset = 0; offset < 63; offset++) {
    const candidate = advance(base, offset);
    if (days.includes(civilParts(candidate)[2])) return candidate;
  }
  throw new Error('Oracle could not find the next monthly date');
}
const weekRule = weekdays => ({ unit: 'week', interval: 1, weekdays });
const monthRule = days => ({ unit: 'month', interval: 1, on: 'dates', days });
const valueFor = (title, base = today, draft = newEventDraft(selected, 'Asia/Tokyo')) =>
  titles.createTitleDateTimeInput(draft, base).change(draft, title, true);

// Examine the entire family even when one case fails; print a bounded sample of
// reproducible inputs rather than stopping at the first failed calendar date.
function checkFamily(cases, run) {
  const failures = [];
  for (const value of cases) {
    try { run(value); } catch (error) { failures.push({ case: value, error: error.message }); }
  }
  assert.equal(failures.length, 0,
    `${failures.length}/${cases.length} scenarios failed; first failures: ${JSON.stringify(failures.slice(0, 6))}`);
}

const allMonthDays = [];
for (let month = 1; month <= 12; month++) {
  for (let day = 1; day <= monthLength(2028, month); day++) allMonthDays.push({ month, day });
}

test('title grammar independently checks all 366 yearless month days against next valid civil dates', () => {
  checkFamily(allMonthDays, ({ month, day }) => {
    const title = day % 2 ? `${month}月${day}日集まり` : `${month}/${day} 集まり`;
    const parsed = titles.parseTitleDateTime(title, today, selected);
    assert.equal(parsed?.date, nextMonthDay(today, month, day), title);
    assert.equal(parsed.recurrence, undefined);
    assert.equal(valueFor(title).title, title);
  });
});

test('title grammar independently checks all 366 yearly month days without inferring a birthday kind or clock', () => {
  checkFamily(allMonthDays, ({ month, day }) => {
    const title = `毎年${month}月${day}日お父さん誕生日`, parsed = titles.parseTitleDateTime(title, today, selected);
    assert.equal(parsed?.date, nextMonthDay(today, month, day), title);
    assert.equal(parsed.recurrence, 'yearly');
    assert.equal(parsed.minute, undefined);
    const value = valueFor(title);
    assert.equal(value.birthday, false); assert.equal(value.categoryId, 'personal');
    assert.equal(value.startMinute, 540); assert.equal(value.endMinute, 600);
    assert.equal(value.allDay, false); assert.equal(value.title, title);
  });
});

const leapAndYearBoundaries = [
  ['2月29日', '2024-02-28', '2024-02-29'], ['2/29', '2024-02-29', '2024-02-29'],
  ['2月29日', '2024-03-01', '2028-02-29'], ['毎年2月29日', '2099-12-31', '2104-02-29'],
  ['2月29日', '2399-12-31', '2400-02-29'], ['毎年2月29日', '2400-02-29', '2400-02-29'],
  ['12月31日', '2026-12-31', '2026-12-31'], ['1月1日', '2026-12-31', '2027-01-01'],
  ['今年1月1日', '2026-11-16', '2026-01-01'], ['2024年2月29日', today, '2024-02-29'],
  ['2024/12/31', today, '2024-12-31'], ['来年2月28日', today, '2027-02-28'],
  ['2028年 4月11日旅行', today, '2028-04-11'], ['二〇二八年　四月十一日旅行', today, '2028-04-11'],
];
test('title grammar keeps explicit years and follows century leap rules at same-day and year boundaries', () => {
  checkFamily(leapAndYearBoundaries, ([title, base, expected]) => {
    assert.equal(titles.parseTitleDateTime(title, base, selected)?.date, expected, title);
  });
});

test('title grammar accepts valid positional and unit-based Japanese numerals without losing date digits', () => {
  for (const [title, expected] of [
    ['二〇二四年二月二十九日旅行', '2024-02-29'], ['二千二十四年二月二十九日旅行', '2024-02-29'],
    ['毎月二十一日学校', '2026-11-21'], ['毎月二一日学校', '2026-11-21'],
    ['毎年五月二十二日旅行', '2027-05-22'], ['旅行四月十一日から一週間', '2027-04-11'],
  ]) assert.equal(titles.parseTitleDateTime(title, today, selected)?.date, expected, title);
});

// All finite weekday sets, across a Monday/Sunday week boundary. These are
// distinct supported recurrence states, not random strings or claimed bugs.
const weekCases = [];
for (let mask = 1; mask < 128; mask++) {
  const days = Array.from({ length: 7 }, (_, day) => day).filter(day => mask & (1 << day));
  for (const base of ['2026-11-16', '2026-11-22', '2026-12-31']) {
    weekCases.push({ days, base, title: `毎週${days.map(day => `${'日月火水木金土'[day]}曜日`).join('、')}ランチ` });
  }
}
test('title grammar preserves all 127 weekday sets across three civil week boundaries without inventing noon', () => {
  checkFamily(weekCases, ({ days, base, title }) => {
    const parsed = titles.parseTitleDateTime(title, base, selected);
    assert.equal(parsed?.date, nextWeekday(base, days), title);
    assert.equal(parsed.minute, undefined);
    assert.equal(parsed.recurrence, days.length === 1 ? 'weekly' : 'custom');
    assert.deepEqual(parsed.customRecurrence, days.length === 1 ? undefined : weekRule(days));
    assert.equal(valueFor(title, base).startMinute, 540);
  });
});

const monthlyCases = [];
const monthlyEdges = [1, 11, 12, 21, 28, 29, 30, 31];
for (let i = 0; i < monthlyEdges.length; i++) for (let j = i + 1; j < monthlyEdges.length; j++) {
  const days = [monthlyEdges[i], monthlyEdges[j]];
  for (const base of ['2026-01-31', '2026-02-28', '2028-02-28', '2026-12-31']) {
    monthlyCases.push({ days, base, title: `毎月${days.map(day => `${day}日`).join('、')}点検` });
  }
}
test('title grammar independently checks monthly date pairs around short leap and final months without clamping', () => {
  checkFamily(monthlyCases, ({ days, base, title }) => {
    const parsed = titles.parseTitleDateTime(title, base, selected);
    assert.equal(parsed?.date, nextMonthlyDate(base, days), title);
    assert.equal(parsed.recurrence, 'custom'); assert.deepEqual(parsed.customRecurrence, monthRule(days));
  });
});

const durationCases = [];
for (const base of ['2026-01-30', '2026-02-27', '2028-02-28', '2026-12-29', '2100-02-27', '2400-02-28']) {
  const [year, month, day] = civilParts(base);
  for (const days of [1, 6, 7, 14, 28, 29, 30, 31, 365, 366]) {
    for (const timed of [false, true]) {
      durationCases.push({ base, days, timed, title: `${year}年${month}月${day}日${timed ? '18時' : ''}から旅行${days}日間` });
    }
  }
}
test('title grammar counts inclusive all-day periods and same-clock timed periods across Gregorian boundaries', () => {
  checkFamily(durationCases, ({ base, days, timed, title }) => {
    const value = valueFor(title);
    assert.equal(value.startDate, base, title);
    assert.equal(value.endDate, advance(base, timed ? days : days - 1), title);
    assert.equal(value.allDay, !timed);
    if (timed) { assert.equal(value.startMinute, 1080); assert.equal(value.endMinute, 1080); }
    assert.equal(value.title, title);
  });
});

const weekDurationCases = [
  ['旅行4月11日から1週間', today, '2027-04-11', '2027-04-17', true],
  ['4月11日18時から1週間旅行', today, '2027-04-11', '2027-04-18', false],
  ['2028年2月27日から旅行2週間', today, '2028-02-27', '2028-03-11', true],
  ['2026年12月29日18時から2週間旅行', today, '2026-12-29', '2027-01-12', false],
  ['明日から親戚との集まり六日間', '2026-12-31', '2027-01-01', '2027-01-06', true],
  ['旅行　四月十一日から一週間', today, '2027-04-11', '2027-04-17', true],
  ['４月１１日１８時から１週間旅行', today, '2027-04-11', '2027-04-18', false],
];
test('title grammar interprets written week periods without treating relative weeks as durations', () => {
  checkFamily(weekDurationCases, ([title, base, start, end, allDay]) => {
    const value = valueFor(title, base);
    assert.equal(value.startDate, start); assert.equal(value.endDate, end); assert.equal(value.allDay, allDay);
  });
  for (const [title, expected] of [['1週間後旅行', '2026-11-23'], ['2週間後に旅行', '2026-11-30']]) {
    const value = valueFor(title); assert.equal(value.startDate, expected); assert.equal(value.endDate, expected);
    assert.equal(value.allDay, false);
  }
  assert.deepEqual(titles.parseTitleDateTime('4月11日18時から20時旅行', today, selected),
    { date: '2027-04-11', minute: 1080, endMinute: 1200, endDayOffset: 0, allDay: false });
  const sixDays = valueFor('4月11日から6日間旅行');
  assert.equal(sixDays.startDate, '2027-04-11'); assert.equal(sixDays.endDate, '2027-04-16'); assert.equal(sixDays.allDay, true);
});

const unconsumedGrammarTitles = [
  '26年4月11日旅行', '令和八年4月11日旅行', '令和8年4月11日旅行',
  '26年 4月11日旅行', '令和八年 4月11日旅行',
  '二万二千二十四年5月22日旅行', '10000年4月11日旅行', '0000年4月11日旅行', '24/4/11旅行',
  '4/11〜4/17旅行', '4/11から4/17旅行', '4月11日〜17日旅行', '4月11日から17日旅行',
  '来週の火曜日〜日曜日ランチ', '来週の火曜日から日曜日ランチ', '毎週火曜日〜日曜日ランチ',
  '毎月11日〜12日旅行', '毎年5月22日〜23日旅行', '毎年5月22日から23日旅行',
  '4/11〜17旅行', '4/11〜4/11旅行', '4月11日から4月11日旅行', '来週の火曜日〜来週の火曜日ランチ',
];
const rejectedTitles = [
  ...unconsumedGrammarTitles,
  // Dates are invalid or represent alternatives/exclusions rather than one plan.
  '毎年2月30日旅行', '毎年13月1日旅行', '2026年2月29日旅行', '今年2月29日旅行',
  '2026/2/30旅行', '2026年0月1日旅行', '4月31日旅行', '4月11日か12日旅行',
  '4月11日または12日旅行', '4月11日ではなく12日旅行', '明日ではなく来週旅行',
  '4月11日、12日旅行', '4月11日と12日旅行',
  '明日以外に旅行', '4月11日以降に旅行', '4月11日候補の旅行',
  '毎年5月22日か23日旅行', '毎年5月22日以外旅行', '毎年5月22日ではなく23日旅行',
  '毎年5月22日または8月22日旅行', '毎年5月22日と毎週火曜日旅行',
  '毎年5月22日、23日旅行', '毎年5月22日と23日旅行',
  // Moving a February yearly date to 24:00 would change its leap-year rule.
  '毎年2月28日24時集合', '毎年2月29日24時集合',
  // Malformed kanji numbers must not silently drop repeated digits/units.
  '毎月十十日旅行', '毎月二十一一日旅行', '毎年五月二十二二日旅行', '4月十一十一日旅行',
  // Partial rules cannot silently keep only the first valid member.
  '毎週火曜日か日曜日ランチ', '毎週火曜日または日曜日ランチ', '毎週火曜日、日曜日以外ランチ',
  '毎週火曜日ではなく日曜日ランチ', '毎週火曜日18時、日曜日12時ランチ',
  '毎週火曜日、毎月21日旅行', '毎週火曜日、', '毎月11日、', '毎月11日か12日旅行',
  '毎月11日、0日旅行', '毎月11日、32日旅行', '毎月11日から12日旅行',
  // No reference day, competing or excessive durations, or a changed inequality.
  '旅行1週間', '6日間旅行', '明日から0日間旅行', '明日から367日間旅行',
  '明日から53週間旅行', '明日から1.5週間旅行', '明日から1週間か2週間旅行',
  '明日から1週間以内旅行', '明日から1週間以上旅行', '明日から1週間以下旅行',
  '明日から6日間か7日間旅行', '明日18時から20時旅行6日間', '明日から-6日間旅行',
  // Ambiguous clocks/ranges cannot be partly interpreted as one precise clock.
  '毎年5月22日18時か19時旅行', '明日18時または19時旅行', '明日終日18時旅行',
  '明日11時間の作業', '明日11時台の作業', '明日11時前に集合', '明日11時以降に集合',
  '明日25時集合', '明日11:99集合', '明日午後18時集合', '明日18時から18時集合',
  '11:00以降に集合', '明日の10時以外は空き', '明日香さん',
  'https://example.com/4/11/18:00', 'https://example.com/毎年5月22日',
];
test('title grammar rejects alternative excluded invalid excessive and partially valid schedule expressions as a whole', () => {
  checkFamily(rejectedTitles, title => assert.equal(titles.parseTitleDateTime(title, today, selected), null, title));
});

const labels = [
  ['毎月21日学校', '学校'], ['毎週火曜日、日曜日ランチ', 'ランチ'],
  ['毎月11日、12日ハッカソン', 'ハッカソン'], ['毎年5月22日お父さん誕生日', 'お父さん誕生日'],
  ['彼女の誕生日、毎年8月22日', '彼女の誕生日'], ['旅行　4月11日から1週間', '旅行'],
  ['1月1日から親戚との集まり6日間', '親戚との集まり'],
  ['🧹🧺毎月二十一日　第１研究室でﾗﾝﾁ', '🧹🧺　第１研究室でﾗﾝﾁ'],
  ['㍿毎年八月二十二日第１研究室でﾗﾝﾁ', '㍿第１研究室でﾗﾝﾁ'],
  ['🧑🏽‍💻毎週火曜日、日曜日第１研究室', '🧑🏽‍💻第１研究室'],
  ['Café毎月１１日、１２日でﾗﾝﾁ', 'Caféでﾗﾝﾁ'],
  ['毎年８月２２日　六本木一丁目へ', '六本木一丁目へ'],
  ['第１研究室でﾗﾝﾁ　毎週火曜日、日曜日', '第１研究室でﾗﾝﾁ'],
  ['毎週火・日１８〜２０時に研究室', '研究室'],
  ['旅行　四月十一日から一週間', '旅行'],
  ['毎月21日 はじめての学校', 'はじめての学校'],
  ['毎月21日 のんびり', 'のんびり'],
  ['毎月21日 にこにこ食堂', 'にこにこ食堂'],
  ['毎月21日 からあげを食べる', 'からあげを食べる'],
  ['明日18時 からあげを食べる', 'からあげを食べる'],
  ['㍿毎週火曜日 にこにこ食堂', '㍿ にこにこ食堂'],
  ['毎月21日はじめての学校', 'はじめての学校'], ['毎月21日のんびり', 'のんびり'],
  ['毎月21日にこにこ食堂', 'にこにこ食堂'], ['明日18時からあげを食べる', 'からあげを食べる'],
  ['明日11時に予約', '予約'], ['予約11時頃', '予約'], ['11時頃予約', '予約'],
];
const unchangedLabels = [
  ...unconsumedGrammarTitles,
  '', ' ', '旅行', '毎年8月22日', '毎月21日', '明日から6日間',
  '毎週火曜か日曜ランチ', '4月11日か12日旅行', '2月30日旅行',
  'https://example.com/4/11/18:00', '六本木一丁目でﾗﾝﾁ', '第１研究室と㍿の打ち合わせ',
];
test('title grammar short labels remove source spans while preserving Unicode names and the complete stored sentence', () => {
  assert.equal(typeof titles.calendarTitleLabel, 'function', 'the planned display API must be implemented before this suite can pass');
  checkFamily(labels, ([title, label]) => {
    assert.equal(titles.calendarTitleLabel(title, today), label, title);
    assert.equal(titles.calendarTitleLabel(title, today, false), title);
    const value = valueFor(title); assert.equal(value.title, title); assert.equal(Object.hasOwn(value, 'displayTitle'), false);
  });
  checkFamily(unchangedLabels, title => {
    assert.equal(titles.calendarTitleLabel(title, today), title);
    assert.equal(titles.calendarTitleLabel(title, today, false), title);
  });
});

test('title grammar accepts explicit approximate dates clocks and durations as editable draft candidates without changing source titles', () => {
  for (const [title, minute] of [
    ['明日11時頃集合', 660], ['明日11時ごろ集合', 660], ['明日11:30頃集合', 690],
    ['明日11時くらい集合', 660], ['明日11時ぐらい集合', 660], ['明日午前11時半ごろ集合', 690],
    ['明日約11時集合', 660],
  ]) {
    assert.deepEqual(titles.parseTitleDateTime(title, today, selected), { date: '2026-11-17', minute, allDay: false });
    const value = valueFor(title);
    assert.equal(value.startDate, '2026-11-17'); assert.equal(value.startMinute, minute);
    assert.equal(value.endMinute, minute + 60); assert.equal(value.title, title);
    assert.equal(titles.calendarTitleLabel(title, today), '集合');
    assert.equal(titles.calendarTitleLabel(title, today, false), title);
  }
  for (const title of ['4月11日頃旅行', '約4/11旅行', '4/11ごろ旅行']) {
    assert.deepEqual(titles.parseTitleDateTime(title, today, selected), { date: '2027-04-11' });
    const value = valueFor(title);
    assert.equal(value.startDate, '2027-04-11'); assert.equal(value.endDate, '2027-04-11');
    assert.equal(value.startMinute, 540); assert.equal(value.allDay, false); assert.equal(value.title, title);
    assert.equal(titles.calendarTitleLabel(title, today), '旅行');
    assert.equal(titles.calendarTitleLabel(title, today, false), title);
  }
  for (const [title, date, recurrence, label] of [
    ['毎年5月22日ごろ旅行', '2027-05-22', 'yearly', '旅行'],
    ['毎月21日ごろ学校', '2026-11-21', 'monthly', '学校'],
  ]) {
    const value = valueFor(title); assert.equal(value.startDate, date); assert.equal(value.recurrence, recurrence);
    assert.equal(value.title, title); assert.equal(titles.calendarTitleLabel(title, today), label);
  }
  for (const title of ['明日から約1週間旅行', '明日から1週間程度旅行', '明日から1週間ほど旅行']) {
    const value = valueFor(title);
    assert.equal(value.startDate, '2026-11-17'); assert.equal(value.endDate, '2026-11-23'); assert.equal(value.allDay, true);
    assert.equal(value.title, title); assert.equal(titles.calendarTitleLabel(title, today), '旅行');
    assert.equal(titles.calendarTitleLabel(title, today, false), title);
  }
  for (const [title, end, allDay] of [
    ['4月11日頃から1週間ほど旅行', '2027-04-17', true],
    ['4月11日18時頃から約1週間旅行', '2027-04-18', false],
    ['約4/11 18時頃から1週間ほど旅行', '2027-04-18', false],
  ]) {
    const value = valueFor(title); assert.equal(value.startDate, '2027-04-11'); assert.equal(value.endDate, end);
    assert.equal(value.allDay, allDay); assert.equal(value.title, title);
    if (!allDay) { assert.equal(value.startMinute, 1080); assert.equal(value.endMinute, 1080); }
    assert.equal(titles.calendarTitleLabel(title, today), '旅行');
  }
  const noBody = '明日11時頃';
  assert.equal(titles.calendarTitleLabel(noBody, today), noBody);
});

test('title grammar keeps manually chosen boundaries and clears only automatic period and recurrence fields', () => {
  const original = { ...newEventDraft(selected, 'Asia/Tokyo'), location: '研究室', notes: '手入力メモ' };
  const input = titles.createTitleDateTimeInput(original, today);
  let value = input.change(original, '旅行4月11日18時から1週間', true);
  assert.equal(value.endDate, '2027-04-18');
  assert.deepEqual(input.change(value, '旅行', true), { ...original, title: '旅行' });
  value = input.change(original, '旅行4月11日18時から1週間', true);
  for (const field of ['startDate', 'endDate', 'startMinute', 'endMinute', 'allDay', 'recurrence']) input.manual(field);
  const manual = { ...value, startDate: '2027-05-01', endDate: '2027-05-06', startMinute: 600, endMinute: 720,
    allDay: false, recurrence: 'custom', customRecurrence: monthRule([1, 6]), untilDate: '2027-12-31' };
  for (const title of ['毎年8月22日誕生日', '旅行4月12日から6日間', '旅行']) {
    assert.deepEqual(input.change(manual, title, true), { ...manual, title });
  }
  for (const title of ['旅行4月11日から1週間', '毎年8月22日誕生日', '毎週火曜日、日曜日ランチ']) {
    assert.deepEqual(input.change(manual, title, false), { ...manual, title });
  }
});

test('title grammar does not mutate source drafts or alias inferred monthly and weekly day sets', () => {
  for (const title of ['毎月11日、12日ハッカソン', '毎週火曜日、日曜日ランチ']) {
    const initial = newEventDraft(selected, 'Asia/Tokyo'), before = structuredClone(initial);
    const input = titles.createTitleDateTimeInput(initial, today), one = input.change(initial, title, true);
    assert.deepEqual(initial, before);
    const inferredDays = one.customRecurrence?.days ?? one.customRecurrence?.weekdays;
    assert.ok(inferredDays); inferredDays.push(27);
    const two = input.change(one, title, true);
    assert.equal((two.customRecurrence?.days ?? two.customRecurrence?.weekdays).includes(27), false);
    assert.deepEqual(input.change(two, '食事', true), { ...initial, title: '食事' });
  }
});

for (const platform of ['ios', 'android']) {
  test(`${platform} yearly and duration inference stays outside existing duplicate birthday chore and readonly editors`, async t => {
    t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-11-16T03:00:00Z') });
    for (const kind of ['existing', 'duplicate', 'birthday', 'chore', 'readonly']) {
      const value = { ...newEventDraft(selected, 'Asia/Tokyo', kind === 'birthday'),
        title: ['existing', 'duplicate', 'readonly'].includes(kind) ? '元の名前' : '' };
      const initial = { eventId: ['existing', 'readonly'].includes(kind) ? 'protected.event' : null,
        anchorDate: null, revision: ['existing', 'readonly'].includes(kind) ? 1 : 0, exceptionRevision: 0, scope: 'series', value };
      const local = { database: {}, snapshot: { events: initial.eventId ? [{ ...value, id: initial.eventId, revision: 1 }] : [],
        exceptions: [], categories: [], drafts: [] }, refresh: async () => {},
        canEditEvent: () => kind !== 'readonly', saveEvent: async () => assert.fail('typing cannot save an event') };
      const props = { initial, local, onClose() {}, onSaved() {}, ...(kind === 'chore' ? {
        choreForm: { content: null, disabled: false, busy: false, entry: { value, onChange() {}, titleEditable: true } },
      } : {}) };
      const ui = screenHarness('src/features/calendar/calendar-editor.tsx', { exportName: 'CalendarEditor', platform, props });
      try {
        const inputLabel = kind === 'chore' ? '家事名' : '予定名';
        if (kind === 'readonly') {
          assert.equal(ui.nodes().find(node => node.type === 'TextInput' && node.props.accessibilityLabel === inputLabel)?.props.editable, false);
        } else for (const title of ['毎年8月22日お父さん誕生日', '旅行4月11日から1週間', '毎週火曜日、日曜日ランチ']) {
          await ui.change(inputLabel, title);
          assert.equal(ui.button(kind === 'birthday' ? '誕生日を選択' : '開始日を選択').props.accessibilityValue.text, '2026/11/20');
          if (kind !== 'birthday') {
            assert.equal(ui.button('終了日を選択').props.accessibilityValue.text, '2026/11/20');
            assert.equal(ui.button('開始を選択').props.accessibilityValue.text, '09:00');
            assert.equal(ui.button('終了を選択').props.accessibilityValue.text, '10:00');
            if (kind !== 'chore') assert.equal(ui.button('繰り返しを選択').props.accessibilityValue.text, '繰り返さない');
          }
        }
      } finally { ui.unmount(); }
    }
  });
}
