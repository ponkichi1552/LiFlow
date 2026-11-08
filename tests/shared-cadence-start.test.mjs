import './helpers/typescript-loader.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import {fixture,seeds} from './helpers/sharing-v2-repository-fixture.mjs';
import {createV2PlannerActions} from '../src/features/sharing/v2/actions.ts';

test('a shared period edit keeps the last previous scheduled date instead of recomputing from its original operational start',async t=>{
 let day='2026-11-08';const now=()=>new Date(`${day}T01:00:00Z`);const f=await fixture({clock:now});const d=await f.device();t.after(()=>d.connection.close());
 const seed=seeds();seed[1].payload.anchorDate=day;seed[3].payload.configuration.anchorDate=day;await d.repository.commit(seed);let n=0;
 const a=createV2PlannerActions(d.repository,{now,makeId:()=>`cadence-change-${++n}`});
 const plan=()=>a.readPlan({from:'2026-11-08',through:'2026-12-15',asOfDate:day});
 day='2026-11-18';let changed=await a.patchChoreConfiguration('floor',1,{intervalDays:6},day);
 assert.equal(changed[0].payload.configuration.anchorDate,'2026-11-15');assert.equal(changed[0].payload.configuration.effectiveFrom,day);
 let rounds=(await plan()).occurrences.filter(row=>row.choreId==='floor');
 assert.deepEqual(rounds.filter(row=>row.ruleVersion===2).slice(0,3).map(row=>row.anchorDate),['2026-11-21','2026-11-27','2026-12-03']);
 assert.ok(rounds.some(row=>row.ruleVersion===1&&row.anchorDate==='2026-11-15'));
 assert.equal((await plan()).history.length,0,'a settings edit must not invent a completion');
 day='2026-11-25';changed=await a.patchChoreConfiguration('floor',2,{intervalDays:5},day);
 assert.equal(changed[0].payload.configuration.anchorDate,'2026-11-21');
 rounds=(await plan()).occurrences.filter(row=>row.ruleVersion===3);assert.equal(rounds[0].anchorDate,'2026-11-26');
 assert.deepEqual(await a.patchChoreConfiguration('floor',3,{intervalDays:5},day),[]);
});
test('an explicit new shared start date remains explicit while unrelated responsibility and window edits retain the existing recurrence phase',async t=>{
 let day='2026-11-08';const now=()=>new Date(`${day}T01:00:00Z`);const f=await fixture({clock:now});const d=await f.device();t.after(()=>d.connection.close());const initial=seeds();initial[3].payload.configuration.anchorDate=day;await d.repository.commit(initial);let n=0;
 const a=createV2PlannerActions(d.repository,{now,makeId:()=>`start-change-${++n}`});day='2026-11-18';
 let ops=await a.patchChoreConfiguration('floor',1,{intervalDays:6,anchorDate:'2026-11-20'},'2026-11-20');assert.equal(ops[0].payload.configuration.anchorDate,'2026-11-20');
 ops=await a.patchChoreConfiguration('floor',2,{windowAfterDays:3},'2026-11-20');assert.equal(ops[0].payload.configuration.anchorDate,'2026-11-20');
});
