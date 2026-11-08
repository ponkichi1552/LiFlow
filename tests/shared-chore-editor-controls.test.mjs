import './helpers/typescript-loader.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import {fixture,seeds,now,groupId} from './helpers/sharing-v2-repository-fixture.mjs';
import {createV2GroupController} from '../src/features/sharing/v2/controller.ts';
import {screenHarness} from './helpers/screen-harness.mjs';
import {listSharingOutbox} from '../src/platform/storage/sharing-ledger.ts';

const range={from:'2026-10-27',through:'2026-12-31',asOfDate:'2026-10-27'};
async function editor(t,platform){
 const f=await fixture();const d=await f.device();t.after(()=>d.connection.close());await d.repository.commit(seeds());let n=0;
 const controller=createV2GroupController(d.repository,{makeId:()=>`editor-controls-${++n}`,now,sync:async()=>{}});
 let screen;const props={model:await controller.readModel(range,{management:true}),choreId:'floor',controller,onSaved:async()=>{props.model=await controller.readModel(range,{management:true});}};
 screen=screenHarness('src/features/sharing/v2-ui/configuration-editor.tsx',{exportName:'V2ConfigurationEditor',platform,props,effectDependencies:true,effect:callback=>callback()});
 t.after(()=>screen.unmount());const settle=async()=>{for(let i=0;i<15;i++)await screen.flush();};
 const policy=async()=> (await controller.readModel(range,{management:true})).configurations[0].configuration;
 return{f,d,controller,screen,props,settle,policy};
}
function choice(screen,label){const node=screen.nodes().find(n=>n.props.accessibilityRole==='radio'&&n.props.accessibilityLabel===label);assert.ok(node,label);return node;}
function check(screen,label){const node=screen.nodes().find(n=>n.props.accessibilityRole==='checkbox'&&n.props.accessibilityLabel===label);assert.ok(node,label);return node;}
for(const platform of ['ios','android']){
 test(`${platform} configured shared responsibility refuses empty assignees and retains two same-frame member selections`,async t=>{
  const e=await editor(t,platform);const before=(await listSharingOutbox(e.d.database,groupId)).length;
  choice(e.screen,'担当者を決める').props.onPress();await e.settle();
  assert.match(e.screen.text(),/担当者を選んで/);assert.equal((await listSharingOutbox(e.d.database,groupId)).length,before);
  assert.equal((await e.policy()).policy.assignment.mode,'open');
  const members=e.screen.nodes().filter(n=>n.props.accessibilityRole==='checkbox'&&n.props.accessibilityLabel?.startsWith('担当：'));
  assert.equal(members.length,2);members[0].props.onPress();members[1].props.onPress();await e.settle();
  assert.deepEqual((await e.policy()).policy.assignment,{mode:'selected',memberIds:['member','owner']});
  choice(e.screen,'メンバーごとに行う').props.onPress();await e.settle();
  assert.deepEqual((await e.policy()).targetMemberIds,['member','owner']);assert.equal((await e.policy()).policy.completion,'perMember');
 });
 test(`${platform} shared inline date selection uses one start date and applies a future date automatically`,async t=>{
  const e=await editor(t,platform);
  await e.screen.press('開始日を開く');await e.screen.press('開始日カレンダーの次の月');
  await e.screen.press('開始日を2026/11/05にする');await e.settle();
  const saved=await e.policy();assert.equal(saved.anchorDate,'2026-11-05');assert.equal(saved.effectiveFrom,'2026-11-05');
  assert.equal(e.screen.nodes().some(n=>n.type==='TextInput'&&n.props.accessibilityLabel==='共有家事の基準日'),false);
  assert.equal(e.screen.nodes().some(n=>n.props.accessibilityLabel==='設定の適用開始日を選択'),false);
 });
}
for(const platform of ['ios','android']){
 test(`${platform} rotating responsibility defaults to completion and preserves a weighted sequence while advanced timing remains optional`,async t=>{
  const e=await editor(t,platform);choice(e.screen,'交代で行う').props.onPress();await e.settle();
  const initial=(await e.policy()).policy.assignment.rotation;assert.equal(initial.advanceOn,'completion');assert.equal(initial.sequence.length,2);
  e.props.advancedOnly=true;e.screen.render();await e.settle();await e.screen.press('順番を追加');await e.settle();
  await e.screen.press('交代の3番目を上へ');await e.settle();
  let saved=(await e.policy()).policy.assignment.rotation;assert.deepEqual(saved.sequence,[initial.sequence[0],initial.sequence[0],initial.sequence[1]]);
  choice(e.screen,'予定ごとに交代').props.onPress();await e.settle();saved=(await e.policy()).policy.assignment.rotation;assert.equal(saved.advanceOn,'occurrence');
  const outbox=(await listSharingOutbox(e.d.database,groupId)).length;
  await e.screen.press('交代の3番目を削除');await e.settle();assert.match(e.screen.text(),/交代するメンバーを2人以上/);
  assert.equal((await listSharingOutbox(e.d.database,groupId)).length,outbox);
  assert.deepEqual((await e.policy()).policy.assignment.rotation.sequence,[initial.sequence[0],initial.sequence[0],initial.sequence[1]]);
  await e.screen.press('入力を最新の設定に戻す');await e.settle();
  e.props.advancedOnly=false;e.screen.render();await e.settle();
  choice(e.screen,'誰か1人が行う').props.onPress();await e.settle();assert.equal((await e.policy()).policy.assignment.rotation,undefined);
 });
}
