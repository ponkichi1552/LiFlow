import './helpers/typescript-loader.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { fixture, seeds, now, groupId, draft } from './helpers/sharing-v2-repository-fixture.mjs';
import { createV2GroupController } from '../src/features/sharing/v2/controller.ts';
import { createV2ScreenSession } from '../src/features/sharing/v2-ui/screen-session.ts';
import { screenHarness } from './helpers/screen-harness.mjs';
const range = { from: '2026-10-27', through: '2026-10-27', asOfDate: '2026-10-27' };
for(const platform of ['ios','android'])test(`${platform} a newly created selected chapter never falls back to another chore while the saved catalog is refreshing`,async t=>{
 const old={id:'old',name:'別の家事',category:'追加した家事'},added={id:'new',name:'新しく追加した家事',category:'追加した家事'};
 const props={chores:[old],selectedId:'new',title:'家事ごとの設定',renderChore:chore=>chore.name,onBack(){}};
 const screen=screenHarness('src/components/chore-book.tsx',{exportName:'ChoreBook',platform,props,effect:callback=>callback(),layoutEffect:callback=>callback()});t.after(()=>screen.unmount());
 assert.equal(screen.text().includes(old.name),false);assert.deepEqual(screen.nodes().find(n=>n.type==='FlatList').props.data,[]);
 props.chores=[old,added];screen.render();await screen.flush();
 assert.equal(screen.nodes().find(n=>n.type==='FlatList').props.data[0].id,'new');assert.ok(screen.text().includes(added.name));assert.equal(screen.text().includes(old.name),false);
});
for (const platform of ['ios', 'android']) test(`${platform} shared settings can return immediately while loading without flashing a separate synchronization panel`, async () => {
  let focus; let backs = 0;
  const screen = screenHarness('src/features/sharing/v2-ui/group-screen.tsx', { exportName: 'V2GroupScreen', platform,
    props: { purpose: 'workspace', view: 'configuration', loadSession: () => new Promise(() => {}), onBack: () => backs++, onConfiguration() {}, onHistory() {} },
    focusEffect: callback => { focus = callback; } });
  const leave = focus(); await screen.flush();
  assert.ok(screen.text().includes('家事ごとの設定'));
  assert.equal(screen.text().includes('端末に保存した変更は、接続後に共有します。'), false);
  await screen.press('前の画面に戻る'); assert.equal(backs, 1);
  leave(); screen.unmount();
});
for (const platform of ['ios', 'android']) test(`${platform} shared settings use one fixed-audience document and retain invalid cadence input after virtual chapters unmount`, async t => {
  const f = await fixture(); const d = await f.device(); t.after(() => d.connection.close());
  const initial = seeds(); initial[2].payload.category = '水回り';
  await d.repository.commit([...initial, draft('add-a', 'chore', 'zz-extra-a', { name: '別の家事A', category: '水回り', enabled: false }), draft('add-b', 'chore', 'zz-extra-b', { name: '別の家事B', category: '屋外', enabled: false })]);
  let id = 0; const controller = createV2GroupController(d.repository, { makeId: () => `book-${++id}`, now, sync: async () => {} });
  const session = createV2ScreenSession({ controller, groupId, userId: 'owner', now, readPreferences: () => { throw new Error('private preferences must not open'); } });
  const effects = []; let backs = 0;
  const props = { model: await session.readModel({ management: true, choreSettings: true }), session, choreId: 'floor', groupName: '家族', onBack: () => backs++,
    onSaved: async () => { props.model = await session.readModel({ management: true, choreSettings: true }); } };
  const screen = screenHarness('src/features/sharing/v2-ui/chore-settings-book.tsx', { exportName: 'V2ChoreSettingsBook', platform, props,
    flatListItemHeight: 1000, effect: callback => effects.push(callback), layoutEffect: callback => callback() });
  const load = async () => { for (const effect of effects.splice(0)) effect(); for (let i = 0; i < 8; i++) await screen.flush(); };
  await load(); assert.equal(screen.text().split('グループ用').length - 1, 1);
  assert.equal(screen.text().includes('周期・担当の設定へ'), false); assert.equal(screen.text().includes('日時変更の権限へ'), false);
  await screen.change('共有家事の周期', 'invalid'); await screen.endEditing('共有家事の周期');
  const scroll = offset => { screen.nodes().find(node => node.type === 'FlatList').props.onScroll({ nativeEvent: { contentOffset: { x: 0, y: offset } } }); screen.render(); };
  scroll(3000); await load(); assert.equal(screen.nodes().some(node => node.type === 'TextInput' && node.props.accessibilityLabel === '共有家事の周期'), false);
  scroll(0); await load(); const field = screen.nodes().find(node => node.type === 'TextInput' && node.props.accessibilityLabel === '共有家事の周期');
  assert.equal(field.props.value, 'invalid'); await screen.press('前の画面に戻る'); assert.equal(backs, 1);
  assert.equal((await controller.readModel(range)).configurations.find(row => row.choreId === 'floor').configuration.intervalDays, 7);
  assert.equal(field.props.value, 'invalid');
  await screen.flush();
  assert.equal(screen.nodes().find(node => node.type === 'TextInput' && node.props.accessibilityLabel === '共有家事の周期').props.value, '7');
  for (const effect of effects.splice(0)) effect();

});

test('connected shared settings read one authenticated snapshot and scrolling never rebuilds the same repository state for each chapter', async t => {
  const f = await fixture(); const d = await f.device(); t.after(() => d.connection.close());
  await d.repository.commit([...seeds(), ...Array.from({ length: 30 }, (_, index) => draft(`extra-${index}`, 'chore', `extra-${index}`, { name: `家事${index}`, enabled: false }))]);
  let reads = 0; const repository = { ...d.repository, readState: async () => { reads++; return d.repository.readState(); } };
  const controller = createV2GroupController(repository, { makeId: () => 'unused', now, sync: async () => {} });
  const session = createV2ScreenSession({ controller, groupId, userId: 'owner', now, readPreferences: () => { throw new Error('private read'); } });
  const model = await session.readModel({ management: true, choreSettings: true });
  assert.equal(reads, 1); assert.equal(model.choreDetails.length, 31); assert.equal(model.choreDateRights.length, 31);
  const effects = []; const screen = screenHarness('src/features/sharing/v2-ui/chore-settings-book.tsx', { exportName: 'V2ChoreSettingsBook',
    props: { model, session, choreId: 'floor', groupName: '家族', onBack() {}, onSaved: async () => {} }, flatListItemHeight: 1000,
    effect: callback => effects.push(callback), layoutEffect: callback => callback() });
  for (const offset of [0, 4000, 16000, 29000, 0]) {
    screen.nodes().find(node => node.type === 'FlatList').props.onScroll({ nativeEvent: { contentOffset: { x: 0, y: offset } } }); screen.render();
    for (const effect of effects.splice(0)) effect(); await screen.flush();
  }
  assert.equal(reads, 1, 'mounting and scrolling chapters must use the captured model');
  const single = await controller.readModel(range, { detailChoreId: 'floor', permissionsChoreId: 'floor' });
  assert.deepEqual(model.choreDetails.find(row => row.choreId === 'floor'), single.choreDetails[0]);
  assert.deepEqual(model.choreDateRights.find(row => row.choreId === 'floor'), single.dateRights);
  await assert.rejects(session.readModel({ choreSettings: true }), /編集画面/u);
});

for (const platform of ['ios', 'android']) test(`${platform} an unfinished initial shared configuration can be explicitly reset before leaving without enabling the chore or writing an operation`, async t => {
  const f = await fixture(); const d = await f.device(); t.after(() => d.connection.close());
  await d.repository.commit(seeds().filter(row => row.operationId !== 'configuration'));
  const controller = createV2GroupController(d.repository, { makeId: () => 'must-not-write', now, sync: async () => {} });
  const session = createV2ScreenSession({ controller, groupId, userId: 'owner', now, readPreferences: () => { throw new Error('private read'); } });
  const model = await session.readModel({ management: true, choreSettings: true }); const before = d.state(); let backs = 0;
  const screen = screenHarness('src/features/sharing/v2-ui/chore-settings-book.tsx', { exportName: 'V2ChoreSettingsBook', platform,
    props: { model, session, choreId: 'floor', groupName: '家族', onBack: () => backs++, onSaved: async () => {} }, layoutEffect: callback => callback() });
  await screen.change('初回の周期', '12');
  await screen.press('入力を戻す');
  assert.equal(screen.nodes().find(node => node.type === 'TextInput' && node.props.accessibilityLabel === '初回の周期').props.value, '');
  await screen.press('前の画面に戻る'); assert.equal(backs, 1);
  assert.deepEqual(d.state(), before); assert.equal((await controller.readModel(range)).configurations[0].configuration, null);
});

for (const platform of ['ios', 'android']) test(`${platform} shared settings open one advanced page and discard invalid edits on departure`, async t => {
  const f = await fixture(); const d = await f.device(); t.after(() => d.connection.close()); await d.repository.commit(seeds());
  let id = 0; const controller = createV2GroupController(d.repository, { makeId: () => `advanced-${++id}`, now, sync: async () => {} });
  const session = createV2ScreenSession({ controller, groupId, userId: 'owner', now, readPreferences: () => { throw new Error('private read'); } });
  let backs = 0; const effects = [], navigation = [];
  const props = { model: await session.readModel({ management: true, choreSettings: true }), session, choreId: 'floor', groupName: '家族', onBack: () => backs++,
    onSaved: async () => { props.model = await session.readModel({ management: true, choreSettings: true }); } };
  let screen = screenHarness('src/features/sharing/v2-ui/chore-settings-book.tsx', { exportName: 'V2ChoreSettingsBook', props, platform,
    navigate: (...args) => navigation.push(args), effect: callback => effects.push(callback), layoutEffect: callback => callback() });
  const settle = async () => { for (const effect of effects.splice(0)) effect(); for (let i = 0; i < 8; i++) await screen.flush(); };
  await settle(); await screen.press('詳細設定を開く'); await settle();
  assert.equal(navigation[0][1].pathname, '/group-v2/chore-options'); assert.equal(navigation[0][1].params.choreId, 'floor'); screen.unmount();
  const advancedProps={model:props.model,controller,choreId:'floor',onBack:()=>backs++,onSaved:async()=>{advancedProps.model=await session.readModel({management:true,choreSettings:true});}};
  screen=screenHarness('src/features/sharing/v2-ui/chore-advanced-settings.tsx',{exportName:'V2ChoreAdvancedSettings',platform,props:advancedProps,effect:callback=>effects.push(callback),layoutEffect:callback=>callback()});
  await settle(); assert.ok(screen.nodes().some(node=>node.type==='TextInput'&&node.props.accessibilityLabel==='共有家事の名前'));
  assert.ok(screen.nodes().some(node=>node.type==='TextInput'&&node.props.accessibilityLabel==='区分がないときの手順（1行に1手順）'));
  await screen.change('共有家事の名前','');await screen.press('前の画面に戻る');assert.equal(backs,1);
  assert.equal(screen.nodes().find(node=>node.type==='TextInput'&&node.props.accessibilityLabel==='共有家事の名前').props.value,advancedProps.model.plan.chores.find(row=>row.id==='floor').name);
  assert.equal((await controller.readModel(range)).plan.chores.find(row=>row.id==='floor').name,advancedProps.model.plan.chores.find(row=>row.id==='floor').name);
  screen.unmount();
  screen=screenHarness('src/features/sharing/v2-ui/chore-advanced-settings.tsx',{exportName:'V2ChoreAdvancedSettings',platform,props:advancedProps,effect:callback=>effects.push(callback),layoutEffect:callback=>callback()});
  await settle(); await screen.change('共有家事の名前','新しい家事名'); await screen.press('前の画面に戻る'); assert.equal(backs,2); await settle();
  assert.equal((await session.readModel({management:true,choreSettings:true})).choreDetails.find(row=>row.choreId==='floor').fields.name.value,'新しい家事名'); screen.unmount();
});

test('a rotating chore offers its current assignment from advanced settings and keeps navigation inside the chosen workspace',async t=>{
 const f=await fixture();const d=await f.device();t.after(()=>d.connection.close());await d.repository.commit(seeds());let n=0;
 const controller=createV2GroupController(d.repository,{makeId:()=>`rotation-book-${++n}`,now,sync:async()=>{}});
 const {chorePolicyFromPreset}=await import('../src/features/sharing/v2/model.ts');await controller.actions.patchChoreConfiguration('floor',1,{policy:chorePolicyFromPreset('rotation',['owner','member'])},'2026-10-27');
 const session=createV2ScreenSession({controller,groupId,userId:'owner',now,readPreferences:()=>{throw new Error('No private calendar needed');}});
 const model=await session.readModel({management:true,choreSettings:true});const navigation=[];
 const screen=screenHarness('src/features/sharing/v2-ui/chore-advanced-settings.tsx',{exportName:'V2ChoreAdvancedSettings',navigate:(...args)=>navigation.push(args),effect:callback=>callback(),effectDependencies:true,layoutEffect:callback=>callback(),props:{model,controller,choreId:'floor',onSaved:async()=>{},onBack(){}}});t.after(()=>screen.unmount());
 for(let i=0;i<8;i++)await screen.flush();await screen.press('今回の担当を変更');for(let i=0;i<8;i++)await screen.flush();
 assert.equal(navigation.length,1);assert.equal(navigation[0][1].pathname,'/group-v2/assignment');assert.equal(navigation[0][1].params.anchorDate,'2026-10-27');
});
