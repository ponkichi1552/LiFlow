import { openCalendarDay } from './helpers/calendar-ui.mjs';
import './helpers/typescript-loader.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { wasteCalendarLabels } from '../src/features/waste/calendar-labels.ts';
import { calendarWasteLabel, wasteTypeColor } from '../src/features/waste/type-appearance.ts';
import { WASTE_TYPES } from '../src/features/waste/waste-types.ts';
import { localDateFromDate, weekdayOf } from '../src/domain/scheduling/local-date.ts';
import { DEFAULT_CALENDAR_COUNT_COLORS } from '../src/domain/calendar/count-colors.ts';
import { screenHarness } from './helpers/screen-harness.mjs';

test('waste appearance: each standard type has a stable readable color and aliases share that color', () => {
  assert.equal(new Set(WASTE_TYPES.map((type) => wasteTypeColor(type.label))).size, WASTE_TYPES.length);
  for (const type of WASTE_TYPES) {
    for (const alias of type.aliases) assert.equal(wasteTypeColor(alias), wasteTypeColor(type.label));
    const rgb = wasteTypeColor(type.label).slice(1).match(/../g).map((value) => parseInt(value, 16) / 255);
    const [r, g, b] = rgb.map((value) => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
    assert.ok(1.05 / (0.2126 * r + 0.7152 * g + 0.0722 * b + 0.05) >= 4.5, `${type.label}: insufficient contrast on white`);
  }
  assert.equal(wasteTypeColor(' 可燃ゴミ '), wasteTypeColor('可燃ごみ'));
  assert.equal(wasteTypeColor('独自ゴミ'), wasteTypeColor('独自ごみ'));
  assert.equal(calendarWasteLabel('容器包装プラスチック'), '容器プラ');
});

test('waste appearance: only hidden weekly collection dates get grey-date information', () => {
  const definitions = [
    { id: 'weekly', householdId: 'home', label: '可燃ごみ', collectionWeekdays: [2], recurrence: 'weekly' },
    { id: 'biweekly', householdId: 'home', label: 'びん', collectionWeekdays: [4], recurrence: 'biweekly', anchorDate: '2026-10-29' },
    { id: 'monthly', householdId: 'home', label: '粗大ごみ', collectionWeekdays: [], recurrence: 'monthly', monthlyDay: 28 },
  ];
  const hidden = ['weekly:2026-10-27', 'weekly:2026-10-28', 'biweekly:2026-10-29', 'monthly:2026-10-28'];
  const labels = wasteCalendarLabels(definitions, '2026-10-25', '2026-11-30', hidden);
  assert.deepEqual(labels.weeklyByColumn[2], ['可燃ごみ'], 'the weekly header remains visible');
  assert.deepEqual([...labels.hiddenWeeklyByDate], [['2026-10-27', ['可燃ごみ']]]);
  assert.equal(labels.byDate.has('2026-10-27'), false, 'normal weekly names must not be repeated on dates');
  assert.equal(labels.byDate.has('2026-10-28'), false);
  assert.equal(labels.byDate.has('2026-10-29'), false);
  assert.deepEqual(labels.byDate.get('2026-11-12'), ['びん']);
  assert.deepEqual(labels.byDate.get('2026-11-28'), ['粗大ごみ']);
  assert.equal(wasteCalendarLabels(definitions, '2026-10-25', '2026-11-30').hiddenWeeklyByDate.size, 0, 'restore removes the grey-date information');
});

test('waste appearance: the real calendar distinguishes hidden weekly and active monthly collections on one date', async () => {
  const today = localDateFromDate(new Date());
  const snapshot = {
    chores: [], scheduleEntries: [], completions: [],
    settings: { calendarCountColors: DEFAULT_CALENDAR_COUNT_COLORS, calendarCountDisplayMode: 'dots' },
    wasteSchedules: [
      { id: 'weekly', label: '可燃ごみ', collectionWeekdays: [weekdayOf(today)], recurrence: 'weekly' },
      { id: 'monthly', label: '粗大ごみ', collectionWeekdays: [], recurrence: 'monthly', monthlyDay: Number(today.slice(-2)) },
    ], hiddenWasteOccurrenceKeys: [`weekly:${today}`],
  };
  const screen = screenHarness('src/app/(tabs)/explore.tsx', { snapshot: () => snapshot });
  const date = screen.nodes().find((node) => node.type === 'Pressable' && node.props.accessibilityLabel?.includes('非表示の収集：可燃ごみ'));
  assert.ok(date?.props.accessibilityLabel.includes('粗大ごみ'), 'monthly collection remains visible when a weekly collection is hidden');
  assert.equal(date.props.accessibilityState.selected, true);
  const plain = screen.nodes().find(node => node.type === 'Pressable' && node !== date && Array.isArray(node.props.style) && node.props.style.some(style => style?.flex === 1));
  const selectedStyle = Object.assign({}, ...date.props.style.filter(Boolean)); const plainStyle = Object.assign({}, ...plain.props.style.filter(Boolean));
  assert.equal(selectedStyle.padding, plainStyle.padding, 'the hidden outline keeps the same date baseline as other days');
  await openCalendarDay(screen, today);
  assert.ok(screen.nodes().some((node) => node.type === 'Text' && node.children.includes('粗大ごみ')));
});
