import './helpers/typescript-loader.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { hasChoreGuide } from '../src/features/chores/guide-content.ts';
import { unifiedGuideCatalog } from '../src/features/chores/guide-catalog.ts';
import { screenHarness } from './helpers/screen-harness.mjs';

const chore=(id,extra={})=>({id,name:id,category:'追加した家事',enabled:true,description:'',instructions:[],procedureSections:[],tools:[],cautions:[],...extra});
test('schedule-only chores have no library entry while meaningful descriptions and procedure content remain eligible',()=>{
 const empty=chore('空の説明');assert.equal(hasChoreGuide(empty),false);
 assert.equal(hasChoreGuide(chore('空白',{description:' \n',instructions:[' '],procedureSections:[{title:'見出しだけ',steps:[]}]})),false);
 for(const value of [{description:'拭いて掃除します。'},{instructions:['掃除する']},{procedureSections:[{title:'準備',steps:['電源を切る']}]},{tools:['布']},{cautions:['感電に注意']},{trivia:[{body:'汚れをためない工夫'}]}])assert.equal(hasChoreGuide(chore('説明あり',value)),true);
 assert.equal(empty.enabled,true);assert.deepEqual(empty.instructions,[]);
});
test('an empty shared guide cannot hide the meaningful personal guide for the same chore',()=>{
 const shared=chore('shared',{name:'テーブルを拭く'}),personal=chore('private',{name:'テーブルを拭く',description:'やわらかい布で拭きます。'});
 const before=structuredClone({shared,personal});assert.deepEqual(unifiedGuideCatalog([shared],[personal]).map(row=>row.id),['personal:private']);
 assert.deepEqual({shared,personal},before);
 assert.deepEqual(unifiedGuideCatalog([{...shared,instructions:['布で拭く']}],[personal]).map(row=>row.id),['shared:shared']);
});
for(const platform of ['ios','android'])test(`${platform} the added-chore library omits empty guides and reveals newly supplied steps without changing schedule settings`,async t=>{
 const rows=[chore('予定だけ'),chore('手順あり',{instructions:['水をあげる']})],before=structuredClone(rows);const opened=[];
 const props={chores:rows,onOpen:id=>opened.push(id)};const s=screenHarness('src/features/chores/chore-library.tsx',{exportName:'ChoreLibrary',platform,props});t.after(()=>s.unmount());
 await s.press('追加した家事、1件');assert.equal(s.text().includes('予定だけ'),false);await s.press('手順ありの説明を開く');assert.deepEqual(opened,['手順あり']);assert.deepEqual(rows,before);
 props.chores=[{...rows[0],instructions:['登録後の手順']},rows[1]];s.render();assert.ok(s.nodes().some(n=>n.props.accessibilityLabel==='予定だけの説明を開く'));assert.deepEqual(rows,before);
});
