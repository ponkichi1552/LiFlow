import './helpers/typescript-loader.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { calendarMonthContentHeight, calendarMonthExpandedTitles, calendarMonthPreviewLayout, calendarMonthTimedPreviews, calendarMonthUsedHeight,
  MONTH_CELL_GAP, MONTH_EVENT_ROW_HEIGHT, MONTH_MAX_EVENT_ROWS, MONTH_MORE_HEIGHT } from '../src/features/calendar/month-density.ts';
import { calendarColorContrast, calendarEventAppearance, calendarMonthTitleColor } from '../src/features/calendar/event-appearance.ts';
import { calendarMonthTitleText } from '../src/features/calendar/month-title-text.ts';

test('month previews account for every hidden appointment without covering day labels or sacrificing appointments for extra title lines', () => {
  for (const base of [0, 96, 120, 170, 240]) for (const summary of [false, true]) for (const waste of [false, true]) for (const total of [0, 1, 2, 3, 4, 5, 9, 100]) {
    const height = calendarMonthContentHeight(base);
    const layout = calendarMonthPreviewLayout(height, total, summary, waste);
    assert.equal(layout.visible + layout.hidden, total);
    assert.ok(layout.visible >= 0 && layout.visible <= total);
    assert.ok(layout.visible <= MONTH_MAX_EVENT_ROWS || layout.visible === total && total === MONTH_MAX_EVENT_ROWS + 1);
    const moreHeight = layout.hidden ? MONTH_MORE_HEIGHT + MONTH_CELL_GAP : 0;
    const used = calendarMonthUsedHeight(layout.visible, summary, waste) + moreHeight + layout.extraLines * MONTH_EVENT_ROW_HEIGHT;
    assert.ok(used <= height, 'additional lines and +N must fit above the lower day labels');
    assert.ok(layout.extraLines >= 0 && layout.extraLines <= layout.visible);
    const events = Array.from({ length: total }, (_, i) => ({ id: String(i), startDate: '2026-11-14', startMinute: i * 5, allDay: i % 3 === 0 }));
    const times = calendarMonthTimedPreviews(events.slice(0, layout.visible), '2026-11-14', layout);
    if (times.size) {
      assert.equal(layout.hidden, 0, 'start times never take slots from hidden appointments');
      assert.equal(layout.extraLines, layout.visible, 'every appointment must have room for two title lines first');
      assert.ok(calendarMonthUsedHeight(layout.visible, summary, waste) + (layout.visible + times.size) * MONTH_EVENT_ROW_HEIGHT <= height);
    }
    if (layout.hidden && layout.visible < Math.min(total, MONTH_MAX_EVENT_ROWS)) {
      const nextHidden = total > layout.visible + 1;
      const another = calendarMonthUsedHeight(layout.visible + 1, summary, waste) + (nextHidden ? MONTH_MORE_HEIGHT + MONTH_CELL_GAP : 0);
      assert.ok(another > height, 'an extra title line must not displace an appointment');
    }
  }
});

test('month start times use only space left after every title fits two lines and preserve untimed events', () => {
  const rows = [
    { id: 'late', startDate: '2026-11-14', startMinute: 1020, allDay: false },
    { id: 'all-day', startDate: '2026-11-14', startMinute: 0, allDay: true },
    { id: 'early', startDate: '2026-11-14', startMinute: 480, allDay: false },
    { id: 'continuing', startDate: '2026-11-13', startMinute: 1320, allDay: false },
  ];
  const before = structuredClone(rows);
  for (const summary of [false, true]) for (const waste of [false, true]) {
    const titles = calendarMonthUsedHeight(rows.length, summary, waste) + rows.length * MONTH_EVENT_ROW_HEIGHT;
    const preview = (height, total = rows.length) => calendarMonthTimedPreviews(rows, '2026-11-14', calendarMonthPreviewLayout(height, total, summary, waste));
    assert.deepEqual([...preview(titles - 1)], []);
    assert.deepEqual([...preview(titles)], []);
    assert.deepEqual([...preview(titles + MONTH_EVENT_ROW_HEIGHT)], ['early']);
    assert.deepEqual([...preview(titles + 2 * MONTH_EVENT_ROW_HEIGHT)], ['early', 'late']);
    assert.deepEqual([...preview(titles + 10 * MONTH_EVENT_ROW_HEIGHT)], ['early', 'late']);
    assert.deepEqual([...preview(titles + 10 * MONTH_EVENT_ROW_HEIGHT, rows.length + 2)], []);
  }
  assert.deepEqual(rows, before, 'displaying start times does not modify events or invent times for all-day and continuing entries');
});

test('a last fitting month appointment replaces plus one without taking room from chores or waste', () => {
  const total = MONTH_MAX_EVENT_ROWS + 1;
  const ordinary = calendarMonthPreviewLayout(calendarMonthContentHeight(0), total, false, false);
  assert.equal(ordinary.visible, total); assert.equal(ordinary.hidden, 0);
  for (const summary of [false, true]) for (const waste of [false, true]) {
    const height = calendarMonthUsedHeight(total, summary, waste);
    const full = calendarMonthPreviewLayout(height, total, summary, waste);
    assert.equal(full.visible, total); assert.equal(full.hidden, 0); assert.equal(full.extraLines, 0);
    const short = calendarMonthPreviewLayout(height - 1, total, summary, waste);
    assert.ok(short.hidden > 0);
    assert.ok(calendarMonthUsedHeight(short.visible, summary, waste) + MONTH_MORE_HEIGHT + MONTH_CELL_GAP <= height - 1);
  }
});

test('month title previews wrap mixed Latin text without altering source names or splitting composed characters', () => {
  const title = 'あdfkldsjfkdsjfkljf；jfdkj；fさ';
  assert.equal(calendarMonthTitleText(title), title);
  assert.equal(calendarMonthTitleText(title, true).replace(/\u200b/gu, ''), title);
  assert.ok(calendarMonthTitleText(title, true).includes('d\u200bf\u200bk'));
  for (const text of ['👨‍👩‍👧‍👦', 'か\u3099', 'e\u0301', '🇯🇵', '✈️']) assert.equal(calendarMonthTitleText(text, true), text);
  assert.equal(calendarMonthTitleText('名前\n\t詳細'), '名前 詳細');
});

test('spare month title lines go to the earliest long appointments without reordering or changing source records', () => {
  const rows = [
    { id: 'all-day', startDate: '2026-11-14', startMinute: 0, allDay: true },
    { id: 'late', startDate: '2026-11-14', startMinute: 1200, allDay: false },
    { id: 'short', startDate: '2026-11-14', startMinute: 360, allDay: false },
    { id: 'early', startDate: '2026-11-14', startMinute: 480, allDay: false },
    { id: 'overnight', startDate: '2026-11-13', startMinute: 1320, allDay: false },
  ];
  const before = structuredClone(rows); const overflowing = new Set(['all-day', 'early', 'late', 'overnight']);
  assert.deepEqual([...calendarMonthExpandedTitles(rows, overflowing, 0)], []);
  assert.deepEqual([...calendarMonthExpandedTitles(rows, overflowing, 1)], ['overnight']);
  assert.deepEqual([...calendarMonthExpandedTitles(rows, overflowing, 2)], ['overnight', 'early']);
  assert.deepEqual([...calendarMonthExpandedTitles(rows, overflowing, 4)], ['overnight', 'early', 'late', 'all-day']);
  assert.deepEqual(rows, before);
});

test('month title brightening retains classification contrast and leaves light and other calendar text unchanged', () => {
  for (const source of ['#FFFFFF', '#000000', '#FFFF00', '#348DC2', '#009882', '#8652BF']) for (const dark of [false, true]) {
    const appearance = calendarEventAppearance(source, dark); const before = structuredClone(appearance);
    const foreground = calendarMonthTitleColor(appearance.foregroundColor, dark);
    assert.ok(calendarColorContrast(foreground, appearance.backgroundColor) >= 4.5);
    if (!dark) assert.equal(foreground, appearance.foregroundColor);
    assert.deepEqual(appearance, before);
  }
});
