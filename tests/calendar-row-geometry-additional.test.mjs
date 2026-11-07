import './helpers/typescript-loader.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { calendarMonthRows } from '../src/features/calendar/month-rows.ts';
import { addDays } from '../src/domain/scheduling/local-date.ts';
test('calendar viewport resizing reuses civil row geometry without reparsing every day', t => {
  const weeks = Array.from({ length: 521 }, (_, n) => addDays('2021-11-07', n * 7));
  const first = calendarMonthRows(weeks, 90); let constructions = 0;
  const OriginalDate = globalThis.Date;
  globalThis.Date = class extends OriginalDate { constructor(...args) { super(...args); constructions++; } };
  let resized; try { resized = calendarMonthRows(weeks, 100); } finally { globalThis.Date = OriginalDate; }
  assert.deepEqual(resized.map(row => row.days), first.map(row => row.days));
  assert.deepEqual(resized.map(row => row.offset), resized.map((_, n) => first[n].offset + n * 10));
  t.diagnostic(`date constructions on resize: ${constructions}`); assert.equal(constructions, 0);
  resized[0].days[0] = '1900-01-01'; assert.equal(calendarMonthRows(weeks, 100)[0].days[0], '2021-11-07');
});
