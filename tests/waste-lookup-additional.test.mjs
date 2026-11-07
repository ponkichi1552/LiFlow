import './helpers/typescript-loader.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { calendarWasteLabel, wasteTypeColor, wasteTypeIcon } from '../src/features/waste/type-appearance.ts';
import { searchWasteTypes } from '../src/features/waste/waste-types.ts';
test('waste label icon color and search reuse the bundled normalized aliases instead of scanning and renormalizing them', t => {
  let calls = 0; const original = String.prototype.normalize;
  String.prototype.normalize = function (...args) { calls++; return original.apply(this, args); };
  try {
    for (let n = 0; n < 100; n++) {
      assert.equal(wasteTypeIcon('廃食油'), 'oil'); assert.match(wasteTypeColor('廃食油', 'dark'), /^#/);
      assert.equal(calendarWasteLabel('廃食油'), '食用油'); assert.equal(searchWasteTypes('廃食油')[0]?.label, '使用済み食用油');
    }
  } finally { String.prototype.normalize = original; }
  t.diagnostic(`normalizations for 400 lookups: ${calls}`); assert.ok(calls <= 400);
});

test('valid custom waste names matching object prototype keys cannot crash calendar labels', async () => {
  const { normalizeWasteSchedule } = await import('../src/features/waste/schedule-policy.ts');
  for (const label of ['constructor', '__proto__', 'toString', 'hasOwnProperty']) {
    const valid = normalizeWasteSchedule({ label, collectionWeekdays: [6], recurrence: 'weekly' });
    assert.equal(calendarWasteLabel(valid.label), label); assert.equal(wasteTypeIcon(valid.label), 'trash');
    assert.equal(typeof wasteTypeColor(valid.label, 'dark'), 'string');
  }
});
