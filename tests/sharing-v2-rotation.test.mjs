import './helpers/typescript-loader.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import {rotationFixture} from './helpers/sharing-v2-rotation-fixture.mjs';
import {chorePolicyFromPreset} from '../src/features/sharing/v2/model.ts';
import {listSharingOutbox} from '../src/platform/storage/sharing-ledger.ts';
import {groupId} from './helpers/sharing-v2-repository-fixture.mjs';
import {removeSharedMembers} from '../src/features/sharing/roster.ts';
const round=(p,day)=>p.occurrences.find(r=>r.choreId==='floor'&&r.anchorDate===day&&!r.historical);

test('completion-based rotation waits through missed deadlines and advances once for actual work, then reverses on undo',async t=>{
 const h=await rotationFixture(t);h.setDay('2026-11-20');let p=await h.plan();
 assert.deepEqual(round(p,'2026-11-24').assigneeIds,['owner']);
 const [done]=await h.a.complete(h.ref('2026-10-27'));p=await h.plan();
 assert.deepEqual(round(p,'2026-11-24').assigneeIds,['member']);
 assert.deepEqual(p.history[0].originalAssigneeIds,['owner']);assert.deepEqual(round(p,'2026-10-27').assigneeIds,['owner']);
 await h.a.undo(done.operationId);assert.deepEqual(round(await h.plan(),'2026-11-24').assigneeIds,['owner']);
});
test('a repeated A A B rotation counts actual distinct completed rounds and preserves the historical assignee',async t=>{
 const h=await rotationFixture(t,{sequence:['owner','owner','member']});
 await h.a.complete(h.ref('2026-10-27'));assert.deepEqual(round(await h.plan(),'2026-11-03').assigneeIds,['owner']);
 h.setDay('2026-11-03');await h.a.complete(h.ref('2026-11-03'));assert.deepEqual(round(await h.plan(),'2026-11-10').assigneeIds,['member']);
 h.setDay('2026-11-10');await h.a.complete(h.ref('2026-11-10'),{performerUserId:'member'});const p=await h.plan();
 assert.deepEqual(round(p,'2026-11-17').assigneeIds,['owner']);assert.deepEqual(round(p,'2026-10-27').assigneeIds,['owner']);
 assert.deepEqual(round(p,'2026-11-03').assigneeIds,['owner']);assert.deepEqual(round(p,'2026-11-10').assigneeIds,['member']);
});
test('occurrence-based rotation advances without completions and cadence-only edits do not restart the sequence',async t=>{
 const h=await rotationFixture(t,{basis:'occurrence'});let p=await h.plan();
 assert.deepEqual(round(p,'2026-10-27').assigneeIds,['owner']);assert.deepEqual(round(p,'2026-11-03').assigneeIds,['member']);assert.deepEqual(round(p,'2026-11-10').assigneeIds,['owner']);
 await h.a.patchChoreConfiguration('floor',2,{intervalDays:14},'2026-11-03');p=await h.plan();
 assert.equal(round(p,'2026-11-03').configuration.rotationSourceVersion,2);assert.deepEqual(round(p,'2026-11-03').assigneeIds,['member']);assert.deepEqual(round(p,'2026-11-17').assigneeIds,['owner']);
});
test('one-off assignee overrides replace only that round and keep the underlying rotation sequence',async t=>{
 const h=await rotationFixture(t,{basis:'occurrence'});await h.a.assign(h.ref('2026-10-27'),['member'],'this',false,{scope:'once'});
 const p=await h.plan();assert.deepEqual(round(p,'2026-10-27').assigneeIds,['member']);assert.deepEqual(round(p,'2026-11-03').assigneeIds,['member']);assert.deepEqual(round(p,'2026-11-10').assigneeIds,['owner']);
});
test('two devices completing the same shared round consume one rotation slot and targeted undo preserves the other completion',async t=>{
 const h=await rotationFixture(t);await h.deliver(h.owner,await h.load(h.owner));await h.deliver(h.member);
 const [first]=await h.a.complete(h.ref('2026-10-27'));const [second]=await h.b.complete(h.ref('2026-10-27'));
 await h.deliver(h.owner,await h.load(h.owner));await h.deliver(h.owner,await h.load(h.member));
 assert.deepEqual(round(await h.plan(),'2026-11-03').assigneeIds,['member']);
 await h.a.undo(first.operationId);assert.deepEqual(round(await h.plan(),'2026-11-03').assigneeIds,['member']);
 await h.a.undo(second.operationId);assert.deepEqual(round(await h.plan(),'2026-11-03').assigneeIds,['owner']);
});
test('leaving members are not silently replaced in a rotation and signed unknown participants cannot enter the outbox',async t=>{
 const h=await rotationFixture(t,{basis:'occurrence'});const before=(await listSharingOutbox(h.owner.database,groupId)).length;
 await assert.rejects(h.a.patchChoreConfiguration('floor',2,{policy:chorePolicyFromPreset('rotation',['owner','stranger'])},'2026-10-27'));
 assert.equal((await listSharingOutbox(h.owner.database,groupId)).length,before);
 await h.deliver(h.owner,await h.load(h.owner));
 h.f.archive.push(removeSharedMembers(h.f.archive.at(-1),h.f.owner,['member']));const next=round(await h.plan(),'2026-11-03');
 assert.deepEqual(next.assigneeIds,[]);assert.equal(next.needsAssignment,true);
});
test('old group epochs cannot silently opt into rotating assignments',async t=>{
 const h=await rotationFixture(t,{schedulerVersion:'liflow-shared-2-draft-53'});const before=(await listSharingOutbox(h.owner.database,groupId)).length;
 await assert.rejects(h.a.patchChoreConfiguration('floor',1,{policy:chorePolicyFromPreset('rotation',['owner','member'])},h.anchor),{code:'sharing/v2-authority-denied'});
 assert.equal((await listSharingOutbox(h.owner.database,groupId)).length,before);
});

test('a future-dated work report cannot advance the rotation once its actual server receipt proves the time invalid',async t=>{
 const h=await rotationFixture(t);h.setDay('2026-10-28');await h.a.complete(h.ref('2026-10-27'),{performedAt:'2026-10-28T01:00:00Z'});h.setDay('2026-10-27');
 await h.deliver(h.owner,await h.load(h.owner));assert.deepEqual(round(await h.plan(),'2026-11-03').assigneeIds,['owner']);
});
