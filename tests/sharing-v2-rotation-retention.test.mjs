import './helpers/typescript-loader.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import {rotationFixture} from './helpers/sharing-v2-rotation-fixture.mjs';
import {retainRotation} from './helpers/rotation-retention.mjs';
import {buildV2CommonPlan} from '../src/features/sharing/v2/common-plan.ts';
import {assertV2RetentionBase} from '../src/features/sharing/v2/history-retention-certificate.ts';
import {validateRotationProgress,rotationCompletionCount,rotationProgressIndex} from '../src/features/sharing/v2/rotation-progress.ts';

test('signed monthly deletion retains exact rotation progress across replicas without retaining old work reports and Undo affects only new work',async t=>{
 const h=await rotationFixture(t,{anchor:'2026-09-01'});await h.a.complete(h.ref('2026-09-01'));await h.deliver(h.owner,await h.load(h.owner));await h.deliver(h.member,[]);
 h.setDay('2026-09-08');await h.b.complete(h.ref('2026-09-08'));await h.deliver(h.owner,await h.load(h.member));await h.deliver(h.member,[]);
 h.setDay('2026-11-08');const retained=await retainRotation(h,'2026-10-08');assert.equal(retained.plan.body.format,3);
 const bits=retained.plan.body.rotationProgress;assert.equal(rotationCompletionCount(rotationProgressIndex(bits),'floor',2,'2026-09-15'),2);assertV2RetentionBase(retained.replica,retained.witness,h.f.archive);
 const range={from:'2026-11-08',through:'2026-11-30',asOfDate:'2026-11-08'};
 for(const device of [h.owner,h.member]){const state=await device.repository.readState();assert.equal(state.replica.operations.some(op=>op.entityType==='completion'),false);const plan=buildV2CommonPlan(state,range);assert.equal(plan.history.length,0);assert.deepEqual(plan.occurrences.find(row=>row.anchorDate==='2026-11-10').assigneeIds,['owner']);}
 const next=await h.a.complete(h.ref('2026-09-15'));assert.equal(next.length,1);assert.deepEqual((await h.plan()).occurrences.find(row=>row.anchorDate==='2026-11-10').assigneeIds,['member']);
 await h.a.undo(next[0].operationId);assert.deepEqual((await h.plan()).occurrences.find(row=>row.anchorDate==='2026-11-10').assigneeIds,['owner']);
 const forged=structuredClone(bits);forged[0].buckets[0].bits='f'.repeat(64);validateRotationProgress(forged);
 const body=structuredClone(retained.base);body.retention.proposal.operation.payload.checkpoint.rotationProgress=forged;assert.throws(()=>assertV2RetentionBase({...retained.replica,retention:body.retention},body.retention,h.f.archive));
});
test('rotation progress rejects ambiguous duplicate epochs out-of-order buckets and unbounded or private fields',()=>{
 const row={choreId:'floor',sourceVersion:2,buckets:[{index:80,bits:'0'.repeat(63)+'1'}]};validateRotationProgress([row]);
 for(const bad of [[row,row],[{...row,performer:'owner'}],[{...row,buckets:[row.buckets[0],row.buckets[0]]}],[{...row,buckets:[{index:80,bits:'0'.repeat(64)}]}]])assert.throws(()=>validateRotationProgress(bad));
});
