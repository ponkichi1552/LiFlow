import './helpers/typescript-loader.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fixture, date } from './helpers/sharing-v2-plan-fixture.mjs';
import { loadNativeModule } from './helpers/native-module.mjs';
const filename='src/features/sharing/v2/common-plan.ts'; const source=new URL(`../${filename}`,import.meta.url);
async function loaded(overrides){const mocks={};for(const [,path]of readFileSync(source,'utf8').matchAll(/from ['"]([^'"]+)['"]/gu))if(path.startsWith('.'))mocks[path]=await import(new URL(path.endsWith(".ts") ? path : `${path}.ts`,source));for(const[path,value]of Object.entries(overrides))mocks[path]={...mocks[path],...value};return loadNativeModule(filename,mocks);}
test('audit100 common planning sends only the current chores rules to per-round selection',async()=>{
 const f=await fixture();for(let n=0;n<10;n++){const id=`extra-${n}`;f.make('chore',{name:id,enabled:true,load:'normal'},{entityId:id});f.make('chorePolicy',{configuration:f.defaultConfiguration},{entityId:id});}
 for(let n=0;n<10;n++)f.designation(date('2026-10-28'));
 const actual=await import('../src/features/sharing/v2/period-rules.ts');let visited=0;
 const module=await loaded({'./period-rules.ts':{selectManualRule:(facts,...args)=>{visited+=facts.length;return actual.selectManualRule(facts,...args);}}});
 const state=f.state();const range={from:'2026-10-27',through:'2026-11-24',asOfDate:'2026-10-27'};
 const result=module.buildV2CommonPlan(state,range);assert.equal(result.chores.length,11);
 assert.deepEqual(result,f.plan());assert.ok(visited<=60,`per-round rule inputs: ${visited}`);
});

test('audit100 dependency planning reuses an identical causal frame only within its immutable common projection',async()=>{
 const f=await fixture({cycle:1,before:0,after:0});f.make('chore',{name:'prepare',enabled:true,load:'light'},{entityId:'prepare'});
 f.make('chorePolicy',{configuration:f.defaultConfiguration},{entityId:'prepare'});f.make('dependency',{predecessorChoreId:'prepare',successorChoreId:'floor',policyData:{required:true}},{entityId:'order'});
 const actual=await import('../src/features/sharing/v2/authority-context.ts');let calls=0;
 const module=await loaded({'./authority-context.ts':{frameAtOperation:(...args)=>{calls++;return actual.frameAtOperation(...args);}}});
 const state=f.state();const range={from:'2026-10-27',through:'2026-11-05',asOfDate:'2026-10-27'};const result=module.buildV2CommonPlan(state,range);
 assert.equal(result.occurrences.length,20);assert.deepEqual(result,f.plan(range));assert.ok(calls<=20,`reconstructed causal frames: ${calls}`);
});
