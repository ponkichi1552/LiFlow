import './helpers/typescript-loader.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
const {selectDateTasks}=await import('../src/domain/scheduling/date-tasks.ts');
test('audit100 selecting modern exact completion references does not scan ten thousand records for every occurrence',()=>{
  let reads=0;const count=500;
  const entries=Array.from({length:count},(_,n)=>({id:`round-${String(n).padStart(4,'0')}`,householdId:'local-household',choreId:'floor',suggestedDate:'2026-11-07',windowStart:'2026-11-07',windowEnd:'2026-11-07',status:'planned'}));
  const history=Array.from({length:10000},(_,n)=>({id:`history-${n}`,householdId:'local-household',choreId:'floor',outcome:'completed',source:'inApp',completedAt:'2026-11-06T01:00:00Z',completedLocalDate:'2026-11-06',scheduledDate:'2026-11-06',scheduledWindowStart:'2026-11-06',scheduledWindowEnd:'2026-11-06',get scheduleEntryId(){reads++;return n<10000-count?`old-${n}`:entries[n-(10000-count)].id;}}));
  const rows=selectDateTasks(entries,history,'2026-11-07');
  assert.equal(rows.length,1);assert.equal(rows[0].completed,true);assert.equal(rows[0].entry.id,'round-0000');
  assert.ok(reads<50000,`exact completion reference reads: ${reads}`);
});
