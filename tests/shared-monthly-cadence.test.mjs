import './helpers/typescript-loader.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { commonFrame, commonFrames } from '../src/features/sharing/v2/common-frames.ts';
import { v2AnchorAtIndex, v2AnchorIndexBefore, v2AnchorIndexOnOrAfter } from '../src/features/sharing/v2/cadence.ts';
import { chorePolicyFromPreset } from '../src/features/sharing/v2/model.ts';
import { rotationFixture } from './helpers/sharing-v2-rotation-fixture.mjs';
import { fixture, seeds, groupId, now } from './helpers/sharing-v2-repository-fixture.mjs';
import { fixture as planFixture } from './helpers/sharing-v2-plan-fixture.mjs';
import { createV2PlannerActions } from '../src/features/sharing/v2/actions.ts';
import { createV2GroupController } from '../src/features/sharing/v2/controller.ts';
import { listSharingOutbox } from '../src/platform/storage/sharing-ledger.ts';
import { nextV2CommonOccurrence } from '../src/features/sharing/v2/next-occurrence.ts';
import { v2ReadPoint } from '../src/features/sharing/v2/view-point.ts';
import { buildV2PersonalPlan } from '../src/features/sharing/v2/personal-plan.ts';
import { screenHarness } from './helpers/screen-harness.mjs';

const configuration = anchorDate => ({ policy: chorePolicyFromPreset('common'), anchorDate, monthly: true, intervalDays: 7, windowBeforeDays: 0, windowAfterDays: 0, ruleVersion: 1 });
test('shared monthly dates retain their chosen day across short months leap years and year boundaries', () => {
  for (const [start, expected] of [
    ['2026-01-31', ['2026-01-31','2026-02-28','2026-03-31','2026-04-30']],
    ['2028-01-31', ['2028-01-31','2028-02-29','2028-03-31','2028-04-30']],
    ['2026-11-21', ['2026-11-21','2026-12-21','2027-01-21','2027-02-21']],
  ]) {
    const cfg = configuration(start);
    assert.deepEqual(commonFrames('group','chore',cfg,start,expected.at(-1)).map(frame=>frame.anchorDate),expected);
    for (let index=0;index<expected.length;index++) {
      assert.equal(v2AnchorAtIndex(cfg,index),expected[index]);
      assert.equal(v2AnchorIndexBefore(cfg,expected[index]),index);
      assert.equal(v2AnchorIndexOnOrAfter(cfg,expected[index]),index);
    }
    assert.throws(()=>commonFrame('group','chore',cfg,`${expected[1].slice(0,8)}15`));
  }
  const cfg=configuration('2026-01-31');
  assert.equal(v2AnchorIndexBefore(cfg,'2026-01-30'),-1);assert.equal(v2AnchorIndexOnOrAfter(cfg,'2026-02-01'),1);
  assert.equal(v2AnchorIndexBefore(cfg,'2026-03-01'),1);assert.equal(v2AnchorIndexOnOrAfter(cfg,'2026-03-01'),2);
});
test('shared monthly work and undo converge on signed replicas without changing future dates or rotating twice',async t=>{
  const h=await rotationFixture(t,{anchor:'2026-01-31',basis:'occurrence'});
  const anchor='2026-01-31';await h.a.patchChoreConfiguration('floor',2,{monthly:true},anchor);
  const visible=p=>p.occurrences.filter(r=>r.choreId==='floor'&&!r.historical).slice(0,3).map(r=>[r.anchorDate,r.assigneeIds]);
  const expected=[['2026-01-31',['owner']],['2026-02-28',['member']],['2026-03-31',['owner']]];
  assert.deepEqual(visible(await h.plan()),expected);
  const [done]=await h.a.complete(h.ref(anchor,3));await h.deliver(h.owner,await h.load(h.owner));await h.deliver(h.member);
  const range={from:anchor,through:'2026-12-31',asOfDate:anchor};
  assert.deepEqual(visible(await h.b.readPlan(range)),expected);
  await h.a.undo(done.operationId);await h.deliver(h.owner,await h.load(h.owner));await h.deliver(h.member);
  const after=await h.b.readPlan(range);assert.deepEqual(visible(after),expected);assert.equal(after.occurrences.find(r=>r.anchorDate===anchor).completed,false);
  const s=await h.owner.repository.readState();const next=nextV2CommonOccurrence(s.assessment.view,v2ReadPoint(s.assessment.view,s.archive.at(-1)),'floor',anchor);
  assert.equal(next.anchorDate,'2026-02-28');
});
test('shared monthly sparse reads retain missed work and changing back to days uses the last issued monthly date',async t=>{
  let day='2026-01-31';const clock=()=>new Date(`${day}T01:00:00Z`);const f=await fixture({clock});const d=await f.device();t.after(()=>d.connection.close());
  const initial=seeds();initial[3].payload.configuration={...configuration(day),windowAfterDays:0};await d.repository.commit(initial);let n=0;
  const a=createV2PlannerActions(d.repository,{now:clock,makeId:()=>`monthly-${++n}`});day='2026-03-15';
  let plan=await a.readPlan({from:day,through:'2026-04-30',asOfDate:day});
  assert.ok(plan.occurrences.some(r=>r.anchorDate==='2026-01-31'&&r.subjects.some(s=>s.automaticBacklog==='pending')));
  const changed=await a.patchChoreConfiguration('floor',1,{monthly:false,intervalDays:7},day);
  assert.equal(changed[0].payload.configuration.anchorDate,'2026-02-28');
  plan=await a.readPlan({from:day,through:'2026-04-30',asOfDate:day});
  assert.equal(plan.occurrences.find(r=>r.ruleVersion===2).anchorDate,'2026-03-21');assert.equal(plan.history.length,0);
});
test('old shared epochs and ordinary members cannot create a monthly schedule or leave rejected writes in the outbox',async t=>{
  for(const schedulerVersion of ['liflow-shared-2-draft-53','liflow-shared-2-draft-54']){
    const f=await fixture({schedulerVersion});const d=await f.device();t.after(()=>d.connection.close());await d.repository.commit(seeds());
    let n=0;const a=createV2PlannerActions(d.repository,{now,makeId:()=>`monthly-old-${++n}`});const before=(await listSharingOutbox(d.database,groupId)).length;
    await assert.rejects(a.patchChoreConfiguration('floor',1,{monthly:true},'2026-10-27'),{code:'sharing/v2-authority-denied'});
    assert.equal((await listSharingOutbox(d.database,groupId)).length,before);
  }
  const f=await fixture();const m=await f.device('member',f.member);t.after(()=>m.connection.close());const a=createV2PlannerActions(m.repository,{now,makeId:()=>`monthly-member`});
  await assert.rejects(a.addConfiguredChore('private policy',30,chorePolicyFromPreset('common'),{monthly:true}),/管理者/);
  assert.equal((await listSharingOutbox(m.database,groupId)).length,0);
});
test('shared windows automatically use each persons holidays without an administrator holiday flag and zero width stays on its date',async()=>{
  for(const width of [0,2]){
    const f=await planFixture({before:width,after:width,configuration:{anchorDate:'2026-10-30'}});f.make('chore',{holidayPriority:false},{entityId:'floor'});
    const common=f.plan();const hash=common.planHash;
    const recommend=(uid,restDays)=>buildV2PersonalPlan(common,{viewerUserId:uid,now:Date.parse('2026-10-27T01:00:00Z'),settings:{frequencyMode:'balanced',restDays,loadLimits:{heavyDailyLimit:2,normalDailyLimit:2}}}).recommendations.find(r=>r.occurrenceId===common.occurrences[0].id).date;
    assert.equal(recommend('a',[5]),'2026-10-30');assert.equal(recommend('b',[7]),width?'2026-11-01':'2026-10-30');assert.equal(common.planHash,hash);
  }
});
for(const [platform,name] of [
  ['ios','ios shared dates can save monthly recurrence and creation requires no administrator holiday choice'],
  ['android','android shared dates can save monthly recurrence and creation requires no administrator holiday choice'],
])test(name,async t=>{
  const f=await fixture();const d=await f.device();t.after(()=>d.connection.close());await d.repository.commit(seeds());let n=0;
  const controller=createV2GroupController(d.repository,{now,makeId:()=>`monthly-ui-${++n}`,sync:async()=>{}});const effects=[];
  const props={model:await controller.readModel({from:'2026-10-27',through:'2026-12-31',asOfDate:'2026-10-27'},{management:true}),choreId:'floor',controller,onSaved:async()=>{props.model=await controller.readModel({from:'2026-10-27',through:'2026-12-31',asOfDate:'2026-10-27'},{management:true});}};
  const s=screenHarness('src/features/sharing/v2-ui/configuration-editor.tsx',{exportName:'V2ConfigurationEditor',platform,props,effect:callback=>effects.push(callback)});t.after(()=>s.unmount());
  const settle=async()=>{for(let n=0;n<16;n++){for(const effect of effects.splice(0))effect();await s.flush();}};
  await settle();await s.press('毎月');await settle();await s.press('毎月の日付を変更');await s.press('毎月の日付カレンダーの次の月');await s.press('毎月21日にする');await settle();
  const cfg=(await controller.readModel({from:'2026-10-27',through:'2026-12-31',asOfDate:'2026-10-27'})).configurations[0].configuration;
  assert.equal(cfg.monthly,true);assert.equal(cfg.anchorDate,'2026-11-21');assert.equal(cfg.effectiveFrom,'2026-11-21');
  await s.press('日数');await settle();
  const intervalCfg=(await controller.readModel({from:'2026-10-27',through:'2026-12-31',asOfDate:'2026-10-27'})).configurations[0].configuration;
  assert.equal(intervalCfg.monthly,false);assert.equal(intervalCfg.intervalDays,7);
  const created=[];const form=screenHarness('src/features/sharing/v2-ui/add-chore.tsx',{exportName:'V2AddChore',platform,props:{model:props.model,actions:controller.actions,busy:false,run:work=>work(),onCreated:id=>created.push(id),onBack(){}}});t.after(()=>form.unmount());
  assert.equal(form.nodes().some(n=>n.props.accessibilityLabel==='追加する家事は休日を優先'),false);
  await form.change('追加する家事の名前','毎月の片付け');form.nodes().find(n=>n.props.accessibilityRole==='radio'&&n.props.accessibilityLabel==='誰か1人が行う').props.onPress();await form.flush();
  await form.press('毎月');await form.press('追加');for(let i=0;i<20;i++)await form.flush();assert.equal(created.length,1);
  const state=await d.repository.readState();assert.equal(state.assessment.view.ofType('chorePolicy').find(op=>op.entityId===created[0]).payload.configuration.monthly,true);
});
