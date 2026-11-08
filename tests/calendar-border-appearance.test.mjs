import './helpers/typescript-loader.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { screenHarness } from './helpers/screen-harness.mjs';
import { plannerLightColors, plannerDarkColors } from '../src/components/planner-theme.ts';

for (const platform of ['ios', 'android']) test(`${platform} calendar dividers follow appearance changes without resetting the selected date`, () => {
  const selected = [];
  const options = { exportName: 'PlannerCalendar', platform, colorScheme: 'light', props: {
    today: '2026-11-08', selectedDate: '2026-12-01', timeZone: 'Asia/Tokyo',
    dayInfo: () => ({ loaded: true, total: 0 }), renderChores: () => null, onSelectDate: day => selected.push(day),
  } };
  const screen = screenHarness('src/features/calendar/planner-calendar.tsx', options);
  const flatten = style => Array.isArray(style) ? Object.assign({}, ...style.filter(Boolean).map(flatten)) : typeof style === 'object' && style ? style : {};
  const borderColors = () => screen.nodes().flatMap(node => Object.entries(flatten(node.props.style))
    .filter(([key]) => /^border.*Color$/.test(key)).map(([, color]) => color));
  assert.ok(borderColors().includes(plannerLightColors.border));
  options.colorScheme = 'dark'; screen.render();
  assert.ok(borderColors().includes(plannerDarkColors.border));
  assert.ok(!borderColors().includes(plannerLightColors.border), 'reused divider layers must receive the current concrete color');
  options.colorScheme = 'light'; screen.render();
  assert.ok(borderColors().includes(plannerLightColors.border));
  assert.ok(!borderColors().includes(plannerDarkColors.border));
  assert.deepEqual(selected, []); assert.ok(screen.text().includes('2026年12月'));
});
