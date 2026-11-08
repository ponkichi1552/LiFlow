import './helpers/typescript-loader.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import {createDatabase} from './helpers/sqlite.mjs';
import {fixture,seeds,now,groupId} from './helpers/sharing-v2-repository-fixture.mjs';
import {createV2PlannerActions} from '../src/features/sharing/v2/actions.ts';
import {createV2GroupController} from '../src/features/sharing/v2/controller.ts';
import {chorePolicyFromPreset} from '../src/features/sharing/v2/model.ts';
import {listSharingOutbox} from '../src/platform/storage/sharing-ledger.ts';
import {screenHarness} from './helpers/screen-harness.mjs';
const repository = await import('../src/platform/storage/repository.ts');
import {readAdaptivePersonalInside} from '../src/platform/storage/adaptive-personal-chores.ts';

async function personal(t){t.mock.timers.enable({apis:['Date'],now:Date.parse('2026-11-08T01:00:00Z')});const h=createDatabase();t.after(()=>h.connection.close());await repository.initializeLocalDatabase(h.database);await repository.completeFirstSetup(h.database,{frequencyMode:'balanced',restDays:[6,7],enabledChoreIds:[],previousDates:{},weatherLocation:null});return h;}
async function select(s,role,label){const node=s.nodes().find(n=>n.props.accessibilityRole===role&&n.props.accessibilityLabel===label);assert.ok(node,label);node.props.onPress();await s.flush();}
test('a personal custom chore needs only its name and cycle and retains zero width normal load and independent learning defaults',async t=>{
 const h=await personal(t);const before=h.connection.prepare('SELECT COUNT(*) n FROM chore_definitions').get().n;
 for(const input of [{name:' ',intervalDays:7},{name:'broken',intervalDays:0},{name:'broken',intervalDays:1.5}])await assert.rejects(repository.addPersonalChore(h.database,input));
 assert.equal(h.connection.prepare('SELECT COUNT(*) n FROM chore_definitions').get().n,before);
 const chore=await repository.addPersonalChore(h.database,{name:'  植物に水をあげる  ',intervalDays:7});assert.equal(chore.name,'植物に水をあげる');
 assert.equal(chore.enabled,true);assert.equal(chore.load,'normal');assert.equal(chore.holidayPriority,false);assert.equal(chore.userWindowRadiusDays,0);assert.equal(chore.estimatedMinutes,15);
 const view=await readAdaptivePersonalInside(h.database,chore.id);assert.deepEqual(view.state.policy.initialDays,{frequent:7,balanced:7,relaxed:7});assert.equal(view.state.policy.fixedDays,null);
 const snapshot=await repository.loadPlannerSnapshot(h.database,'2026-11-08');assert.ok(snapshot.scheduleEntries.some(entry=>entry.choreId===chore.id));
 await repository.updateChoreSettings(h.database,chore.id,{windowRadiusDays:2,cycleDays:10,load:'heavy',holidayPriority:true,estimatedMinutes:30});
 const edited=JSON.parse(h.connection.prepare('SELECT definition_json FROM chore_definitions WHERE id=?').get(chore.id).definition_json);assert.equal(edited.userWindowRadiusDays,2);
 await repository.updateChoreSettings(h.database,chore.id,{resetSchedule:true});
 const reset=JSON.parse(h.connection.prepare('SELECT definition_json FROM chore_definitions WHERE id=?').get(chore.id).definition_json);
 assert.equal(reset.userWindowRadiusDays,0);assert.equal(reset.recommendedCycleDays,undefined);assert.equal(reset.load,'normal');assert.equal(reset.holidayPriority,false);assert.equal(reset.estimatedMinutes,30);
 assert.deepEqual(reset.personalScheduleDefaults,chore.personalScheduleDefaults);assert.equal(reset.enabled,true);
});
test('a shared custom chore atomically creates its policy using today for both dates and rejects unauthorized or incomplete registration',async t=>{
 const f=await fixture();const d=await f.device(),m=await f.device('member',f.member);t.after(()=>{d.connection.close();m.connection.close();});await d.repository.commit(seeds());let n=0;
 const a=createV2PlannerActions(d.repository,{makeId:()=>`custom-${++n}`,now});const b=createV2PlannerActions(m.repository,{makeId:()=>`member-custom-${++n}`,now});
 const before=(await listSharingOutbox(d.database,groupId)).length;
 await assert.rejects(a.addConfiguredChore('no role',7,{completion:'one',assignment:{mode:'selected',memberIds:[]}}));
 assert.equal((await listSharingOutbox(d.database,groupId)).length,before);
 await assert.rejects(b.addConfiguredChore('not admin',7,chorePolicyFromPreset('common')),/管理者/);
 const ops=await a.addConfiguredChore('テーブルを拭く',3,chorePolicyFromPreset('assigned',['owner']));assert.equal(ops.length,2);assert.equal(ops[0].entityId,ops[1].entityId);
 const state=await d.repository.readState();assert.deepEqual(state.assessment.rejected,[]);const cfg=ops[1].payload.configuration;
 assert.equal(cfg.anchorDate,'2026-10-27');assert.equal(cfg.effectiveFrom,cfg.anchorDate);assert.equal(cfg.windowBeforeDays,0);assert.equal(cfg.windowAfterDays,0);
 assert.equal(cfg.active,true);assert.equal(cfg.intervalDays,3);assert.equal(ops[0].payload.load,'normal');
 const plan=await a.readPlan({from:'2026-10-27',through:'2026-11-30',asOfDate:'2026-10-27'});
 assert.equal(plan.occurrences.find(row=>row.choreId===ops[0].entityId).assigneeIds[0],'owner');
});
for(const platform of ['ios','android']){
 test(`${platform} personal creation accepts optional settings and steps without requiring a second edit`,async t=>{
  const h=await personal(t);const navigation=[];const data={database:h.database,refresh:async()=>{},readError:()=>null};
  const s=screenHarness('src/features/chores/add-personal-chore.tsx',{exportName:'AddPersonalChoreScreen',platform,personalData:()=>data,navigate:(...args)=>navigation.push(args)});t.after(()=>s.unmount());
  await s.change('追加する家事の名前','植物のお手入れ');await s.change('追加する家事の周期','14');
  await s.change('追加する家事の期間幅','2');await s.change('追加する家事の目安時間','25');
  await s.press('重い');await select(s,'checkbox','追加する家事は休日を優先');await s.change('追加する家事の手順',' 葉を拭く\n\n 水をあげる ');
  await s.press('追加');for(let i=0;i<25;i++)await s.flush();
  assert.equal(navigation.length,1);
  const chore=JSON.parse(h.connection.prepare("SELECT definition_json FROM chore_definitions WHERE name='植物のお手入れ'").get().definition_json);
  assert.equal(chore.load,'heavy');assert.equal(chore.holidayPriority,true);assert.equal(chore.userWindowRadiusDays,2);assert.equal(chore.estimatedMinutes,25);assert.deepEqual(chore.instructions,['葉を拭く','水をあげる']);
  assert.deepEqual(chore.frequencyDaysByMode,{frequent:14,balanced:14,relaxed:14});
 });
 test(`${platform} shared creation validates optional fields before saving and retains the selected start date and responsibility`,async t=>{
  const f=await fixture();const d=await f.device();t.after(()=>d.connection.close());await d.repository.commit(seeds());let n=0;
  const controller=createV2GroupController(d.repository,{makeId:()=>`options-custom-${++n}`,now,sync:async()=>{}});const created=[];
  const model=await controller.readModel({from:'2026-10-27',through:'2026-11-30',asOfDate:'2026-10-27'},{management:true});
  const s=screenHarness('src/features/sharing/v2-ui/add-chore.tsx',{exportName:'V2AddChore',platform,props:{model,actions:controller.actions,busy:false,run:work=>work(),onCreated:id=>created.push(id),onBack(){}}});t.after(()=>s.unmount());
  await s.change('追加する家事の名前','車の掃除');await s.change('追加する家事の周期','21');await select(s,'radio','誰か1人が行う');
  await s.change('追加する家事の期間の前','1');await s.change('追加する家事の期間の後','3');await s.change('追加する家事の目安時間','0');
  await s.press('重い');assert.equal(s.nodes().some(node=>node.props.accessibilityLabel==='追加する家事は休日を優先'),false);await s.change('追加する家事の手順','道具を用意する\n掃除する');
  await s.press('開始日を開く');await s.press('開始日カレンダーの次の月');await s.press('開始日を2026/11/05にする');
  const before=(await listSharingOutbox(d.database,groupId)).length;await s.press('追加');assert.match(s.text(),/目安時間/);assert.equal((await listSharingOutbox(d.database,groupId)).length,before);
  await s.change('追加する家事の目安時間','40');await s.press('追加');for(let i=0;i<20;i++)await s.flush();assert.equal(created.length,1);
  const state=await d.repository.readState();const chore=state.assessment.view.ofType('chore').find(op=>op.entityId===created[0]).payload;
  const cfg=state.assessment.view.ofType('chorePolicy').find(op=>op.entityId===created[0]).payload.configuration;
  assert.equal(chore.load,'heavy');assert.equal(chore.holidayPriority,false);assert.equal(chore.estimatedMinutes,40);assert.deepEqual(chore.instructions,['道具を用意する','掃除する']);
  assert.equal(cfg.intervalDays,21);assert.equal(cfg.windowBeforeDays,1);assert.equal(cfg.windowAfterDays,3);assert.equal(cfg.anchorDate,'2026-11-05');assert.equal(cfg.effectiveFrom,cfg.anchorDate);assert.equal(cfg.policy.assignment.mode,'open');
 });
 test(`${platform} personal add saves same-frame input once and a failed refresh reopens the existing chore without duplicate insertion`,async t=>{
  const h=await personal(t);let fail=true;const navigation=[];const data={database:h.database,refresh:async()=>{},readError:()=>fail?'refresh failed':null};
  const s=screenHarness('src/features/chores/add-personal-chore.tsx',{exportName:'AddPersonalChoreScreen',platform,personalData:()=>data,navigate:(...args)=>navigation.push(args)});t.after(()=>s.unmount());
  const name=s.nodes().find(node=>node.type==='TextInput'&&node.props.accessibilityLabel==='追加する家事の名前');const period=s.nodes().find(node=>node.type==='TextInput'&&node.props.accessibilityLabel==='追加する家事の周期');
  name.props.onChangeText('Same frame');period.props.onChangeText('７');const button=s.button('追加');button.props.onPress();button.props.onPress();
  for(let i=0;i<25;i++)await s.flush();
  assert.match(s.text(),/端末に追加済み/);assert.equal(h.connection.prepare("SELECT COUNT(*) n FROM chore_definitions WHERE name='Same frame'").get().n,1);
  fail=false;await s.press('追加済みの家事を開く');for(let i=0;i<10;i++)await s.flush();assert.equal(navigation.length,1);
  assert.equal(navigation[0][0],'replace');assert.equal(navigation[0][1].pathname,'/settings/chore/[id]');
  assert.equal(h.connection.prepare("SELECT COUNT(*) n FROM chore_definitions WHERE name='Same frame'").get().n,1);
 });
 test(`${platform} shared add validates name cycle and responsibility before one atomic save and locks duplicate taps`,async t=>{
  const f=await fixture();const d=await f.device();t.after(()=>d.connection.close());await d.repository.commit(seeds());let n=0;const controller=createV2GroupController(d.repository,{makeId:()=>`form-custom-${++n}`,now,sync:async()=>{}});
  const model=await controller.readModel({from:'2026-10-27',through:'2026-11-30',asOfDate:'2026-10-27'},{management:true});const created=[];
  const s=screenHarness('src/features/sharing/v2-ui/add-chore.tsx',{exportName:'V2AddChore',platform,props:{model,actions:controller.actions,busy:false,run:work=>work(),onCreated:id=>created.push(id),onBack(){}}});t.after(()=>s.unmount());
  await s.change('追加する家事の名前','窓を開ける');await s.change('追加する家事の周期','7');await s.press('追加');assert.match(s.text(),/担当を選んで/);assert.equal(created.length,0);
  s.nodes().find(node=>node.props.accessibilityRole==='radio'&&node.props.accessibilityLabel==='誰か1人が行う').props.onPress();const save=s.button('追加');save.props.onPress();save.props.onPress();for(let i=0;i<20;i++)await s.flush();
  assert.equal(created.length,1);const state=await d.repository.readState();assert.equal(state.assessment.view.ofType('chore').filter(op=>op.payload.name==='窓を開ける').length,1);
  assert.equal(state.assessment.view.ofType('chorePolicy').filter(op=>op.entityId===created[0]).length,1);
 });
}
