import './helpers/typescript-loader.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, seeds, now } from './helpers/sharing-v2-repository-fixture.mjs';
import { createV2PlannerActions } from '../src/features/sharing/v2/actions.ts';
import { chorePolicyFromPreset } from '../src/features/sharing/v2/model.ts';
import { v2CommonCompletionSource } from '../src/features/sharing/v2-ui/common-chore-history.ts';
import { sharedAdaptiveLoad } from '../src/features/planner/shared-adaptive-load.ts';

test('audit100 canonical shared completions compare real instants before choosing the personal mirror and spent workload', () => {
  const original = { operationId: 'first', subjectOccurrenceId: 'round', occurrenceId: 'round', choreId: 'floor', anchorDate: '2026-11-07',
    active: true, outcome: 'completed', acceptance: 'accepted', approvalConflictIds: [], subjectUserId: null,
    performerUserId: 'owner', recorderUserId: 'owner', performedAt: '2026-11-07T11:00:00+09:00', schedule: null };
  const later = { ...original, operationId: 'second', performerUserId: 'member', recorderUserId: 'member', performedAt: '2026-11-07T06:00:00Z' };
  const plan = { initialized: true, groupId: 'group', members: [{ userId: 'owner', active: true }],
    chores: [{ id: 'floor', name: '床を掃除する', load: 'heavy', estimatedMinutes: 40, enabled: true }], history: [later, original], occurrences: [] };
  assert.equal(v2CommonCompletionSource({ viewerUserId: 'owner', plan }).completions[0].id, 'first');
  const load = sharedAdaptiveLoad(plan, 'owner', '2026-11-07', 'Asia/Tokyo', []);
  assert.equal(load.loads.length, 1); assert.equal(load.loads[0].minutes, 40);
});

test('audit100 a rejected substitution does not block the actual assignee from completing the same round', async t => {
  const f = await fixture(); const d = await f.device(); t.after(() => d.connection.close());
  const initial = seeds(); initial[0].payload.configuration.allowSubstitution = false;
  initial[3].payload.configuration.policy = chorePolicyFromPreset('assigned', ['owner']);
  await d.repository.commit(initial); let id = 0;
  const actions = createV2PlannerActions(d.repository, { now, makeId: () => `audit100-completion-${++id}` });
  const ref = { choreId: 'floor', anchorDate: '2026-10-27', ruleVersion: 1, subjectUserId: null };
  const [substitution] = await actions.complete(ref, { performerUserId: 'member' });
  await actions.approveSubstitution(substitution.operationId, 'reject');
  let plan = await actions.readPlan({ from: '2026-10-27', through: '2026-10-27', asOfDate: '2026-10-27' });
  assert.equal(plan.history[0].acceptance, 'rejected'); assert.equal(plan.occurrences[0].completed, false);
  const completed = await actions.complete(ref);
  assert.equal(completed.length, 1);
  plan = await actions.readPlan({ from: '2026-10-27', through: '2026-10-27', asOfDate: '2026-10-27' });
  assert.equal(plan.occurrences[0].completed, true); assert.equal(plan.history.length, 2);
  assert.equal(plan.history.find(row => row.operationId === substitution.operationId).acceptance, 'rejected');
});

for (const origin of ['displayed', 'queued-local']) test(`audit100 targeted shared Undo preserves later unseen work after ${origin} completion`, async t => {
  const f = await fixture(); const d = await f.device(); t.after(() => d.connection.close()); await d.repository.commit(seeds()); let n = 0;
  const actions = createV2PlannerActions(d.repository, { now, makeId: () => `audit100-targeted-${++n}` });
  const ref = { choreId: 'floor', anchorDate: '2026-10-27', ruleVersion: 1, subjectUserId: null };
  const firstIntent = { id: 'completion-intent.12345678-1234-4234-8234-123456789abc', digest: 'a'.repeat(64) };
  const first = origin === 'displayed' ? await actions.complete(ref) : await actions.setCompletedIntent(firstIntent,ref,true,{ createdAt: now().toISOString() });
  const [unseen] = await actions.complete(ref,{additionalWork:true});
  await actions.setCompletedIntent({ id: 'completion-intent.12345678-1234-4234-8234-123456789abd',digest:'b'.repeat(64) },ref,false,
    { createdAt:now().toISOString(), observedCompletionIds: origin==='displayed'?first.map(op=>op.operationId):[], precedingCompletionIntentIds:origin==='queued-local'?[firstIntent.id]:[] });
  const plan = await actions.readPlan({from:ref.anchorDate,through:ref.anchorDate,asOfDate:ref.anchorDate});
  assert.equal(plan.history.find(row=>row.operationId===unseen.operationId).active,true,'work not visible to the gesture must survive');
  assert.ok(first.every(op=>plan.history.find(row=>row.operationId===op.operationId).active===false));
});

for (const phase of ['acknowledged', 'protected-restart']) test(`audit100 shared Undo keeps its exact queued predecessor through ${phase}`, async t => {
  const { randomUUID } = await import('node:crypto');
  const { createCompletionIntents } = await import('../src/features/planner/completion-intents.ts');
  const { captureCompletionTarget, prepareCompletionRequest, completionIntentDigest } = await import('../src/features/planner/completion-command.ts');
  const f = await fixture(); const d = await f.device(); t.after(()=>d.connection.close()); await d.repository.commit(seeds()); let n=0;
  const actions = createV2PlannerActions(d.repository,{ now,makeId:()=>`audit100-lineage-${++n}` });
  const target={kind:'shared',ref:{choreId:'floor',anchorDate:'2026-10-27',ruleVersion:1,subjectUserId:null},expectedAssigneeIds:[],observedCompletionIds:[]};
  let saved=[],release,entered; const started=new Promise(resolve=>{entered=resolve;}); const gate=new Promise(resolve=>{release=resolve;});
  let first=true;
  const open = () => createCompletionIntents({capture:captureCompletionTarget,prepareRequest:prepareCompletionRequest,makeId:()=>`completion-intent.${randomUUID()}`,now,isCurrent:()=>true,
    store:{load:async()=>structuredClone(saved),save:async values=>{saved=structuredClone(values);}},refresh:async()=>true,
    apply:async intent=>{if(first&&phase==='protected-restart'){first=false;entered();await gate;}
      await actions.setCompletedIntent({id:intent.id,digest:completionIntentDigest('test',intent)},intent.target.ref,intent.completed,
        {createdAt:intent.createdAt,observedCompletionIds:intent.target.observedCompletionIds,precedingCompletionIntentIds:intent.target.precedingCompletionIntentIds});}});
  let queue=open(); await queue.activate(); queue.request('floor',target,true);
  if(phase==='protected-restart'){
    await started; queue.request('floor',target,false); await new Promise(setImmediate); queue.deactivate(); release(); await queue.settled();
  } else await queue.settled();
  const firstId=(await d.repository.readState()).replica.operations.find(op=>op.operationType==='complete').operationId;
  const [unseen]=await actions.complete(target.ref,{additionalWork:true});
  if(phase==='protected-restart'){queue=open();await queue.activate();}else queue.request('floor',target,false);
  await queue.settled(); const plan=await actions.readPlan({from:target.ref.anchorDate,through:target.ref.anchorDate,asOfDate:target.ref.anchorDate});
  assert.equal(plan.history.find(row=>row.operationId===firstId).active,false);
  assert.equal(plan.history.find(row=>row.operationId===unseen.operationId).active,true);
});

test('audit100 receipt-rejected future work never becomes a completed personal mirror or spent workload',async()=>{
  const {fixture:planFixture}=await import('./helpers/sharing-v2-plan-fixture.mjs');
  const f=await planFixture();f.complete({actor:'owner',performedAt:'2026-10-27T12:00:00Z',recordedAt:'2026-10-27T12:00:00Z',receivedAt:'2026-10-27T10:00:00Z'});
  const plan=f.plan({through:'2026-10-27'});
  assert.ok(plan.issues.some(issue=>issue.kind==='reportedTimeNeedsReview'));
  const mirror=v2CommonCompletionSource({viewerUserId:'owner',plan});
  assert.equal(mirror.completions[0].outcome,'incomplete');
  const recommendation={groupId:plan.groupId,viewerUserId:'owner',commonPlanHash:plan.planHash,recommendations:plan.occurrences.flatMap(round=>round.subjects.map(subject=>({subjectOccurrenceId:subject.id,date:'2026-10-28'})))};
  const load=sharedAdaptiveLoad(plan,'owner','2026-10-27','Asia/Tokyo',[],recommendation);
  assert.ok(load.loads.every(row=>row.date!=='2026-10-27'),'future work must not count as already spent today');
});
