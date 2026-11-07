import './helpers/typescript-loader.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
const { personalCalendarTasks } = await import('../src/features/calendar/personal-projection.ts');
const { addDays } = await import('../src/domain/scheduling/local-date.ts');
test('audit100 a calendar snapshot builds its completed occurrence lookup once for all requested days', () => {
  let reads = 0; const entries = Array.from({ length: 30 }, (_, n) => { const date = addDays('2026-11-01', n); return { id: `next-${n}`, householdId:'local-household', choreId:'chore', suggestedDate:date, cycleBaseDate:date, windowStart:date, windowEnd:date, status:'scheduled', assignedMemberIds:[] }; });
  const completions = Array.from({ length: 1000 }, (_, n) => ({ id:`done-${n}`, householdId:'local-household', choreId:'chore', outcome:'completed', completedAt:'2025-01-01T00:00:00Z', completedLocalDate:'2025-01-01', scheduledDate:'2025-01-01', scheduledWindowStart:'2025-01-01', scheduledWindowEnd:'2025-01-01', get scheduleEntryId() { reads++; return `old-${n}`; } }));
  const snapshot = { chores:[{id:'chore', enabled:true, archived:false, load:'normal'}], scheduleEntries: entries, completions };
  const select = personalCalendarTasks(snapshot, '2026-11-01', rows => rows);
  for (let n = 0; n < 30; n++) { const rows = select(addDays('2026-11-01', n)); assert.equal(rows.length,1); assert.equal(rows[0].completed,false); }
  assert.ok(reads <= 2000, `completed occurrence lookups: ${reads}`);
});
