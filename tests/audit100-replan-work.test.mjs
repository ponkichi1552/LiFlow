import './helpers/typescript-loader.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
const { connectedReplanIds } = await import('../src/features/planner/connected-replan-ranges.ts');
const { weatherChangeDays } = await import('../src/features/planner/weather-change-days.ts');
const { addDays } = await import('../src/domain/scheduling/local-date.ts');
test('audit100 connected replan ranges use an interval sweep rather than repeated pairwise recruitment', () => {
  let reads=0;
  const rows=Array.from({length:500},(_,i)=>({ get id(){reads++;return `chore-${i}`;},from:addDays('2026-01-01',i),through:addDays('2026-01-01',i+1),changed:i===0 }));
  rows.push({id:'isolated',from:'2030-01-01',through:'2030-01-02',changed:false});
  assert.equal(connectedReplanIds(rows).size,500);
  assert.ok(reads<5000,`pairwise chore reads: ${reads}`);
  assert.deepEqual([...connectedReplanIds([{id:'a',from:'2026-01-03',through:'2026-01-04',changed:false},{id:'b',from:'2026-01-01',through:'2026-01-02',changed:true}])],['b']);
});
test('audit100 weather revision comparison indexes intervals by day instead of rescanning the full forecast for every day', () => {
  const start=Date.parse('2026-11-01T00:00:00Z'); const hour=3600000; let reads=0;
  const days=Array.from({length:181},(_,i)=>({date:addDays('2026-11-01',i),bounds:{start:start+i*24*hour,end:start+(i+1)*24*hour}}));
  const intervals=Array.from({length:300},(_,i)=>({get start(){reads++;return start+i*hour;},end:start+(i+1)*hour,precipitationMm:0}));
  const after={intervals}; const changed=weatherChangeDays(days,undefined,after,JSON.stringify);
  assert.deepEqual(changed,days.slice(0,13).map(day=>day.date));
  assert.ok(reads<5000,`weather interval reads: ${reads}`);
  const before={intervals:[{start,end:start+hour,precipitationMm:1}]};
  const only={intervals:[{start,end:start+hour,precipitationMm:0}]};
  assert.deepEqual(weatherChangeDays(days,before,only,JSON.stringify),['2026-11-01']);
});
