import './helpers/typescript-loader.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { screenHarness } from './helpers/screen-harness.mjs';
import { createDatabase } from './helpers/sqlite.mjs';
import { fixture, seeds, draft, now, groupId } from './helpers/sharing-v2-repository-fixture.mjs';
import { createV2GroupController } from '../src/features/sharing/v2/controller.ts';
import { standardSharedChores } from '../src/features/sharing/v2/standard-catalog.ts';
import { chorePolicyFromPreset } from '../src/features/sharing/v2/model.ts';
import { listSharingOutbox } from '../src/platform/storage/sharing-ledger.ts';
import { readAdaptivePersonalInside } from '../src/platform/storage/adaptive-personal-chores.ts';
import { newEventDraft } from '../src/features/calendar/events.ts';
const repository = await import('../src/platform/storage/repository.ts');
const { readLocalCalendar } = await import('../src/platform/storage/calendar-events.ts');
const flush = async ui => { for (let i=0;i<20;i++) await ui.flush(); };

// Assemble the same public render slot as PlannerCalendar, with both real registration components.
function harness(props, platform, data, datePicker, alert) {
  return screenHarness('src/features/calendar/calendar-editor.tsx', { exportName:'CalendarSwitchTest', platform, personalData:()=>data, datePicker, alert,
    ...(alert ? { effectDependencies: true, layoutEffect: effect => effect() } : {}),
    transformSource:(path, source)=>path.endsWith('/calendar/calendar-editor.tsx') ? source+`
      import { V2CalendarChoreRegistration as TestSharedRegistration } from '../sharing/v2-ui/calendar-chore-registration';
      import { PersonalCalendarChoreRegistration as TestPersonalRegistration } from './personal-chore-registration';
      export function CalendarSwitchTest(props) { return <CalendarEditor {...props} renderChoreRegistration={sheet => sheet.audience === 'group'
        ? <TestSharedRegistration {...sheet} local={props.local} model={props.model} actions={props.actions} busy={false} run={work=>work()} />
        : <TestPersonalRegistration {...sheet} local={props.local} />} />; }
    ` : source, props });
}
async function setup(t) {
  t.mock.timers.enable({apis:['Date'],now:Date.parse('2026-10-27T01:00:00Z')});
  const p=createDatabase();t.after(()=>p.connection.close());await repository.initializeLocalDatabase(p.database);
  await repository.completeFirstSetup(p.database,{frequencyMode:'balanced',restDays:[1,2,3,4,5,6,7],enabledChoreIds:[],previousDates:{},weatherLocation:null});
  const snapshot=await repository.loadPlannerSnapshot(p.database);
  const f=await fixture();const d=await f.device();t.after(()=>d.connection.close());await d.repository.commit(seeds());
  let id=0;const controller=createV2GroupController(d.repository,{now,makeId:()=>`switch-${++id}`,sync:async()=>{}});
  const readModel=()=>controller.readModel({from:'2026-10-27',through:'2026-11-30',asOfDate:'2026-10-27'},{management:true});
  const model=await readModel();const local={database:p.database,snapshot:await readLocalCalendar(p.database),loading:false,error:null,refresh:async()=>{},shared:{enabled:true,groupId,name:'検査'}};
  return {p,d,controller,model,readModel,local,data:{database:p.database,snapshot,refresh:async()=>{}}};
}
async function pick(ui,platform,getPicker,label,day,clock) {
  await ui.press(`${label}を選択`);const date=new Date(`${day}T${clock??'12:00'}:00Z`);
  if(platform==='ios'){ui.nodes().find(n=>n.type==='DateTimePicker').props.onValueChange({type:'set'},date);await ui.flush();await ui.press(`${label}の選択を完了`);}
  else {getPicker().onValueChange({type:'set'},date);await ui.flush();}
}
function field(ui,label){const node=ui.nodes().find(n=>n.type==='TextInput'&&n.props.accessibilityLabel===label);assert.ok(node,`missing ${label}`);return node.props.value??node.props.defaultValue;}
function check(ui,label,value){const node=ui.nodes().find(n=>n.props.accessibilityLabel===label&&n.props.onPress);assert.ok(node,`missing ${label}`);assert.equal(node.props.accessibilityState?.checked,value);}
async function flag(ui,label){const node=ui.nodes().find(n=>n.props.accessibilityLabel===label&&n.props.onPress);assert.ok(node);node.props.onPress();await ui.flush();}
for(const platform of ['ios','android']) {
  test(`${platform} closing personal or shared chore entry protects entered fields without creating a draft`, async t => {
    const h = await setup(t);
    const outbox = (await listSharingOutbox(h.d.database, groupId)).length;
    let closed = 0;
    const alerts = [];
    const open = () => harness({ local: h.local, model: h.model, actions: h.controller.actions,
      initial: { eventId: null, anchorDate: null, revision: 0, exceptionRevision: 0, scope: 'series', value: newEventDraft('2026-11-05', 'Asia/Tokyo') },
      onClose() { closed++; }, onSaved() { assert.fail('closing cannot save a chore'); } }, platform, h.data, undefined, (...args) => alerts.push(args));
    const clean = open(); t.after(() => clean.unmount());
    await clean.press('家事を追加'); await clean.press('新しい家事を作る');
    await clean.press('予定の編集を閉じる');
    assert.equal(closed, 1);
    assert.equal(alerts.length, 0);
    clean.unmount();
    for (const destination of ['個人', 'グループ共通']) {
      const ui = open(); t.after(() => ui.unmount());
      if (destination === 'グループ共通') await ui.press(destination);
      await ui.press('家事を追加'); await ui.press('新しい家事を作る');
      await ui.change('家事名', '確認中の家事');
      await ui.press('家事の詳細設定'); await flag(ui, '追加する家事を繰り返す');
      await ui.change('追加する家事の周期', '12');
      await ui.press('予定の編集を閉じる');
      const [title, , buttons] = alerts.at(-1);
      assert.equal(title, '家事の入力を破棄しますか？');
      assert.deepEqual(buttons.map(item => item.text), ['入力を続ける', '破棄']);
      buttons[0].onPress(); await ui.flush();
      assert.equal(ui.button('予定を保存').props.disabled, false);
      // Native text is uncontrolled while typing; remount the source to read the retained value.
      await ui.press(destination === '個人' ? 'グループ共通' : '個人');
      assert.equal(field(ui, '家事名'), '確認中の家事');
      assert.equal(field(ui, '追加する家事の周期'), '12');
      const modal = ui.nodes().find(node => node.type === 'Modal');
      assert.equal(modal.props.allowSwipeDismissal, false);
      modal.props.onRequestClose(); await ui.flush();
      assert.equal(alerts.at(-1)[0], title);
      alerts.at(-1)[2][1].onPress(); await ui.flush();
      ui.unmount();
    }
    assert.equal(closed, 3);
    assert.equal(alerts.length, 4);
    assert.equal((await readLocalCalendar(h.p.database)).drafts.length, 0);
    assert.equal((await listSharingOutbox(h.d.database, groupId)).length, outbox);
    assert.equal(h.p.connection.prepare('SELECT count(*) AS count FROM chore_definitions WHERE name = ?').get('確認中の家事').count, 0);
  });

  test(`${platform} deselecting a chore clears the same editor's saved shared draft before closing an empty personal form`, async t => {
    const h = await setup(t);
    let local;
    const host = screenHarness('tests/helpers/calendar-source-host.tsx', { platform, exportName: 'CalendarSourceHost',
      props: { model: h.model, actions: h.controller.actions, local: h.local, capture: value => { local = value; } } });
    t.after(() => host.unmount());
    const read = () => readLocalCalendar(h.p.database, local.shared.notificationScope);
    for (const newer of [false, true]) {
      let closed = 0;
      const ui = harness({ local, model: h.model, actions: h.controller.actions,
        initial: { eventId: null, anchorDate: null, revision: 0, exceptionRevision: 0, scope: 'series', value: newEventDraft('2026-11-05', 'Asia/Tokyo') },
        onClose() { closed++; }, onSaved() {} }, platform, h.data); t.after(() => ui.unmount());
      await ui.press('グループ共通'); await ui.change('予定名', '同じ入力の古い共有下書き');
      await ui.press('家事を追加'); await ui.press('新しい家事を作る');
      const saved = (await read()).drafts; assert.equal(saved.length, 1); assert.ok(saved[0].editorCategory);
      if (newer) await local.persistDraft({ ...saved[0], value: { ...saved[0].value, notes: '別画面の更新' } });
      await ui.press('家事の選択を解除'); await flush(ui); await ui.press('個人');
      await ui.press('予定の編集を閉じる'); await flush(ui);
      assert.equal(closed, 1); assert.deepEqual((await read()).drafts.map(row => row.value.notes), newer ? ['別画面の更新'] : []);
      ui.unmount();
    }
    assert.equal((await readLocalCalendar(h.p.database)).events.length, 0);
  });
  for(const destination of ['personal','group']) test(`${platform} calendar chore destination switching retains input and writes only the final destination ${destination}`,async t=>{
    const h=await setup(t);let picker;const saved=[];
    const ui=harness({local:h.local,model:h.model,actions:h.controller.actions,initial:{eventId:null,anchorDate:null,revision:0,exceptionRevision:0,scope:'series',value:newEventDraft('2026-11-05','Asia/Tokyo')},onClose(){},onSaved:day=>saved.push(day)},platform,h.data,p=>{picker=p;});t.after(()=>ui.unmount());
    const before=(await listSharingOutbox(h.d.database,groupId)).length;
    await ui.press('家事を追加');await ui.press('新しい家事を作る');await ui.change('家事名','切替で残す家事');await ui.press('家事の詳細設定');await flag(ui,'追加する家事を繰り返す');
    await ui.change('追加する家事の周期','10');await ui.change('追加する家事の目安時間','25');await ui.change('追加する家事の手順','一行目\n二行目');
    await pick(ui,platform,()=>picker,'開始日','2026-11-06');await pick(ui,platform,()=>picker,'終了日','2026-11-07');await pick(ui,platform,()=>picker,'開始','2026-11-06','19:00');await pick(ui,platform,()=>picker,'終了','2026-11-07','20:00');
    const verify=()=>{assert.equal(field(ui,'家事名'),'切替で残す家事');assert.equal(field(ui,'追加する家事の周期'),'10');assert.equal(field(ui,'追加する家事の目安時間'),'25');assert.equal(field(ui,'追加する家事の手順'),'一行目\n二行目');
      assert.equal(ui.button('開始日を選択').props.accessibilityValue.text,'2026/11/06');assert.equal(ui.button('終了日を選択').props.accessibilityValue.text,'2026/11/07');assert.equal(ui.button('開始を選択').props.accessibilityValue.text,'19:00');assert.equal(ui.button('終了を選択').props.accessibilityValue.text,'20:00');check(ui,'追加する家事を繰り返す',true);};
    await ui.press('グループ共通');verify();let each=ui.nodes().find(n=>n.props.accessibilityLabel==='メンバーごとに行う'&&n.props.onPress);assert.ok(each);each.props.onPress();await ui.flush();
    await ui.press('個人');verify();await ui.press('グループ共通');verify();each=ui.nodes().find(n=>n.props.accessibilityLabel==='メンバーごとに行う');assert.equal(each.props.accessibilityState.checked,true);
    if(destination==='personal'){await ui.press('個人');verify();}
    assert.equal(ui.nodes().filter(n=>n.type==='Modal').length,1);assert.equal(h.p.connection.prepare("SELECT COUNT(*) n FROM chore_definitions WHERE name='切替で残す家事'").get().n,0);assert.equal((await listSharingOutbox(h.d.database,groupId)).length,before);
    await ui.press('予定を保存');await flush(ui);assert.deepEqual(saved,['2026-11-06']);
    const shared=(await h.d.repository.readState()).assessment.view;
    const created=shared.ofType('chore').find(op=>op.payload.name==='切替で残す家事');const personal=h.p.connection.prepare("SELECT id FROM chore_definitions WHERE name='切替で残す家事'").get();
    if(destination==='group'){assert.ok(created);assert.equal(personal,undefined);assert.equal(shared.ofType('chorePolicy').find(op=>op.entityId===created.entityId).payload.configuration.intervalDays,10);assert.equal(shared.ofType('chorePolicy').find(op=>op.entityId===created.entityId).payload.configuration.policy.completion,'perMember');}
    else {assert.ok(personal);assert.equal(created,undefined);const selected=await readAdaptivePersonalInside(h.p.database,personal.id);assert.equal(selected.state.model.days,10);assert.equal((await listSharingOutbox(h.d.database,groupId)).length,before);}
    assert.equal((await readLocalCalendar(h.p.database)).events.length,0);assert.equal(shared.ofType('calendarEvent').length,0);
  });
  test(`${platform} an existing recipe keeps its destination identity and clears explicitly after a round trip`,async t=>{
    const h=await setup(t);const personal=h.data.snapshot.chores.find(c=>c.personalRecipeId&&!c.requiresCycleSelection&&c.personalSchedulingKind!=='seasonal');assert.ok(personal);
    const bundled=standardSharedChores(groupId).find(c=>c.id===`${groupId}.${personal.personalRecipeId}`);assert.ok(bundled);await h.d.repository.commit([draft('recipe','chore',bundled.id,bundled.payload)]);
    await h.controller.actions.configureChore(bundled.id,{policy:chorePolicyFromPreset('common'),anchorDate:'2026-10-27',effectiveFrom:'2026-10-27',intervalDays:7,active:true,windowBeforeDays:0,windowAfterDays:0},{expectedRuleVersion:0});
    h.model=await h.readModel();const before=(await listSharingOutbox(h.d.database,groupId)).length;
    const ui=harness({local:h.local,model:h.model,actions:h.controller.actions,initial:{eventId:null,anchorDate:null,revision:0,exceptionRevision:0,scope:'series',value:newEventDraft('2026-11-05','Asia/Tokyo')},onClose(){},onSaved(){}},platform,h.data);t.after(()=>ui.unmount());
    await ui.press('家事を追加');await ui.change('追加する既存の家事を検索',personal.name);await ui.press(`${personal.name}を選択`);
    await ui.press('グループ共通');assert.equal(ui.button('追加する家事を選び直す').props.accessibilityValue.text,personal.name);assert.equal(ui.button('開始を選択').props.accessibilityValue.text,'未指定');
    await ui.press('個人');assert.equal(ui.button('追加する家事を選び直す').props.accessibilityValue.text,personal.name);await ui.press('グループ共通');
    await ui.press('家事の選択を解除');assert.equal(field(ui,'予定名'),'');assert.ok(ui.button('家事を追加'));assert.equal((await listSharingOutbox(h.d.database,groupId)).length,before);
  });
}
